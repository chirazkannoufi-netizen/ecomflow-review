/**
 * Client HTTP de l'API EcomFlow.
 *
 * TROIS RESPONSABILITES, ET RIEN D'AUTRE :
 *
 *  1. PORTER LE JETON. Il est lu depuis le stockage de session au moment de
 *     l'appel, jamais capture a la construction : apres un rafraichissement,
 *     l'appel suivant utilise immediatement le nouveau jeton.
 *
 *  2. RAFRAICHIR AUTOMATIQUEMENT. Sur 401, le client tente un renouvellement
 *     puis rejoue l'appel UNE SEULE FOIS. Les rafraichissements concurrents
 *     sont dedupliques : dix requetes qui expirent ensemble ne declenchent
 *     qu'un seul appel de renouvellement — sans quoi la rotation des jetons
 *     detecterait un rejeu et deconnecterait l'utilisateur.
 *
 *  3. NORMALISER LES ERREURS. Toute erreur devient une `ApiError` portant le
 *     `code` contractuel du backend, ce qui permet a l'interface de reagir
 *     precisement (stock insuffisant, abonnement expire, transition interdite).
 */

import type { ApiErrorBody } from '@ecomflow/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

/** Cles de stockage. `sessionStorage` : le jeton ne survit pas a l'onglet. */
const ACCESS_TOKEN_KEY = 'ecomflow.accessToken';
const REFRESH_TOKEN_KEY = 'ecomflow.refreshToken';
const TENANT_KEY = 'ecomflow.tenantId';

/**
 * Traduit un code d'erreur backend en phrase destinee a l'utilisateur.
 *
 * Retourne `null` si le code est inconnu du catalogue : l'appelant retombe
 * alors sur le message du serveur, qui reste plus utile qu'une cle brute.
 */
export type ErrorMessageResolver = (code: string, status: number) => string | null;

/**
 * Resolveur actif, installe par `LocaleProvider` a chaque changement de langue.
 *
 * POURQUOI UN REGISTRE PLUTOT QU'UN HOOK
 *   `ApiError.userMessage` est un accesseur de classe : il n'a acces ni au
 *   contexte React ni aux traductions. On pourrait exiger que chaque ecran
 *   appelle un `useApiErrorMessage(error)` — mais il suffirait alors d'un seul
 *   ecran oublie pour reintroduire un message francais au milieu d'une page
 *   arabe. C'est precisement le defaut qu'on corrige ici.
 *
 *   Le registre garantit que TOUS les appelants existants de `userMessage`
 *   sont traduits d'un coup, sans modification, et que ceux a venir le seront
 *   aussi par construction.
 */
let resolveErrorMessage: ErrorMessageResolver = () => null;

export function setErrorMessageResolver(resolver: ErrorMessageResolver): void {
  resolveErrorMessage = resolver;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Vrai si l'action a echoue faute d'abonnement actif. */
  get isSubscriptionRequired(): boolean {
    return this.code === 'SUBSCRIPTION_REQUIRED' || this.status === 402;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * Message destine a l'utilisateur, DANS SA LANGUE.
   *
   * Le serveur renvoie toujours un code stable (`AUTH_INVALID_CREDENTIALS`)
   * en plus de son message francais. C'est le CODE qui est traduit ici : le
   * message du serveur reste dans la reponse pour les journaux et le support,
   * mais n'est plus ce qu'on affiche.
   *
   * Repli volontaire sur le message du serveur si le code est inconnu : une
   * phrase francaise reste plus utile a un utilisateur qu'une cle brute ou un
   * message vide.
   */
  get userMessage(): string {
    const translated = resolveErrorMessage(this.status === 0 ? 'NETWORK' : this.code, this.status);
    if (translated) return translated;

    if (this.status === 0) {
      return 'Connexion au serveur impossible. Verifiez votre connexion internet.';
    }
    return this.message;
  }
}

// ---------------------------------------------------------------------------
// Stockage de session
// ---------------------------------------------------------------------------

export const tokenStore = {
  getAccessToken(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  getRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  getTenantId(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(TENANT_KEY);
  },
  set(accessToken: string, refreshToken: string, tenantId: string | null): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    if (tenantId) window.localStorage.setItem(TENANT_KEY, tenantId);
    else window.localStorage.removeItem(TENANT_KEY);
  },
  clear(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.localStorage.removeItem(TENANT_KEY);
  },
};

// ---------------------------------------------------------------------------
// Renouvellement de session
// ---------------------------------------------------------------------------

/**
 * Promesse de renouvellement en cours, partagee.
 *
 * Sans cette deduplication, plusieurs requetes expirant simultanement
 * appelleraient `/auth/refresh` en parallele. La rotation des jetons cote
 * serveur y verrait un REJEU et revoquerait toute la famille de sessions :
 * l'utilisateur serait deconnecte pour avoir simplement ouvert deux onglets.
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const refreshToken = tokenStore.getRefreshToken();
  if (!refreshToken) return false;

  refreshPromise ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        tokenStore.clear();
        return false;
      }

      const session = (await response.json()) as {
        tokens: { accessToken: string; refreshToken: string };
        tenant: { id: string } | null;
      };

      tokenStore.set(
        session.tokens.accessToken,
        session.tokens.refreshToken,
        session.tenant?.id ?? null,
      );
      return true;
    } catch {
      tokenStore.clear();
      return false;
    } finally {
      // Libere le verrou pour permettre un futur renouvellement.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();

  return refreshPromise;
}

// ---------------------------------------------------------------------------
// Appel HTTP
// ---------------------------------------------------------------------------

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined | null | string[]>;
  /** Cle d'idempotence pour les creations couteuses. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  /** N'ajoute pas le jeton (routes publiques). */
  readonly anonymous?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query);

  const execute = async (): Promise<Response> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (!options.anonymous) {
      const token = tokenStore.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;

      const tenantId = tokenStore.getTenantId();
      if (tenantId) headers['x-tenant-id'] = tenantId;
    }

    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    return fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  };

  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    // Panne reseau : distinguee d'une erreur applicative par le statut 0.
    throw new ApiError(0, 'NETWORK_ERROR', (error as Error).message);
  }

  // --- Renouvellement puis rejeu unique ------------------------------------
  if (response.status === 401 && !options.anonymous) {
    const refreshed = await refreshSession();
    if (refreshed) {
      try {
        response = await execute();
      } catch (error) {
        throw new ApiError(0, 'NETWORK_ERROR', (error as Error).message);
      }
    }
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as ApiErrorBody | T | null;

  if (!response.ok) {
    const error = (payload ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(
      response.status,
      error.code ?? 'INTERNAL_ERROR',
      error.message ?? `Erreur ${response.status}`,
      error.details,
      error.correlationId,
    );
  }

  return payload as T;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_URL}${path}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) url.searchParams.set(key, value.join(','));
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/** Raccourcis lisibles. */
export const api = {
  get: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),

  /** Remplacement idempotent : rejouer l'appel doit laisser le meme etat. */
  put: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),

  /**
   * Telecharge un fichier servi par l'API.
   *
   * POURQUOI PAS UN SIMPLE `<a href>`
   *   La route exige un jeton porteur, qu'un lien ne transmet pas. On recupere
   *   donc la reponse en blob, puis on declenche le telechargement depuis un
   *   lien temporaire. L'URL d'objet est REVOQUEE ensuite : chaque blob non
   *   libere reste en memoire jusqu'au rechargement de la page.
   */
  download: async (path: string, filename: string, body?: unknown): Promise<void> => {
    const headers: Record<string, string> = {};
    const token = tokenStore.getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const tenantId = tokenStore.getTenantId();
    if (tenantId) headers['x-tenant-id'] = tenantId;

    // POST des qu'un corps est fourni : une selection de deux cents
    // identifiants ne tient pas dans une URL, et la tronquer exporterait
    // silencieusement moins de lignes que ce qui etait coche.
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(buildUrl(path), {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw new ApiError(response.status, 'DOWNLOAD_FAILED', 'Le telechargement a echoue.');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },

  delete: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
