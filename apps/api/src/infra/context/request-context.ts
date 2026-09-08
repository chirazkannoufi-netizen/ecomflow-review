/**
 * Contexte de requete propage implicitement via AsyncLocalStorage.
 *
 * Il porte l'identite de l'appelant et, surtout, le TENANT COURANT. Ce dernier
 * n'est jamais lu depuis le corps de la requete : il provient exclusivement du
 * jeton d'acces verifie et de l'adhesion (`Membership`) correspondante.
 *
 * L'interet d'un stockage implicite plutot que d'un parametre passe de main en
 * main : le garde Prisma (`tenantGuardExtension`) peut refuser TOUTE requete
 * non scopee, y compris dans un service profondement imbrique qui aurait
 * « oublie » de filtrer. La securite ne repose plus sur la discipline du
 * developpeur.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Raison pour laquelle une operation s'execute hors perimetre d'un tenant. */
export type UnscopedReason =
  | 'AUTHENTICATION'
  | 'PLATFORM_ADMIN'
  | 'BACKGROUND_JOB'
  | 'WEBHOOK_DISPATCH'
  | 'BOOTSTRAP'
  | 'HEALTHCHECK'
  | 'TEST';

export interface RequestContext {
  /** Tenant courant. `null` uniquement lorsque `unscopedReason` est renseigne. */
  readonly tenantId: string | null;
  /** Utilisateur authentifie, si la requete l'est. */
  readonly userId: string | null;
  /** Adhesion de l'utilisateur au tenant courant. */
  readonly membershipId: string | null;
  /** Permissions effectives, resolues une seule fois par requete. */
  readonly permissions: ReadonlySet<string>;
  /** Vrai pour un SUPER_ADMIN de la plateforme. */
  readonly isPlatformAdmin: boolean;
  /** Identifiant de correlation propage dans les logs et renvoye au client. */
  readonly correlationId: string;
  /**
   * Renseigne pour autoriser explicitement une operation hors tenant.
   * Sa presence est journalisee : une operation non scopee doit rester rare
   * et intentionnelle.
   */
  readonly unscopedReason: UnscopedReason | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

function baseContext(correlationId: string): RequestContext {
  return {
    tenantId: null,
    userId: null,
    membershipId: null,
    permissions: new Set<string>(),
    isPlatformAdmin: false,
    correlationId,
    unscopedReason: null,
    ipAddress: null,
    userAgent: null,
  };
}

export const RequestContextStore = {
  /** Contexte courant, ou `undefined` hors de toute execution encadree. */
  get(): RequestContext | undefined {
    return storage.getStore();
  },

  /**
   * Contexte courant, ou une erreur explicite. Utilise par les services qui
   * ne peuvent pas fonctionner sans identite d'appelant.
   */
  require(): RequestContext {
    const context = storage.getStore();
    if (!context) {
      throw new Error(
        'Aucun contexte de requete actif. Une operation metier doit s executer ' +
          'dans RequestContextStore.run(), runWithTenant() ou runUnscoped().',
      );
    }
    return context;
  },

  /** Tenant courant, ou une erreur si l'execution n'est pas scopee. */
  requireTenantId(): string {
    const context = RequestContextStore.require();
    if (!context.tenantId) {
      throw new Error(
        'Operation scopee tenant demandee hors contexte de tenant ' +
          `(raison hors perimetre : ${context.unscopedReason ?? 'aucune'}).`,
      );
    }
    return context.tenantId;
  },

  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
  },

  /** Execute `fn` dans le perimetre d'un tenant. */
  runWithTenant<T>(tenantId: string, fn: () => T, overrides: Partial<RequestContext> = {}): T {
    const parent = storage.getStore();
    const context: RequestContext = {
      ...(parent ?? baseContext(overrides.correlationId ?? generateCorrelationId())),
      ...overrides,
      tenantId,
      unscopedReason: null,
    };
    return storage.run(context, fn);
  },

  /**
   * Execute `fn` sans perimetre de tenant. La raison est OBLIGATOIRE : elle
   * documente le point d'entree et apparait dans les journaux d'audit.
   */
  runUnscoped<T>(reason: UnscopedReason, fn: () => T, overrides: Partial<RequestContext> = {}): T {
    const parent = storage.getStore();
    const context: RequestContext = {
      ...(parent ?? baseContext(overrides.correlationId ?? generateCorrelationId())),
      ...overrides,
      tenantId: null,
      unscopedReason: reason,
    };
    return storage.run(context, fn);
  },

  /** Ajoute des informations au contexte courant sans changer de perimetre. */
  patch<T>(patch: Partial<RequestContext>, fn: () => T): T {
    const parent = RequestContextStore.require();
    return storage.run({ ...parent, ...patch }, fn);
  },

  /**
   * Enrichit EN PLACE le contexte courant.
   *
   * Necessaire au cycle de vie HTTP de NestJS : le middleware ouvre le
   * contexte (identifiant de correlation, IP), puis les gardes qui s'executent
   * plus tard y ajoutent l'utilisateur, le tenant et les permissions. Comme
   * AsyncLocalStorage conserve une REFERENCE, la mutation est immediatement
   * visible par tout le reste de la requete, y compris le garde Prisma.
   *
   * Reserve a l'infrastructure : aucun service metier ne doit l'appeler.
   */
  update(patch: Partial<RequestContext>): void {
    const current = RequestContextStore.require() as MutableRequestContext;
    Object.assign(current, patch);
  },
};

/** Vue mutable du contexte, reservee a l'infrastructure. */
type MutableRequestContext = {
  -readonly [K in keyof RequestContext]: RequestContext[K];
};

/**
 * Identifiant de correlation lexicographiquement croissant, lisible dans les
 * journaux. Base sur l'horodatage plus une part aleatoire.
 */
export function generateCorrelationId(): string {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}${random}`;
}

/** Fabrique un contexte complet, utilisee par le middleware HTTP et les tests. */
export function createRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return { ...baseContext(overrides.correlationId ?? generateCorrelationId()), ...overrides };
}
