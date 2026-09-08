/**
 * Regles de l'essai gratuit et de l'abonnement — V1 §21, V2 §7, Addendum §38.
 *
 * REGLE FONDAMENTALE : l'etat d'abonnement est calcule cote SERVEUR a partir de
 * dates persistees, jamais deduit du client. Ce module contient la fonction pure
 * de derivation d'etat ; le backend l'appelle avec l'horloge serveur, et les
 * jobs `trial-expiration` / `subscription-check` persistent le resultat.
 */

import type { SubscriptionStatus } from './enums';

/** Duree de l'essai gratuit, en jours. Fixee par le cahier des charges. */
export const TRIAL_DURATION_DAYS = 7;

/** Fenetre (en jours avant expiration) durant laquelle l'UI alerte le commercant. */
export const TRIAL_ENDING_WINDOW_DAYS = 3;

/** Jours d'alerte : notifications a J-3, J-1 et le jour de l'expiration (V1 §21). */
export const TRIAL_REMINDER_DAYS_BEFORE: readonly number[] = [3, 1, 0];

/**
 * Periode de grace apres un echec de paiement, pendant laquelle le compte reste
 * operationnel en PAST_DUE. Au-dela, il bascule en SUSPENDED.
 */
export const PAST_DUE_GRACE_DAYS = 3;

/**
 * Duree de conservation des donnees apres expiration, avant anonymisation.
 * Configurable par la plateforme ; cette valeur est le defaut (V1 §21, V2 §31).
 */
export const DEFAULT_DATA_RETENTION_DAYS_AFTER_EXPIRY = 90;

export const MS_PER_DAY = 86_400_000;

export interface SubscriptionSnapshot {
  readonly trialStartAt: Date | null;
  readonly trialEndAt: Date | null;
  /** Debut de la periode payante en cours. */
  readonly currentPeriodStart: Date | null;
  /** Fin de la periode payante en cours. */
  readonly currentPeriodEnd: Date | null;
  /** Date de resiliation demandee par le commercant. */
  readonly cancelledAt: Date | null;
  /** Suspension administrative decidee par la plateforme. */
  readonly suspendedAt: Date | null;
  /** Date du dernier echec de paiement non regularise. */
  readonly pastDueSince: Date | null;
}

export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  /** Vrai si les fonctionnalites operationnelles payantes sont accessibles. */
  readonly operational: boolean;
  /** Jours restants avant la fin de l'essai (null hors essai). */
  readonly trialDaysRemaining: number | null;
  /** Jours restants avant la fin de la periode payante (null hors abonnement). */
  readonly periodDaysRemaining: number | null;
  /** Explication lisible, affichee dans le bandeau d'abonnement. */
  readonly reason: string;
}

/** Calcule la date de fin d'essai a partir de sa date de debut. */
export function computeTrialEnd(trialStartAt: Date): Date {
  return new Date(trialStartAt.getTime() + TRIAL_DURATION_DAYS * MS_PER_DAY);
}

/** Nombre de jours entiers restants avant `target`, borne a 0. */
export function daysUntil(target: Date, now: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / MS_PER_DAY));
}

/**
 * Derive l'etat d'abonnement d'un tenant.
 *
 * Ordre de priorite des regles (du plus contraignant au moins contraignant) :
 *  1. suspension administrative ;
 *  2. resiliation effective ;
 *  3. abonnement payant en cours de validite ;
 *  4. impaye dans la periode de grace ;
 *  5. essai gratuit en cours ;
 *  6. tout le reste : expire.
 */
export function deriveSubscriptionState(
  snapshot: SubscriptionSnapshot,
  now: Date = new Date(),
): SubscriptionState {
  if (snapshot.suspendedAt && snapshot.suspendedAt.getTime() <= now.getTime()) {
    return {
      status: 'SUSPENDED',
      operational: false,
      trialDaysRemaining: null,
      periodDaysRemaining: null,
      reason: 'Compte suspendu par l administration de la plateforme.',
    };
  }

  const periodActive =
    snapshot.currentPeriodEnd !== null && snapshot.currentPeriodEnd.getTime() > now.getTime();

  if (snapshot.cancelledAt && snapshot.cancelledAt.getTime() <= now.getTime() && !periodActive) {
    return {
      status: 'CANCELLED',
      operational: false,
      trialDaysRemaining: null,
      periodDaysRemaining: null,
      reason: 'Abonnement resilie.',
    };
  }

  if (snapshot.pastDueSince) {
    const graceEnd = new Date(snapshot.pastDueSince.getTime() + PAST_DUE_GRACE_DAYS * MS_PER_DAY);
    if (graceEnd.getTime() > now.getTime()) {
      return {
        status: 'PAST_DUE',
        operational: true,
        trialDaysRemaining: null,
        periodDaysRemaining: snapshot.currentPeriodEnd
          ? daysUntil(snapshot.currentPeriodEnd, now)
          : null,
        reason: `Paiement en retard. Acces maintenu jusqu au ${graceEnd.toISOString().slice(0, 10)}.`,
      };
    }
    return {
      status: 'SUSPENDED',
      operational: false,
      trialDaysRemaining: null,
      periodDaysRemaining: null,
      reason: 'Paiement non regularise apres la periode de grace.',
    };
  }

  if (periodActive) {
    // `periodActive` garantit deja que la date n'est pas nulle : TypeScript
    // le deduit du predicat, aucune assertion n'est necessaire.
    const remaining = daysUntil(snapshot.currentPeriodEnd, now);
    return {
      status: 'ACTIVE',
      operational: true,
      trialDaysRemaining: null,
      periodDaysRemaining: remaining,
      reason: `Abonnement actif, ${remaining} jour(s) restant(s).`,
    };
  }

  if (snapshot.trialEndAt) {
    const trialActive = snapshot.trialEndAt.getTime() > now.getTime();
    if (trialActive) {
      const remaining = daysUntil(snapshot.trialEndAt, now);
      const ending = remaining <= TRIAL_ENDING_WINDOW_DAYS;
      return {
        status: ending ? 'TRIAL_ENDING' : 'TRIAL_ACTIVE',
        operational: true,
        trialDaysRemaining: remaining,
        periodDaysRemaining: null,
        reason: ending
          ? `Essai gratuit : ${remaining} jour(s) restant(s). Souscrivez pour ne pas perdre l acces.`
          : `Essai gratuit en cours : ${remaining} jour(s) restant(s).`,
      };
    }
    return {
      status: 'TRIAL_ENDED',
      operational: false,
      trialDaysRemaining: 0,
      periodDaysRemaining: null,
      reason: 'Essai gratuit termine. Un abonnement actif est requis.',
    };
  }

  return {
    status: 'EXPIRED',
    operational: false,
    trialDaysRemaining: null,
    periodDaysRemaining: null,
    reason: 'Aucun essai ni abonnement actif.',
  };
}

// ---------------------------------------------------------------------------
// Prevention de l'abus du Trial — Addendum §38
// ---------------------------------------------------------------------------

/**
 * Signaux exploites pour detecter une reouverture d'essai. Chaque signal porte
 * un poids ; aucun signal seul ne suffit a bloquer un compte (le prompt produit
 * §35 l'interdit explicitement : « ne pas utiliser une seule donnee fragile
 * comme preuve absolue »), a l'exception du numero verifie par OTP qui est,
 * lui, un identifiant fort et unique par tenant.
 */
export const TRIAL_ABUSE_SIGNALS = [
  'VERIFIED_PHONE_REUSED',
  'EMAIL_LOCAL_PART_REUSED',
  'SAME_IP_RECENT',
  'SAME_DEVICE_FINGERPRINT',
  'SAME_PAYMENT_IDENTITY',
  'RAPID_TENANT_CREATION',
] as const;
export type TrialAbuseSignal = (typeof TRIAL_ABUSE_SIGNALS)[number];

export const TRIAL_ABUSE_SIGNAL_WEIGHTS: Record<TrialAbuseSignal, number> = {
  VERIFIED_PHONE_REUSED: 100,
  SAME_PAYMENT_IDENTITY: 70,
  SAME_DEVICE_FINGERPRINT: 45,
  EMAIL_LOCAL_PART_REUSED: 35,
  SAME_IP_RECENT: 25,
  RAPID_TENANT_CREATION: 30,
};

export const TRIAL_ABUSE_SIGNAL_LABELS: Record<TrialAbuseSignal, string> = {
  VERIFIED_PHONE_REUSED: 'Numero verifie deja utilise pour un autre essai',
  SAME_PAYMENT_IDENTITY: 'Identite de paiement deja associee a un autre compte',
  SAME_DEVICE_FINGERPRINT: 'Meme empreinte d appareil qu un essai recent',
  EMAIL_LOCAL_PART_REUSED: 'Adresse email derivee d une adresse deja utilisee',
  SAME_IP_RECENT: 'Meme adresse IP qu un essai recent',
  RAPID_TENANT_CREATION: 'Plusieurs boutiques creees sur une fenetre courte',
};

/** Fenetre d'observation des signaux techniques, en jours. */
export const TRIAL_ABUSE_WINDOW_DAYS = 30;

/** Au-dela de ce score, l'essai n'est pas accorde automatiquement. */
export const TRIAL_ABUSE_BLOCK_THRESHOLD = 100;

/** Au-dela de ce score, le tenant part en revue manuelle du Super Admin. */
export const TRIAL_ABUSE_REVIEW_THRESHOLD = 50;

export type TrialAbuseDecision = 'ALLOW' | 'MANUAL_REVIEW' | 'BLOCK';

export interface TrialAbuseAssessment {
  readonly score: number;
  readonly decision: TrialAbuseDecision;
  readonly signals: readonly TrialAbuseSignal[];
  readonly explanation: readonly string[];
}

/**
 * Evalue le risque d'abus du Trial a partir des signaux detectes.
 * Fonction pure et explicable : la liste des signaux et leur poids sont
 * retournes pour affichage dans la file de revue du Super Admin.
 */
export function assessTrialAbuse(signals: readonly TrialAbuseSignal[]): TrialAbuseAssessment {
  const unique = Array.from(new Set(signals));
  const score = unique.reduce((total, signal) => total + TRIAL_ABUSE_SIGNAL_WEIGHTS[signal], 0);

  let decision: TrialAbuseDecision = 'ALLOW';
  if (score >= TRIAL_ABUSE_BLOCK_THRESHOLD) decision = 'BLOCK';
  else if (score >= TRIAL_ABUSE_REVIEW_THRESHOLD) decision = 'MANUAL_REVIEW';

  return {
    score,
    decision,
    signals: unique,
    explanation: unique.map(
      (signal) => `${TRIAL_ABUSE_SIGNAL_LABELS[signal]} (+${TRIAL_ABUSE_SIGNAL_WEIGHTS[signal]})`,
    ),
  };
}
