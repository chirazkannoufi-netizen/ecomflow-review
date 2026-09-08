/**
 * Lecture et validation d'une ligne de feuille de calcul — V2 §12.
 *
 * PHILOSOPHIE : etre TOLERANT a la forme, STRICT sur le fond.
 *
 *   Les feuilles de calcul des commercants sont saisies a la main, souvent par
 *   plusieurs personnes, parfois depuis un telephone. On y trouve des espaces
 *   parasites, des numeros en chiffres arabes, des prix formates « 4 500,00 DA »,
 *   des wilayas ecrites de six facons differentes. Rejeter ces lignes serait
 *   rejeter des commandes parfaitement valides — et ferait perdre de l'argent
 *   au commercant.
 *
 *   En revanche, une donnee reellement inexploitable (telephone invalide,
 *   quantite nulle, SKU inconnu) est rejetee avec un CODE D'ERREUR PRECIS et le
 *   numero de ligne, pour que le commercant sache exactement quoi corriger
 *   (V1 §6 : « les erreurs d'import doivent etre visibles dans un journal avec
 *   la ligne concernee et une explication »).
 */

import {
  dinarsToCentimes,
  parseAlgerianPhone,
  resolveWilaya,
  type ImportRowErrorCode,
} from '@ecomflow/shared';

/** Champs EcomFlow alimentables depuis une colonne de la feuille. */
export const MAPPABLE_FIELDS = [
  'date',
  'customerName',
  'phone',
  'wilaya',
  'commune',
  'address',
  'productName',
  'sku',
  'quantity',
  'unitPrice',
  'deliveryFee',
  'total',
  'sourceStatus',
  'externalId',
  'notes',
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/** Champs sans lesquels aucune commande ne peut etre creee. */
export const REQUIRED_FIELDS: readonly MappableField[] = [
  'customerName',
  'phone',
  'wilaya',
  'quantity',
];

/** Mapping colonne : `{ phone: 'C' }` ou `{ phone: 2 }` (index 0-base). */
export type ColumnMapping = Partial<Record<MappableField, string | number>>;

export interface ParsedRow {
  readonly customerName: string;
  readonly phoneE164: string;
  readonly phoneRaw: string;
  readonly wilayaCode: number;
  readonly wilayaName: string;
  readonly commune: string;
  readonly addressText: string;
  readonly productName: string | null;
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitPriceCentimes: number | null;
  readonly deliveryFeeCentimes: number;
  readonly totalCentimes: number | null;
  readonly sourceStatus: string | null;
  readonly externalId: string | null;
  readonly notes: string | null;
  readonly orderedAt: Date | null;
}

export type RowParseResult =
  | { readonly ok: true; readonly value: ParsedRow }
  | {
      readonly ok: false;
      readonly code: ImportRowErrorCode;
      readonly message: string;
      readonly field?: MappableField;
    };

/**
 * Convertit une reference de colonne en index 0-base.
 * Accepte « A », « b », « AA », ou un index numerique deja resolu.
 */
export function columnToIndex(column: string | number): number {
  if (typeof column === 'number') return column;

  const letters = column.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(letters)) {
    // Une valeur numerique sous forme de chaine reste acceptee.
    const parsed = Number.parseInt(letters, 10);
    if (!Number.isNaN(parsed)) return parsed;
    return -1;
  }

  let index = 0;
  for (const character of letters) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** Conversion inverse : 0 -> « A », 26 -> « AA ». */
export function indexToColumn(index: number): string {
  let remaining = index + 1;
  let column = '';
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    column = String.fromCharCode(65 + modulo) + column;
    remaining = Math.floor((remaining - modulo) / 26);
  }
  return column;
}

/**
 * Deduit un mapping a partir de la ligne d'en-tete.
 *
 * Utilise par l'assistant d'onboarding (Addendum §34) : le commercant n'a rien
 * a configurer si ses en-tetes ressemblent au format de reference. Il peut
 * toujours corriger le mapping propose.
 */
export function inferMappingFromHeaders(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const assigned = new Set<MappableField>();

  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (normalized.length === 0) return;

    for (const [field, patterns] of Object.entries(HEADER_PATTERNS) as [
      MappableField,
      readonly string[],
    ][]) {
      if (assigned.has(field)) continue;
      if (patterns.some((pattern) => normalized === pattern || normalized.startsWith(pattern))) {
        (mapping as Record<string, number>)[field] = index;
        assigned.add(field);
        return;
      }
    }
  });

  return mapping;
}

/** Motifs d'en-tete reconnus, normalises (sans accent, minuscules, sans espace). */
const HEADER_PATTERNS: Record<MappableField, readonly string[]> = {
  date: ['date', 'datecommande', 'jour'],
  customerName: ['nom', 'client', 'nomclient', 'nomduclient', 'fullname', 'name'],
  phone: ['telephone', 'tel', 'phone', 'mobile', 'numero', 'contact'],
  wilaya: ['wilaya', 'willaya', 'state', 'province'],
  commune: ['commune', 'ville', 'city', 'daira'],
  address: ['adresse', 'address', 'adresseclient'],
  productName: ['produit', 'product', 'article', 'designation'],
  sku: ['sku', 'reference', 'ref', 'codeproduit'],
  quantity: ['quantite', 'qte', 'qty', 'quantity', 'nombre'],
  unitPrice: ['prix', 'prixunitaire', 'price', 'pu', 'montant'],
  deliveryFee: ['livraison', 'fraisdelivraison', 'frais', 'shipping', 'delivery'],
  total: ['total', 'totalcommande', 'montanttotal'],
  sourceStatus: ['statut', 'status', 'etat'],
  externalId: ['id', 'idcommande', 'orderid', 'identifiant'],
  notes: ['note', 'notes', 'remarque', 'commentaire', 'observation'],
};

function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface ParseOptions {
  /** Frais de livraison par defaut si la colonne est absente. */
  readonly defaultDeliveryFeeCentimes?: number;
  /** Quantite par defaut si la colonne est absente ou vide. */
  readonly defaultQuantity?: number;
}

/**
 * Analyse une ligne selon le mapping configure.
 *
 * @param row valeurs brutes de la ligne, dans l'ordre des colonnes
 * @param mapping correspondance champ EcomFlow -> colonne
 */
export function parseRow(
  row: readonly string[],
  mapping: ColumnMapping,
  options: ParseOptions = {},
): RowParseResult {
  const read = (field: MappableField): string => {
    const column = mapping[field];
    if (column === undefined) return '';
    const index = columnToIndex(column);
    if (index < 0) return '';
    return (row[index] ?? '').toString().trim();
  };

  // --- Champs obligatoires -------------------------------------------------
  const customerName = read('customerName');
  if (customerName.length === 0) {
    return {
      ok: false,
      code: 'MISSING_REQUIRED_FIELD',
      field: 'customerName',
      message: 'Le nom du client est vide.',
    };
  }

  const phoneRaw = read('phone');
  if (phoneRaw.length === 0) {
    return {
      ok: false,
      code: 'MISSING_REQUIRED_FIELD',
      field: 'phone',
      message: 'Le numero de telephone est vide.',
    };
  }

  const phone = parseAlgerianPhone(phoneRaw);
  if (!phone.ok) {
    return {
      ok: false,
      code: 'INVALID_PHONE',
      field: 'phone',
      message: `Numero de telephone inexploitable : « ${phoneRaw} ».`,
    };
  }

  const wilayaRaw = read('wilaya');
  const wilaya = resolveWilaya(wilayaRaw);
  if (!wilaya) {
    return {
      ok: false,
      code: 'UNKNOWN_WILAYA',
      field: 'wilaya',
      message:
        wilayaRaw.length === 0
          ? 'La wilaya est vide.'
          : `Wilaya non reconnue : « ${wilayaRaw} ». Utilisez le code (1 a 58) ou le nom officiel.`,
    };
  }

  // --- Quantite ------------------------------------------------------------
  const quantityRaw = read('quantity');
  let quantity = options.defaultQuantity ?? 1;

  if (quantityRaw.length > 0) {
    const parsed = Number.parseInt(quantityRaw.replace(/[^\d-]/g, ''), 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return {
        ok: false,
        code: 'INVALID_QUANTITY',
        field: 'quantity',
        message: `Quantite invalide : « ${quantityRaw} ». Un entier positif est attendu.`,
      };
    }
    quantity = parsed;
  } else if (mapping.quantity !== undefined) {
    // La colonne est configuree mais vide : on ne devine pas une quantite,
    // au risque de creer une commande fausse.
    return {
      ok: false,
      code: 'MISSING_REQUIRED_FIELD',
      field: 'quantity',
      message: 'La quantite est vide.',
    };
  }

  // --- Montants ------------------------------------------------------------
  const unitPriceRaw = read('unitPrice');
  let unitPriceCentimes: number | null = null;
  if (unitPriceRaw.length > 0) {
    unitPriceCentimes = dinarsToCentimes(unitPriceRaw);
    if (unitPriceCentimes === null || unitPriceCentimes < 0) {
      return {
        ok: false,
        code: 'INVALID_PRICE',
        field: 'unitPrice',
        message: `Prix unitaire invalide : « ${unitPriceRaw} ».`,
      };
    }
  }

  const deliveryRaw = read('deliveryFee');
  let deliveryFeeCentimes = options.defaultDeliveryFeeCentimes ?? 0;
  if (deliveryRaw.length > 0) {
    const parsed = dinarsToCentimes(deliveryRaw);
    if (parsed === null || parsed < 0) {
      return {
        ok: false,
        code: 'INVALID_PRICE',
        field: 'deliveryFee',
        message: `Frais de livraison invalides : « ${deliveryRaw} ».`,
      };
    }
    deliveryFeeCentimes = parsed;
  }

  const totalRaw = read('total');
  const totalCentimes = totalRaw.length > 0 ? dinarsToCentimes(totalRaw) : null;

  // --- Champs optionnels ---------------------------------------------------
  const sku = emptyToNull(read('sku'));
  const productName = emptyToNull(read('productName'));

  if (!sku && !productName) {
    return {
      ok: false,
      code: 'MISSING_REQUIRED_FIELD',
      field: 'sku',
      message: 'Aucun produit identifie : renseignez au moins le SKU ou le nom du produit.',
    };
  }

  return {
    ok: true,
    value: {
      customerName,
      phoneE164: phone.value.e164,
      phoneRaw,
      wilayaCode: wilaya.code,
      wilayaName: wilaya.name,
      commune: read('commune'),
      addressText: read('address'),
      productName,
      sku,
      quantity,
      unitPriceCentimes,
      deliveryFeeCentimes,
      totalCentimes,
      sourceStatus: emptyToNull(read('sourceStatus')),
      externalId: emptyToNull(read('externalId')),
      notes: emptyToNull(read('notes')),
      orderedAt: parseDate(read('date')),
    },
  };
}

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

/**
 * Interprete une date de feuille de calcul.
 *
 * Formats acceptes : `29/08/2026`, `29-08-2026`, `2026-08-29`, ISO complet.
 * En cas d'echec, retourne `null` : la date de la commande vaudra alors
 * l'instant d'import. Une date illisible ne doit JAMAIS faire echouer un
 * import — c'est une information de confort, pas une donnee critique.
 */
export function parseDate(value: string): Date | null {
  if (value.length === 0) return null;

  // Format francais jj/mm/aaaa, le plus courant dans les feuilles algeriennes.
  const french = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (french?.[1] && french[2] && french[3]) {
    const day = Number.parseInt(french[1], 10);
    const month = Number.parseInt(french[2], 10);
    let year = Number.parseInt(french[3], 10);
    if (year < 100) year += 2000;

    const date = new Date(Date.UTC(year, month - 1, day));
    // Controle de coherence : `new Date(2026, 12, 40)` ne leve pas d'erreur,
    // il deborde silencieusement sur le mois suivant.
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return date;
    }
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
