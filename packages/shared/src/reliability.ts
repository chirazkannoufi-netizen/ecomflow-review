/**
 * Score de fiabilite client — Addendum §32.
 *
 * Objectif : aider l'agent de confirmation a prioriser sa file et signaler les
 * clients dont l'historique reel montre un risque eleve de non-livraison.
 *
 * PRINCIPES NON NEGOCIABLES (rappeles dans le prompt produit §20) :
 *  1. le score est calcule a partir de l'historique REEL des commandes du tenant,
 *     jamais d'une donnee inventee ni d'un signal externe ;
 *  2. le score est EXPLICABLE : chaque facteur contributeur est retourne avec son
 *     impact en points, afin d'etre affiche dans la fiche client ;
 *  3. le score N'EST PAS une regle de blocage automatique. Il produit une
 *     recommandation ; la decision de durcir le parcours (confirmation WhatsApp
 *     obligatoire, validation manager) est une option activee explicitement par
 *     la boutique via `ReliabilityPolicy` ;
 *  4. en dessous d'un historique minimal, le score vaut UNKNOWN et n'entraine
 *     aucune restriction : un nouveau client n'est jamais penalise.
 *
 * Le calcul est une fonction pure : il est integralement teste unitairement et
 * ne depend d'aucune horloge implicite (`now` est injecte).
 */

import type { ReliabilityTier } from './enums';

/** Agregats issus de l'historique reel des commandes d'un client (par tenant). */
export interface CustomerOrderStats {
  /** Commandes non archivees, tous statuts confondus. */
  readonly totalOrders: number;
  /** Commandes confirmees (passees au moins une fois par CONFIRMED). */
  readonly confirmedOrders: number;
  /** Commandes effectivement livrees. */
  readonly deliveredOrders: number;
  /** Commandes refusees a la livraison. */
  readonly refusedOrders: number;
  /** Commandes retournees. */
  readonly returnedOrders: number;
  /** Commandes annulees apres confirmation (annulation client). */
  readonly cancelledOrders: number;
  /** Commandes ayant echoue faute de contact (NO_ANSWER / WRONG_NUMBER final). */
  readonly unreachableOrders: number;
  /**
   * Nombre d'issues negatives consecutives les plus recentes
   * (REFUSED / RETURNED / CANCELLED cote client).
   */
  readonly consecutiveFailures: number;
  /** Date de la derniere commande, ou null si aucune. */
  readonly lastOrderAt: Date | null;
}

/** Seuils configurables par boutique (Addendum §32 : « seuils configurables »). */
export interface ReliabilityPolicy {
  /** Nombre minimal de commandes ABOUTIES avant de produire un score. */
  readonly minHistory: number;
  /** Score minimal pour etre classe RELIABLE. */
  readonly reliableThreshold: number;
  /** Score minimal pour etre classe WATCH (en dessous : AT_RISK). */
  readonly watchThreshold: number;
  /** Nombre d'echecs consecutifs a partir duquel le client bascule AT_RISK. */
  readonly consecutiveFailureLimit: number;
  /** Anciennete (en jours) au-dela de laquelle l'historique est attenue. */
  readonly stalenessDays: number;
  /** Actions recommandees lorsque le client est AT_RISK. */
  readonly atRiskActions: readonly ReliabilityAction[];
}

export const RELIABILITY_ACTIONS = [
  'REQUIRE_WHATSAPP_CONFIRMATION',
  'REQUIRE_MANAGER_APPROVAL',
  'REQUIRE_DEPOSIT',
  'DEPRIORITIZE_IN_QUEUE',
] as const;
export type ReliabilityAction = (typeof RELIABILITY_ACTIONS)[number];

export const DEFAULT_RELIABILITY_POLICY: ReliabilityPolicy = {
  minHistory: 3,
  reliableThreshold: 70,
  watchThreshold: 45,
  consecutiveFailureLimit: 3,
  stalenessDays: 365,
  atRiskActions: ['REQUIRE_WHATSAPP_CONFIRMATION', 'DEPRIORITIZE_IN_QUEUE'],
};

export const RELIABILITY_FACTOR_CODES = [
  'DELIVERY_RATE',
  'REFUSAL_RATE',
  'RETURN_RATE',
  'CANCELLATION_RATE',
  'UNREACHABLE_RATE',
  'CONSECUTIVE_FAILURES',
  'VOLUME_BONUS',
  'STALE_HISTORY',
  'INSUFFICIENT_HISTORY',
] as const;
export type ReliabilityFactorCode = (typeof RELIABILITY_FACTOR_CODES)[number];

export interface ReliabilityFactor {
  readonly code: ReliabilityFactorCode;
  /** Libelle affichable dans la fiche client. */
  readonly label: string;
  /** Impact en points sur le score (positif ou negatif). */
  readonly impact: number;
  /** Detail chiffre a l'origine du facteur. */
  readonly detail: string;
}

export interface ReliabilityAssessment {
  /** Score 0-100. Vaut `null` lorsque l'historique est insuffisant. */
  readonly score: number | null;
  readonly tier: ReliabilityTier;
  /** Facteurs ordonnes par impact absolu decroissant. */
  readonly factors: readonly ReliabilityFactor[];
  /** Actions recommandees, jamais appliquees automatiquement par ce module. */
  readonly recommendedActions: readonly ReliabilityAction[];
  /** Nombre de commandes abouties prises en compte. */
  readonly consideredOutcomes: number;
}

/**
 * Score de depart d'un client sans signal, avant application des facteurs.
 *
 * Calibrage : BASE_SCORE + DELIVERY_WEIGHT = 90, ce qui laisse volontairement
 * de la marge sous le plafond de 100 pour que le bonus de volume differencie
 * encore un client a 3 livraisons d'un client a 20 livraisons. Un score qui
 * sature a 100 des la premiere commande reussie ne serait plus informatif.
 */
const BASE_SCORE = 45;

/** Poids maximal du taux de livraison, contributeur principal du score. */
const DELIVERY_WEIGHT = 45;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator;
}

function pct(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/**
 * Calcule le score de fiabilite d'un client.
 *
 * @param stats agregats reels issus de la base, pour un tenant donne
 * @param policy seuils de la boutique
 * @param now horloge injectee (permet des tests deterministes)
 */
export function assessCustomerReliability(
  stats: CustomerOrderStats,
  policy: ReliabilityPolicy = DEFAULT_RELIABILITY_POLICY,
  now: Date = new Date(),
): ReliabilityAssessment {
  const outcomes =
    stats.deliveredOrders +
    stats.refusedOrders +
    stats.returnedOrders +
    stats.cancelledOrders +
    stats.unreachableOrders;

  if (outcomes < policy.minHistory) {
    return {
      score: null,
      tier: 'UNKNOWN',
      consideredOutcomes: outcomes,
      recommendedActions: [],
      factors: [
        {
          code: 'INSUFFICIENT_HISTORY',
          label: 'Historique insuffisant',
          impact: 0,
          detail: `${outcomes} commande(s) aboutie(s) sur ${policy.minHistory} requise(s) pour calculer un score.`,
        },
      ],
    };
  }

  const factors: ReliabilityFactor[] = [];

  const deliveryRate = ratio(stats.deliveredOrders, outcomes);
  const refusalRate = ratio(stats.refusedOrders, outcomes);
  const returnRate = ratio(stats.returnedOrders, outcomes);
  const cancellationRate = ratio(stats.cancelledOrders, outcomes);
  const unreachableRate = ratio(stats.unreachableOrders, outcomes);

  // Taux de livraison : contributeur principal, jusqu'a +45 points.
  const deliveryImpact = Math.round(deliveryRate * DELIVERY_WEIGHT);
  factors.push({
    code: 'DELIVERY_RATE',
    label: 'Taux de livraison reussie',
    impact: deliveryImpact,
    detail: `${stats.deliveredOrders}/${outcomes} livrees (${pct(deliveryRate)}).`,
  });

  // Refus a la livraison : le signal le plus couteux en COD.
  if (stats.refusedOrders > 0) {
    const impact = -Math.round(refusalRate * 45);
    factors.push({
      code: 'REFUSAL_RATE',
      label: 'Refus a la livraison',
      impact,
      detail: `${stats.refusedOrders}/${outcomes} refusees (${pct(refusalRate)}).`,
    });
  }

  if (stats.returnedOrders > 0) {
    const impact = -Math.round(returnRate * 30);
    factors.push({
      code: 'RETURN_RATE',
      label: 'Colis retournes',
      impact,
      detail: `${stats.returnedOrders}/${outcomes} retournees (${pct(returnRate)}).`,
    });
  }

  if (stats.cancelledOrders > 0) {
    const impact = -Math.round(cancellationRate * 20);
    factors.push({
      code: 'CANCELLATION_RATE',
      label: 'Annulations apres confirmation',
      impact,
      detail: `${stats.cancelledOrders}/${outcomes} annulees (${pct(cancellationRate)}).`,
    });
  }

  if (stats.unreachableOrders > 0) {
    const impact = -Math.round(unreachableRate * 25);
    factors.push({
      code: 'UNREACHABLE_RATE',
      label: 'Client injoignable',
      impact,
      detail: `${stats.unreachableOrders}/${outcomes} sans contact aboutit (${pct(unreachableRate)}).`,
    });
  }

  // Echecs consecutifs recents : signal fort, plafonne pour rester explicable.
  if (stats.consecutiveFailures > 0) {
    const impact = -Math.min(30, stats.consecutiveFailures * 10);
    factors.push({
      code: 'CONSECUTIVE_FAILURES',
      label: 'Echecs consecutifs recents',
      impact,
      detail: `${stats.consecutiveFailures} issue(s) negative(s) d affilee.`,
    });
  }

  // Bonus de volume : un historique long fiabilise la mesure (max +8).
  if (stats.deliveredOrders >= 5) {
    const impact = Math.min(8, Math.floor(stats.deliveredOrders / 5) * 4);
    factors.push({
      code: 'VOLUME_BONUS',
      label: 'Historique de livraisons consequent',
      impact,
      detail: `${stats.deliveredOrders} livraisons reussies au total.`,
    });
  }

  // Attenuation si l'historique est ancien : on ne juge pas un client sur
  // des donnees perimees.
  let stalenessPenalty = 0;
  if (stats.lastOrderAt) {
    const ageDays = Math.floor((now.getTime() - stats.lastOrderAt.getTime()) / 86_400_000);
    if (ageDays > policy.stalenessDays) {
      stalenessPenalty = 1;
      factors.push({
        code: 'STALE_HISTORY',
        label: 'Historique ancien',
        impact: 0,
        detail: `Derniere commande il y a ${ageDays} jours : score rapproche de la neutralite.`,
      });
    }
  }

  const rawScore = factors.reduce((total, factor) => total + factor.impact, BASE_SCORE);
  let score = clamp(Math.round(rawScore), 0, 100);

  // L'attenuation ramene le score vers 50 (neutre) sans effacer le signal.
  if (stalenessPenalty === 1) {
    score = Math.round((score + 50) / 2);
  }

  const tier = resolveTier(score, stats, policy);

  return {
    score,
    tier,
    consideredOutcomes: outcomes,
    recommendedActions: tier === 'AT_RISK' ? policy.atRiskActions : [],
    factors: [...factors].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
  };
}

function resolveTier(
  score: number,
  stats: CustomerOrderStats,
  policy: ReliabilityPolicy,
): ReliabilityTier {
  // Regle de securite metier : une serie d'echecs consecutifs prime sur le score
  // agrege, sinon un long historique ancien masquerait une degradation recente.
  if (stats.consecutiveFailures >= policy.consecutiveFailureLimit) return 'AT_RISK';
  if (score >= policy.reliableThreshold) return 'RELIABLE';
  if (score >= policy.watchThreshold) return 'WATCH';
  return 'AT_RISK';
}

/**
 * Poids de priorisation de la file de confirmation.
 * Un score eleve remonte dans la file (Addendum §32 : « traiter les clients
 * fiables en premier »), sans jamais exclure un client de la file.
 */
export function reliabilityQueueWeight(assessment: ReliabilityAssessment): number {
  switch (assessment.tier) {
    case 'RELIABLE':
      return 0;
    case 'UNKNOWN':
      return 1;
    case 'WATCH':
      return 2;
    case 'AT_RISK':
      return 3;
  }
}
