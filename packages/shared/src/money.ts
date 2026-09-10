/**
 * Representation monetaire EcomFlow.
 *
 * DECISION STRUCTURANTE (voir DECISIONS.md — « Representation monetaire ») :
 * tous les montants sont manipules et stockes en ENTIERS de centimes de dinar
 * algerien (1 DZD = 100 centimes). Aucun `float` n'est utilise pour de l'argent,
 * ni en base, ni dans les DTO, ni dans les calculs de marge.
 *
 * Raisons :
 *  - la V2 impose des calculs de rentabilite exacts (§20, Addendum §33) ;
 *  - les arrondis flottants produisent des ecarts cumulatifs sur les agregats ;
 *  - un entier se serialise sans ambiguite en JSON, contrairement a un Decimal.
 *
 * Les champs API portant un montant sont suffixes `_centimes` cote base et
 * exposes en `{ amount: number, currency: 'DZD' }` cote DTO.
 */

export const CURRENCY = 'DZD' as const;
export type Currency = typeof CURRENCY;

export const CENTIMES_PER_DINAR = 100;

/** Montant entier, exprime en centimes. Jamais fractionnaire. */
export type Centimes = number;

export interface MoneyDto {
  /** Montant en centimes. */
  readonly amount: Centimes;
  readonly currency: Currency;
}

export function money(amount: Centimes): MoneyDto {
  return { amount: assertCentimes(amount), currency: CURRENCY };
}

export function assertCentimes(value: number): Centimes {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`Montant invalide : ${value} centimes (entier attendu).`);
  }
  return value;
}

/** Convertit un montant saisi en dinars (ex. "4500", "4 500,50") en centimes. */
export function dinarsToCentimes(input: string | number): Centimes | null {
  const raw = typeof input === 'number' ? String(input) : input;
  const cleaned = raw
    .trim()
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');

  if (cleaned.length === 0) return null;
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;

  // Math.round evite 4500.005 -> 450000.49999
  return Math.round(parsed * CENTIMES_PER_DINAR);
}

export function centimesToDinars(value: Centimes): number {
  return assertCentimes(value) / CENTIMES_PER_DINAR;
}

/** Formatte un montant pour l'affichage : 450000 -> "4 500,00 DA". */
export function formatCentimes(value: Centimes, options?: { withCurrency?: boolean }): string {
  const dinars = centimesToDinars(value);
  const formatted = new Intl.NumberFormat('fr-DZ', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dinars);
  return options?.withCurrency === false ? formatted : `${formatted} DA`;
}

export function sumCentimes(values: readonly Centimes[]): Centimes {
  return values.reduce<Centimes>((total, value) => total + assertCentimes(value), 0);
}

/** Composantes du total d'une commande. */
export interface OrderTotalParts {
  readonly itemsTotalCentimes: Centimes;
  /** Remise commerciale consentie sur l'ensemble de la commande. */
  readonly discountCentimes?: Centimes;
  readonly deliveryFeeCentimes?: Centimes;
  /**
   * Ajustement d'echange (SAV), signe : positif si le client complete,
   * negatif si la boutique rembourse.
   */
  readonly exchangeAmountCentimes?: Centimes;
}

/**
 * Total a encaisser pour une commande.
 *
 * POURQUOI CETTE FONCTION EXISTE
 *   La formule etait ecrite en toutes lettres a deux endroits (creation de
 *   commande, et recalcul depuis le centre de confirmation), et les deux
 *   omettaient `discountCentimes` : la remise de commande etait lue par les
 *   requetes, jamais soustraite. Le champ ne pouvait donc que rester a zero,
 *   et l'aurait fausse le jour ou un ecran aurait commence a l'ecrire.
 *
 *   Une seule fonction rend desormais la formule verifiable en un endroit, et
 *   l'ajout d'une composante — l'echange — impossible a oublier a l'un des
 *   deux appels.
 *
 * ORDRE DES TERMES
 *   Articles moins remise, plus livraison, plus echange. La remise porte sur la
 *   marchandise et non sur le transport : appliquer l'une a l'autre reviendrait
 *   a offrir un port que le transporteur facture quand meme.
 */
export function computeOrderTotal(parts: OrderTotalParts): Centimes {
  const items = assertCentimes(parts.itemsTotalCentimes);
  const discount = assertCentimes(parts.discountCentimes ?? 0);
  const delivery = assertCentimes(parts.deliveryFeeCentimes ?? 0);
  const exchange = assertCentimes(parts.exchangeAmountCentimes ?? 0);

  return items - discount + delivery + exchange;
}

/**
 * Applique un pourcentage a un montant en centimes avec arrondi commercial
 * (arrondi au centime le plus proche, 0.5 arrondi vers le haut).
 */
export function applyPercentage(value: Centimes, percentage: number): Centimes {
  if (!Number.isFinite(percentage)) {
    throw new RangeError(`Pourcentage invalide : ${percentage}`);
  }
  return Math.round(assertCentimes(value) * (percentage / 100));
}

/**
 * Repartit un montant en `parts` portions entieres dont la somme est exactement
 * egale au montant initial (les restes sont distribues sur les premieres parts).
 * Utilise pour ventiler les frais de livraison sur les lignes d'une commande
 * lors du calcul de marge par produit.
 */
export function allocateCentimes(total: Centimes, weights: readonly number[]): Centimes[] {
  assertCentimes(total);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (weights.length === 0) return [];
  if (totalWeight <= 0) {
    // Repartition uniforme si aucun poids exploitable.
    const base = Math.trunc(total / weights.length);
    const result = weights.map(() => base);
    let remainder = total - base * weights.length;
    for (let i = 0; remainder !== 0 && i < result.length; i += 1) {
      const step = remainder > 0 ? 1 : -1;
      result[i] = (result[i] ?? 0) + step;
      remainder -= step;
    }
    return result;
  }

  const raw = weights.map((w) => (total * w) / totalWeight);
  const floored = raw.map((v) => Math.trunc(v));
  let remainder = total - floored.reduce((sum, v) => sum + v, 0);

  // Distribue le reste sur les parts ayant la plus grande fraction perdue.
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.trunc(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const { index } of order) {
    if (remainder === 0) break;
    const step = remainder > 0 ? 1 : -1;
    floored[index] = (floored[index] ?? 0) + step;
    remainder -= step;
  }

  return floored;
}
