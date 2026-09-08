/**
 * Generation et validation des references metier lisibles.
 *
 * Source de verite : V1 §7 et V2 §9 — « ID interne unique du type ORD-AAAA-XXXXXX ».
 *
 * Contraintes retenues :
 *  - la reference est UNIQUE PAR TENANT (deux boutiques peuvent avoir chacune
 *    leur ORD-2026-000001 : c'est ce qu'attend un commercant, et cela evite de
 *    divulguer le volume global de la plateforme) ;
 *  - la sequence est allouee en base (table `order_sequences`, cle
 *    `(tenant_id, year)`) via un UPDATE ... RETURNING atomique : pas de collision
 *    possible entre deux imports concurrents ;
 *  - la reference n'est JAMAIS une cle primaire : l'identite technique reste un
 *    UUID. La reference peut donc etre regeneree sans casser les relations.
 */

export const ORDER_REFERENCE_PREFIX = 'ORD';
export const ORDER_SEQUENCE_LENGTH = 6;

const ORDER_REFERENCE_PATTERN = /^ORD-(\d{4})-(\d{6,})$/;

export interface ParsedOrderReference {
  readonly year: number;
  readonly sequence: number;
}

/** Construit `ORD-2026-000001` a partir d'une annee et d'un numero de sequence. */
export function formatOrderReference(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError(`Annee de reference invalide : ${year}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`Sequence de reference invalide : ${sequence}`);
  }
  const padded = String(sequence).padStart(ORDER_SEQUENCE_LENGTH, '0');
  return `${ORDER_REFERENCE_PREFIX}-${year}-${padded}`;
}

export function parseOrderReference(reference: string): ParsedOrderReference | null {
  const match = ORDER_REFERENCE_PATTERN.exec(reference.trim().toUpperCase());
  if (!match?.[1] || !match[2]) return null;
  return { year: Number.parseInt(match[1], 10), sequence: Number.parseInt(match[2], 10) };
}

export function isOrderReference(value: string): boolean {
  return ORDER_REFERENCE_PATTERN.test(value.trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// Cles d'idempotence
// ---------------------------------------------------------------------------

/**
 * Prefixes de cles d'idempotence, par domaine. Une cle est stockee dans la table
 * `idempotency_keys` avec une contrainte UNIQUE `(tenant_id, scope, key)`.
 *
 * Source de verite : V2 §12 (« generer une cle d'idempotence »), §16
 * (« idempotency key » transporteur), §30 (webhooks), prompt produit §15.
 */
export const IDEMPOTENCY_SCOPES = {
  SHEET_ROW: 'sheet_row',
  CSV_ROW: 'csv_row',
  ORDER_CREATE: 'order_create',
  SHIPMENT_CREATE: 'shipment_create',
  CARRIER_WEBHOOK: 'carrier_webhook',
  PAYMENT_WEBHOOK: 'payment_webhook',
  WHATSAPP_MESSAGE: 'whatsapp_message',
} as const;

export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[keyof typeof IDEMPOTENCY_SCOPES];

/**
 * Cle stable d'une ligne Google Sheets.
 *
 * Deux strategies, dans cet ordre de preference :
 *  1. `externalRowId` fourni par la source (colonne ID dediee) — le plus fiable,
 *     resiste au tri et a l'insertion de lignes ;
 *  2. a defaut, un hash stable des valeurs metier de la ligne. On n'utilise
 *     PAS le numero de ligne seul : inserer une ligne au milieu de la feuille
 *     decalerait toutes les suivantes et recreerait des commandes.
 *
 * Le hash est calcule cote serveur (`ImportHashService`) : cette fonction ne
 * produit que la chaine canonique a hasher, afin que la logique de canonisation
 * soit testable et partagee.
 */
export function buildSheetRowFingerprintSource(values: {
  readonly spreadsheetId: string;
  readonly sheetId: string;
  readonly externalRowId?: string | null;
  readonly businessValues?: readonly (string | number | null | undefined)[];
}): string {
  const base = `${values.spreadsheetId}::${values.sheetId}`;

  if (values.externalRowId && values.externalRowId.trim().length > 0) {
    return `${base}::id::${values.externalRowId.trim()}`;
  }

  const normalized = (values.businessValues ?? [])
    .map((value) =>
      value === null || value === undefined
        ? ''
        : String(value).trim().replace(/\s+/g, ' ').toLowerCase(),
    )
    .join('|');

  return `${base}::hash::${normalized}`;
}
