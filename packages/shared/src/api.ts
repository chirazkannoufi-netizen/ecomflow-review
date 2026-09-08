/**
 * Contrats d'API transverses : pagination, tri, filtres et enveloppes de reponse.
 *
 * Source de verite : V2 §22 (« pagination cote serveur, tri configurable »).
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export type SortDirection = 'asc' | 'desc';

export interface PaginationQuery {
  /** Page 1-indexee. */
  readonly page?: number;
  readonly pageSize?: number;
}

export interface SortQuery {
  readonly sortBy?: string;
  readonly sortDir?: SortDirection;
}

export interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
}

export interface Paginated<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
}

export function buildPageMeta(page: number, pageSize: number, total: number): PageMeta {
  const safePageSize = Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE));
  const totalPages = total === 0 ? 0 : Math.ceil(total / safePageSize);
  return {
    page,
    pageSize: safePageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && totalPages > 0,
  };
}

export function toSkipTake(query: PaginationQuery): { skip: number; take: number } {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE));
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** Periode d'analyse utilisee par le dashboard et les rapports. */
export interface DateRangeQuery {
  /** Date ISO incluse (borne basse), interpretee dans le fuseau du tenant. */
  readonly from?: string;
  /** Date ISO incluse (borne haute). */
  readonly to?: string;
}

/** Reponse standard d'une action qui ne retourne pas de ressource. */
export interface AcknowledgedResponse {
  readonly acknowledged: true;
  readonly message?: string;
}

/** Reponse d'un declenchement de traitement asynchrone. */
export interface JobAcceptedResponse {
  readonly jobId: string;
  readonly status: 'QUEUED' | 'RUNNING';
  readonly message?: string;
}

/**
 * En-tete d'idempotence accepte par les endpoints qui creent une ressource
 * couteuse a dupliquer (commande, colis, paiement).
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** En-tete de correlation propage dans les logs et renvoye au client. */
export const CORRELATION_HEADER = 'x-correlation-id';

/** En-tete portant le tenant courant lorsque l'utilisateur est multi-boutique. */
export const TENANT_HEADER = 'x-tenant-id';
