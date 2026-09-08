/**
 * Decorateurs transverses.
 *
 * Ils constituent le vocabulaire de securite des controleurs : lire la
 * signature d'une route doit suffire pour savoir qui peut l'appeler, avec
 * quelles permissions et sous quelle condition d'abonnement.
 */

import { SetMetadata, createParamDecorator, applyDecorators } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { IDEMPOTENCY_HEADER } from '@ecomflow/shared';
import type { RequestContext } from '../../infra/context/request-context';
import { RequestContextStore } from '../../infra/context/request-context';

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

export const IS_PUBLIC_KEY = 'ecomflow:isPublic';

/**
 * Rend une route accessible sans jeton d'acces.
 *
 * L'authentification est OBLIGATOIRE PAR DEFAUT : le garde JWT est enregistre
 * globalement. Il faut donc une action explicite pour ouvrir une route, jamais
 * l'inverse. Une route oubliee est fermee, pas ouverte.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PERMISSIONS_KEY = 'ecomflow:permissions';
export const PERMISSIONS_MODE_KEY = 'ecomflow:permissionsMode';

export type PermissionMode = 'ALL' | 'ANY';

/** Exige que l'appelant possede TOUTES les permissions listees. */
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'ALL' satisfies PermissionMode),
  );

/** Exige AU MOINS UNE des permissions listees. */
export const RequireAnyPermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'ANY' satisfies PermissionMode),
  );

export const PLATFORM_ADMIN_KEY = 'ecomflow:platformAdmin';

/** Reserve la route aux administrateurs de la plateforme (SUPER_ADMIN). */
export const PlatformAdminOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_ADMIN_KEY, true);

// ---------------------------------------------------------------------------
// Abonnement
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_KEY = 'ecomflow:requiresOperationalSubscription';

/**
 * Exige un abonnement operationnel (essai en cours ou abonnement actif).
 *
 * A poser sur toute route qui fait AVANCER l'operationnel : creation de
 * commande, confirmation, expedition, synchronisation. La consultation, la
 * gestion de l'abonnement et l'export des donnees restent accessibles apres
 * expiration — un commercant doit pouvoir recuperer ses donnees et payer,
 * meme quand son essai est termine (V2 §7).
 */
export const RequiresOperationalSubscription = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SUBSCRIPTION_KEY, true);

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

export const IDEMPOTENT_KEY = 'ecomflow:idempotentScope';

/**
 * Rend une route idempotente sur l'en-tete `Idempotency-Key`.
 * Un rejeu avec la meme cle et le meme corps renvoie la reponse initiale
 * sans re-executer l'action (V2 §12, prompt produit §15).
 */
export const Idempotent = (scope: string): MethodDecorator =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, scope),
    ApiHeader({
      name: IDEMPOTENCY_HEADER,
      required: false,
      description:
        'Cle d idempotence. Un rejeu avec la meme cle et le meme corps renvoie ' +
        'la reponse de la premiere execution, sans creer de doublon.',
    }),
  );

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AUDIT_KEY = 'ecomflow:audit';

export interface AuditMetadata {
  readonly action: string;
  readonly entityType: string;
  /** Nom du parametre de route portant l'identifiant de l'entite. */
  readonly entityIdParam?: string;
}

/** Journalise automatiquement l'appel dans le journal d'audit (V2 §23). */
export const Audited = (metadata: AuditMetadata): MethodDecorator =>
  SetMetadata(AUDIT_KEY, metadata);

// ---------------------------------------------------------------------------
// Extraction du contexte
// ---------------------------------------------------------------------------

/**
 * Injecte le contexte de requete complet.
 *
 * Il provient d'AsyncLocalStorage, pas de l'objet `request` : c'est la MEME
 * source que celle consultee par le garde Prisma. Impossible qu'un controleur
 * agisse sur un tenant different de celui applique aux requetes SQL.
 */
export const Ctx = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): RequestContext => RequestContextStore.require(),
);

/** Injecte l'identifiant du tenant courant. */
export const TenantId = createParamDecorator((_data: unknown, _context: ExecutionContext): string =>
  RequestContextStore.requireTenantId(),
);

/** Injecte l'identifiant de l'utilisateur authentifie. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): string => {
    const context = RequestContextStore.require();
    if (!context.userId) {
      throw new Error('CurrentUserId utilise sur une route non authentifiee.');
    }
    return context.userId;
  },
);

/** Injecte l'identifiant d'adhesion (membership) de l'utilisateur au tenant. */
export const CurrentMembershipId = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): string => {
    const context = RequestContextStore.require();
    if (!context.membershipId) {
      throw new Error('CurrentMembershipId utilise hors contexte de boutique.');
    }
    return context.membershipId;
  },
);
