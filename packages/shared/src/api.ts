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

/** Ligne refusee par un archivage en masse, avec son motif. */
export interface BulkArchiveSkip {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Resultat d'un archivage de selection.
 *
 * `archived` compte ce qui est passe ; `skipped` detaille ce qui ne l'est pas
 * et POURQUOI. Une selection partiellement traitee est le cas normal, pas une
 * anomalie : l'interface doit pouvoir le dire ligne par ligne.
 */
export interface BulkArchiveResult {
  readonly archived: number;
  readonly skipped: readonly BulkArchiveSkip[];
}

/**
 * Actions groupees disponibles sur l'ecran de preparation.
 *
 * `STEP_BACK` recule d'UNE etape dans le kanban — « en cours » revient a « a
 * preparer », « prete a expedier » revient a « en cours ». Il est distinct de
 * `RETURN_TO_CONFIRMATION`, qui fait sortir la commande de la preparation pour
 * la renvoyer en file d'appel : l'un corrige un geste, l'autre constate que la
 * commande n'aurait pas du arriver la.
 *
 * `CANCEL_AND_ARCHIVE` porte les DEUX gestes dans son nom, et le bouton
 * l'annonce de meme : l'archivage seul serait refuse tant que le stock est
 * reserve, et un bouton « Archiver » qui annule en silence des commandes
 * confirmees ferait plus que ce que son libelle promet.
 */
export const PREPARATION_BULK_ACTIONS = [
  'STEP_BACK',
  'RETURN_TO_CONFIRMATION',
  'CANCEL_AND_ARCHIVE',
  'MARK_READY',
] as const;

export type PreparationBulkAction = (typeof PREPARATION_BULK_ACTIONS)[number];
