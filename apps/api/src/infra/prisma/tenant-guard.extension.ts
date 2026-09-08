/**
 * Garde d'isolation multi-tenant, implemente comme extension du client Prisma.
 *
 * C'est la piece maitresse de la regle « une boutique ne voit jamais les
 * donnees d'une autre » (V1 §29, V2 §5, prompt produit §8).
 *
 * FONCTIONNEMENT
 *   Toute operation sur un modele scope tenant est interceptee :
 *     - lecture   : `where.tenantId` est force au tenant courant ;
 *     - creation  : `data.tenantId` est force au tenant courant ;
 *     - mise a jour / suppression : `where.tenantId` est force ;
 *     - agregation / comptage : `where.tenantId` est force.
 *
 * FAIL-CLOSED
 *   Si aucun tenant n'est actif et qu'aucune raison de sortie de perimetre
 *   n'a ete declaree, l'operation est REFUSEE. Une faille applicative se
 *   traduit donc par une erreur bruyante, jamais par une fuite silencieuse.
 *
 * TENTATIVE DE CONTOURNEMENT
 *   Si l'appelant fournit lui-meme un `tenantId` different du tenant courant,
 *   l'operation est refusee et journalisee comme incident de securite. On ne
 *   se contente pas d'ecraser silencieusement la valeur : une telle divergence
 *   revele soit un bug, soit une tentative d'acces croise.
 *
 * LIMITE ASSUMEE
 *   Les ecritures IMBRIQUEES (`order.create({ data: { items: { create: ... } } })`)
 *   ne passent pas par cette interception. Ce n'est pas un trou : `tenantId`
 *   etant une colonne NON NULLE sur ces modeles, TypeScript refuse de compiler
 *   une creation imbriquee qui l'omettrait. La verification est donc faite a
 *   la compilation plutot qu'a l'execution.
 *   Les requetes SQL brutes (`$queryRaw`) sont egalement hors interception :
 *   elles doivent filtrer explicitement et sont concentrees dans les services
 *   de reporting, ou elles sont revues et testees.
 */

import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../context/request-context';
import { asPrimitiveString } from '../../common/utils/text';
import { isTenantOptionalModel, isTenantScopedModel } from './tenant-scoped-models';

/** Erreur levee lorsqu'une requete scopee s'execute sans tenant actif. */
export class TenantContextMissingError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(
      `Requete refusee : ${model}.${operation} necessite un tenant actif. ` +
        'Encadrez l appel avec RequestContextStore.runWithTenant(), ou declarez ' +
        'explicitement une sortie de perimetre avec runUnscoped(raison).',
    );
    this.name = 'TenantContextMissingError';
  }
}

/** Erreur levee lorsqu'un appelant tente d'adresser un autre tenant. */
export class CrossTenantAccessError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    readonly requestedTenantId: string,
    readonly activeTenantId: string,
  ) {
    super(
      `Acces inter-tenant bloque sur ${model}.${operation} : ` +
        `tenant demande ${requestedTenantId}, tenant actif ${activeTenantId}.`,
    );
    this.name = 'CrossTenantAccessError';
  }
}

/** Operations dont le filtre porte sur `args.where`. */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations dont le filtre porte sur `args.data`. */
const DATA_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** `upsert` combine les deux. */
const UPSERT_OPERATION = 'upsert';

type AnyArgs = Record<string, unknown>;

/**
 * Verifie qu'un `tenantId` fourni par l'appelant correspond bien au tenant
 * actif, puis retourne la valeur a appliquer.
 */
function reconcileTenantId(
  provided: unknown,
  activeTenantId: string,
  model: string,
  operation: string,
): string {
  if (provided === undefined || provided === null) return activeTenantId;

  // Forme `{ equals: '...' }` produite par certains constructeurs de filtres.
  const value =
    typeof provided === 'object' && provided !== null && 'equals' in provided
      ? (provided as { equals?: unknown }).equals
      : provided;

  if (value === undefined || value === null) return activeTenantId;

  if (typeof value !== 'string') {
    // Un `tenantId` non textuel ne peut pas etre le tenant actif : on refuse,
    // en decrivant ce qui a ete recu sans tenter de l'aplatir en texte.
    throw new CrossTenantAccessError(
      model,
      operation,
      asPrimitiveString(value) ?? `[${typeof value}]`,
      activeTenantId,
    );
  }

  if (value !== activeTenantId) {
    throw new CrossTenantAccessError(model, operation, value, activeTenantId);
  }

  return activeTenantId;
}

function applyWhereScope(
  args: AnyArgs,
  tenantId: string,
  model: string,
  operation: string,
): AnyArgs {
  const where = (args.where ?? {}) as AnyArgs;
  const reconciled = reconcileTenantId(where.tenantId, tenantId, model, operation);
  return { ...args, where: { ...where, tenantId: reconciled } };
}

function applyDataScope(args: AnyArgs, tenantId: string, model: string, operation: string): AnyArgs {
  const data = args.data;

  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => {
        const record = (row ?? {}) as AnyArgs;
        return { ...record, tenantId: reconcileTenantId(record.tenantId, tenantId, model, operation) };
      }),
    };
  }

  const record = (data ?? {}) as AnyArgs;

  // Une creation peut rattacher le tenant par relation (`tenant: { connect }`)
  // plutot que par scalaire. On respecte alors ce choix, apres verification.
  if (record.tenant && typeof record.tenant === 'object') {
    const connect = (record.tenant as AnyArgs).connect as AnyArgs | undefined;
    if (connect?.id !== undefined) {
      reconcileTenantId(connect.id, tenantId, model, operation);
      return args;
    }
  }

  return {
    ...args,
    data: { ...record, tenantId: reconcileTenantId(record.tenantId, tenantId, model, operation) },
  };
}

export interface TenantGuardHooks {
  /** Appele lorsqu'un acces inter-tenant est bloque : alimente l'audit. */
  onCrossTenantAttempt?: (error: CrossTenantAccessError) => void;
  /** Appele lorsqu'une requete scopee est tentee sans tenant actif. */
  onMissingContext?: (error: TenantContextMissingError) => void;
}

/**
 * Construit l'extension Prisma d'isolation multi-tenant.
 */
export function createTenantGuardExtension(hooks: TenantGuardHooks = {}) {
  return Prisma.defineExtension({
    name: 'ecomflow-tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scoped = isTenantScopedModel(model);
          const optional = isTenantOptionalModel(model);

          if (!scoped && !optional) {
            return query(args);
          }

          const context = RequestContextStore.get();
          const activeTenantId = context?.tenantId ?? null;

          if (!activeTenantId) {
            // Sortie de perimetre declaree : on laisse passer sans filtre.
            // C'est le cas de l'authentification, de l'administration
            // plateforme et des jobs qui balayent plusieurs boutiques.
            if (context?.unscopedReason) {
              return query(args);
            }

            if (optional) {
              // Un modele « optionnel » (Role de plateforme, AuditLog global)
              // reste lisible hors tenant : il n'y a pas de donnee de boutique
              // a proteger tant qu'aucun tenant n'est actif.
              return query(args);
            }

            const error = new TenantContextMissingError(model, operation);
            hooks.onMissingContext?.(error);
            throw error;
          }

          try {
            const typedArgs = (args ?? {});

            if (operation === UPSERT_OPERATION) {
              const withWhere = applyWhereScope(typedArgs, activeTenantId, model, operation);
              const created = (withWhere.create ?? {}) as AnyArgs;
              return await query({
                ...withWhere,
                create: {
                  ...created,
                  tenantId: reconcileTenantId(created.tenantId, activeTenantId, model, operation),
                },
              } as typeof args);
            }

            if (WHERE_OPERATIONS.has(operation)) {
              return await query(
                applyWhereScope(typedArgs, activeTenantId, model, operation),
              );
            }

            if (DATA_OPERATIONS.has(operation)) {
              return await query(
                applyDataScope(typedArgs, activeTenantId, model, operation),
              );
            }

            return await query(args);
          } catch (error) {
            if (error instanceof CrossTenantAccessError) {
              hooks.onCrossTenantAttempt?.(error);
            }
            throw error;
          }
        },
      },
    },
  });
}
