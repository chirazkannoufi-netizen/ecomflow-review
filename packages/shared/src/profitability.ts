/**
 * Calculs de rentabilite et de pertes — Addendum §33, V2 §20.
 *
 * Toutes les formules sont explicites et documentees ici, en un seul endroit,
 * afin que le dashboard « Pertes & Rentabilite » soit auditable par le
 * commercant : chaque montant affiche doit pouvoir etre retrouve a la main.
 *
 * Conventions :
 *  - montants en centimes (voir money.ts) ;
 *  - le CHIFFRE D'AFFAIRES n'est reconnu qu'a la LIVRAISON (modele COD : tant
 *    que le colis n'est pas remis, aucun encaissement n'a eu lieu) ;
 *  - le COUT PRODUIT (COGS) n'est constate que si la marchandise est
 *    definitivement sortie du stock : un retour remis en stock n'est pas une
 *    perte de marchandise, seuls les frais de transport sont perdus ;
 *  - une commande annulee avant expedition ne genere ni cout ni perte
 *    monetaire ; elle est comptabilisee separement en « manque a gagner »
 *    (valorisation au prix de vente), clairement distinguee de la perte reelle.
 */

import type { OrderStatus } from './order-status';
import type { StockDecision } from './enums';
import { sumCentimes, type Centimes } from './money';

export interface ProfitabilityLineInput {
  readonly quantity: number;
  /** Prix de vente unitaire facture au client. */
  readonly unitPriceCentimes: Centimes;
  /**
   * Prix d'achat unitaire au moment de la commande (fige sur la ligne).
   * `null` si le commercant n'a pas renseigne de prix d'achat : la marge
   * produit est alors marquee comme incomplete plutot qu'estimee a zero.
   */
  readonly unitPurchasePriceCentimes: Centimes | null;
  /** Remise appliquee sur la ligne, en centimes. */
  readonly discountCentimes?: Centimes;
}

export interface ProfitabilityOrderInput {
  readonly status: OrderStatus;
  readonly lines: readonly ProfitabilityLineInput[];
  /** Frais de livraison factures au client. */
  readonly deliveryFeeChargedCentimes: Centimes;
  /** Cout reel facture par le transporteur pour l'aller. */
  readonly carrierCostCentimes: Centimes;
  /** Cout du retour facture par le transporteur, le cas echeant. */
  readonly returnCostCentimes: Centimes;
  /**
   * Decision de stock appliquee au retour. `RESTOCK` = marchandise recuperee,
   * `WRITE_OFF` = marchandise perdue (le COGS devient une perte seche).
   */
  readonly returnStockDecision: StockDecision | null;
}

export interface ProfitabilityResult {
  /** Chiffre d'affaires reconnu (0 tant que la commande n'est pas livree). */
  readonly recognizedRevenueCentimes: Centimes;
  /** Cout des marchandises effectivement sorties du stock. */
  readonly cogsCentimes: Centimes;
  /** Couts de transport reellement engages (aller + retour). */
  readonly shippingCostCentimes: Centimes;
  /** Marge brute = CA reconnu - COGS. */
  readonly grossMarginCentimes: Centimes;
  /** Resultat net = marge brute - couts de transport. Negatif = perte. */
  readonly netResultCentimes: Centimes;
  /** Perte reelle (montant sorti de la tresorerie sans contrepartie). */
  readonly realizedLossCentimes: Centimes;
  /** Manque a gagner : CA qui n'a pas ete realise, valorise au prix de vente. */
  readonly opportunityLossCentimes: Centimes;
  /** Vrai si au moins une ligne n'a pas de prix d'achat renseigne. */
  readonly cogsIncomplete: boolean;
  /** Vrai si la commande est encore en cours : les montants sont provisoires. */
  readonly pending: boolean;
}

/** Statuts pour lesquels la marchandise a definitivement quitte le stock. */
const REVENUE_RECOGNIZED_STATUSES: readonly OrderStatus[] = ['DELIVERED'];

/** Statuts d'echec APRES expedition : les frais de transport sont perdus. */
const POST_SHIPMENT_FAILURE_STATUSES: readonly OrderStatus[] = ['REFUSED', 'RETURNED'];

/** Statuts d'echec AVANT expedition : aucun cout engage. */
const PRE_SHIPMENT_FAILURE_STATUSES: readonly OrderStatus[] = ['CANCELLED'];

/** Statuts encore en cours : le resultat est provisoire. */
const IN_PROGRESS_STATUSES: readonly OrderStatus[] = [
  'NEW',
  'TO_CONFIRM',
  'NO_ANSWER',
  'CALL_BACK',
  'POSTPONED',
  'WRONG_NUMBER',
  'CONFIRMED',
  'IN_PREPARATION',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_DELIVERY',
];

function lineNet(line: ProfitabilityLineInput): Centimes {
  return line.quantity * line.unitPriceCentimes - (line.discountCentimes ?? 0);
}

/** Total marchandise facture au client, remises deduites. */
export function computeItemsTotal(lines: readonly ProfitabilityLineInput[]): Centimes {
  return sumCentimes(lines.map(lineNet));
}

/** Cout d'achat total des lignes, et indicateur de donnee manquante. */
export function computeCogs(lines: readonly ProfitabilityLineInput[]): {
  cogs: Centimes;
  incomplete: boolean;
} {
  let cogs = 0;
  let incomplete = false;
  for (const line of lines) {
    if (line.unitPurchasePriceCentimes === null) {
      incomplete = true;
      continue;
    }
    cogs += line.quantity * line.unitPurchasePriceCentimes;
  }
  return { cogs, incomplete };
}

/**
 * Calcule le resultat economique d'une commande.
 *
 * Formules appliquees, par situation :
 *
 * | Situation                | CA reconnu          | COGS   | Transport        | Perte reelle             |
 * |--------------------------|---------------------|--------|------------------|--------------------------|
 * | LIVREE                   | articles + livraison| oui    | aller            | 0 (si resultat positif)  |
 * | REFUSEE / RETOURNEE      | 0                   | seulement si marchandise perdue | aller + retour | transport + COGS perdu |
 * | ANNULEE avant expedition | 0                   | 0      | 0                | 0 (manque a gagner seul) |
 * | En cours                 | 0                   | 0      | 0                | 0 (provisoire)           |
 */
export function computeOrderProfitability(order: ProfitabilityOrderInput): ProfitabilityResult {
  const itemsTotal = computeItemsTotal(order.lines);
  const { cogs: fullCogs, incomplete } = computeCogs(order.lines);
  const pending = IN_PROGRESS_STATUSES.includes(order.status);

  if (REVENUE_RECOGNIZED_STATUSES.includes(order.status)) {
    const revenue = itemsTotal + order.deliveryFeeChargedCentimes;
    const shipping = order.carrierCostCentimes;
    const grossMargin = revenue - fullCogs;
    const netResult = grossMargin - shipping;
    return {
      recognizedRevenueCentimes: revenue,
      cogsCentimes: fullCogs,
      shippingCostCentimes: shipping,
      grossMarginCentimes: grossMargin,
      netResultCentimes: netResult,
      realizedLossCentimes: netResult < 0 ? -netResult : 0,
      opportunityLossCentimes: 0,
      cogsIncomplete: incomplete,
      pending: false,
    };
  }

  if (POST_SHIPMENT_FAILURE_STATUSES.includes(order.status)) {
    const shipping = order.carrierCostCentimes + order.returnCostCentimes;
    // La marchandise n'est perdue que si elle n'a pas ete remise en stock.
    const goodsLost = order.returnStockDecision === 'WRITE_OFF';
    const cogs = goodsLost ? fullCogs : 0;
    // `0 - x` plutot que `-x` : evite de produire -0, qui casse les
    // comparaisons strictes et s affiche comme "-0" dans les exports.
    const netResult = 0 - (shipping + cogs);
    return {
      recognizedRevenueCentimes: 0,
      cogsCentimes: cogs,
      shippingCostCentimes: shipping,
      grossMarginCentimes: 0 - cogs,
      netResultCentimes: netResult,
      realizedLossCentimes: shipping + cogs,
      opportunityLossCentimes: itemsTotal + order.deliveryFeeChargedCentimes,
      cogsIncomplete: goodsLost ? incomplete : false,
      pending: false,
    };
  }

  if (PRE_SHIPMENT_FAILURE_STATUSES.includes(order.status)) {
    // Une annulation peut survenir apres expedition dans de rares cas ;
    // on ne comptabilise alors que les couts transport reellement engages.
    const shipping = order.carrierCostCentimes + order.returnCostCentimes;
    return {
      recognizedRevenueCentimes: 0,
      cogsCentimes: 0,
      shippingCostCentimes: shipping,
      grossMarginCentimes: 0,
      netResultCentimes: 0 - shipping,
      realizedLossCentimes: shipping,
      opportunityLossCentimes: itemsTotal + order.deliveryFeeChargedCentimes,
      cogsIncomplete: false,
      pending: false,
    };
  }

  return {
    recognizedRevenueCentimes: 0,
    cogsCentimes: 0,
    shippingCostCentimes: 0,
    grossMarginCentimes: 0,
    netResultCentimes: 0,
    realizedLossCentimes: 0,
    opportunityLossCentimes: 0,
    cogsIncomplete: incomplete,
    pending,
  };
}

export interface ProfitabilityAggregate {
  readonly orders: number;
  readonly recognizedRevenueCentimes: Centimes;
  readonly cogsCentimes: Centimes;
  readonly shippingCostCentimes: Centimes;
  readonly grossMarginCentimes: Centimes;
  readonly netResultCentimes: Centimes;
  readonly realizedLossCentimes: Centimes;
  readonly opportunityLossCentimes: Centimes;
  /** Part des commandes dont le cout produit est incomplet (0-1). */
  readonly cogsCompletenessRatio: number;
}

export function aggregateProfitability(
  results: readonly ProfitabilityResult[],
): ProfitabilityAggregate {
  const complete = results.filter((r) => !r.cogsIncomplete).length;
  return {
    orders: results.length,
    recognizedRevenueCentimes: sumCentimes(results.map((r) => r.recognizedRevenueCentimes)),
    cogsCentimes: sumCentimes(results.map((r) => r.cogsCentimes)),
    shippingCostCentimes: sumCentimes(results.map((r) => r.shippingCostCentimes)),
    grossMarginCentimes: sumCentimes(results.map((r) => r.grossMarginCentimes)),
    netResultCentimes: sumCentimes(results.map((r) => r.netResultCentimes)),
    realizedLossCentimes: sumCentimes(results.map((r) => r.realizedLossCentimes)),
    opportunityLossCentimes: sumCentimes(results.map((r) => r.opportunityLossCentimes)),
    cogsCompletenessRatio: results.length === 0 ? 1 : complete / results.length,
  };
}

/**
 * Marge nette en pourcentage du CA reconnu. Retourne `null` si aucun CA n'a
 * ete reconnu sur la periode (evite une division par zero affichee comme 0 %).
 */
export function netMarginPercentage(aggregate: ProfitabilityAggregate): number | null {
  if (aggregate.recognizedRevenueCentimes <= 0) return null;
  return (aggregate.netResultCentimes / aggregate.recognizedRevenueCentimes) * 100;
}
