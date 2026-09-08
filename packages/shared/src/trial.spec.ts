import {
  assessTrialAbuse,
  computeTrialEnd,
  daysUntil,
  deriveSubscriptionState,
  MS_PER_DAY,
  TRIAL_DURATION_DAYS,
  type SubscriptionSnapshot,
} from './trial';
import { isOperationalSubscription } from './enums';

const T0 = new Date('2026-08-29T10:00:00.000Z');

function snapshot(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    trialStartAt: null,
    trialEndAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelledAt: null,
    suspendedAt: null,
    pastDueSince: null,
    ...overrides,
  };
}

describe('essai gratuit et abonnement', () => {
  describe('duree de l essai', () => {
    it('dure exactement 7 jours', () => {
      expect(TRIAL_DURATION_DAYS).toBe(7);
      const end = computeTrialEnd(T0);
      expect(end.getTime() - T0.getTime()).toBe(7 * MS_PER_DAY);
    });

    it('compte les jours restants en arrondissant vers le haut', () => {
      const end = new Date(T0.getTime() + 2.5 * MS_PER_DAY);
      expect(daysUntil(end, T0)).toBe(3);
    });

    it('ne descend jamais sous zero', () => {
      const past = new Date(T0.getTime() - MS_PER_DAY);
      expect(daysUntil(past, T0)).toBe(0);
    });
  });

  describe('derivation de l etat', () => {
    it('est TRIAL_ACTIVE au premier jour', () => {
      const state = deriveSubscriptionState(
        snapshot({ trialStartAt: T0, trialEndAt: computeTrialEnd(T0) }),
        T0,
      );
      expect(state.status).toBe('TRIAL_ACTIVE');
      expect(state.operational).toBe(true);
      expect(state.trialDaysRemaining).toBe(7);
    });

    it('bascule en TRIAL_ENDING dans les 3 derniers jours', () => {
      const trialEnd = computeTrialEnd(T0);
      const now = new Date(trialEnd.getTime() - 2 * MS_PER_DAY);
      const state = deriveSubscriptionState(snapshot({ trialStartAt: T0, trialEndAt: trialEnd }), now);
      expect(state.status).toBe('TRIAL_ENDING');
      // TRIAL_ENDING est un indicateur d interface : les droits sont conserves.
      expect(state.operational).toBe(true);
    });

    it('bloque l operationnel a J+7', () => {
      const trialEnd = computeTrialEnd(T0);
      const state = deriveSubscriptionState(
        snapshot({ trialStartAt: T0, trialEndAt: trialEnd }),
        new Date(trialEnd.getTime() + 1),
      );
      expect(state.status).toBe('TRIAL_ENDED');
      expect(state.operational).toBe(false);
      expect(state.trialDaysRemaining).toBe(0);
    });

    it('reactive le compte des qu une periode payante couvre la date du jour', () => {
      const trialEnd = computeTrialEnd(T0);
      const now = new Date(trialEnd.getTime() + 5 * MS_PER_DAY);
      const state = deriveSubscriptionState(
        snapshot({
          trialStartAt: T0,
          trialEndAt: trialEnd,
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * MS_PER_DAY),
        }),
        now,
      );
      expect(state.status).toBe('ACTIVE');
      expect(state.operational).toBe(true);
      expect(state.periodDaysRemaining).toBe(30);
    });

    it('expire quand la periode payante est depassee', () => {
      const now = new Date(T0.getTime() + 40 * MS_PER_DAY);
      const state = deriveSubscriptionState(
        snapshot({
          currentPeriodStart: T0,
          currentPeriodEnd: new Date(T0.getTime() + 30 * MS_PER_DAY),
        }),
        now,
      );
      expect(state.status).toBe('EXPIRED');
      expect(state.operational).toBe(false);
    });

    it('maintient l acces en PAST_DUE pendant la periode de grace', () => {
      const state = deriveSubscriptionState(
        snapshot({
          currentPeriodEnd: new Date(T0.getTime() - MS_PER_DAY),
          pastDueSince: new Date(T0.getTime() - MS_PER_DAY),
        }),
        T0,
      );
      expect(state.status).toBe('PAST_DUE');
      expect(state.operational).toBe(true);
    });

    it('suspend apres la periode de grace', () => {
      const state = deriveSubscriptionState(
        snapshot({ pastDueSince: new Date(T0.getTime() - 10 * MS_PER_DAY) }),
        T0,
      );
      expect(state.status).toBe('SUSPENDED');
      expect(state.operational).toBe(false);
    });

    it('donne la priorite a une suspension administrative', () => {
      const state = deriveSubscriptionState(
        snapshot({
          suspendedAt: new Date(T0.getTime() - MS_PER_DAY),
          currentPeriodEnd: new Date(T0.getTime() + 30 * MS_PER_DAY),
        }),
        T0,
      );
      expect(state.status).toBe('SUSPENDED');
      expect(state.operational).toBe(false);
    });

    it('laisse une resiliation courir jusqu a la fin de la periode payee', () => {
      const state = deriveSubscriptionState(
        snapshot({
          cancelledAt: T0,
          currentPeriodEnd: new Date(T0.getTime() + 10 * MS_PER_DAY),
        }),
        T0,
      );
      expect(state.status).toBe('ACTIVE');
      expect(state.operational).toBe(true);
    });

    it('cloture le compte une fois la periode resiliee terminee', () => {
      const state = deriveSubscriptionState(
        snapshot({ cancelledAt: T0, currentPeriodEnd: new Date(T0.getTime() - MS_PER_DAY) }),
        T0,
      );
      expect(state.status).toBe('CANCELLED');
      expect(state.operational).toBe(false);
    });

    it('expire un compte sans aucune donnee d abonnement', () => {
      const state = deriveSubscriptionState(snapshot(), T0);
      expect(state.status).toBe('EXPIRED');
      expect(state.operational).toBe(false);
    });

    it('reste coherent avec la liste des statuts operationnels', () => {
      const cases: SubscriptionSnapshot[] = [
        snapshot({ trialStartAt: T0, trialEndAt: computeTrialEnd(T0) }),
        snapshot({ currentPeriodEnd: new Date(T0.getTime() + MS_PER_DAY) }),
        snapshot({ pastDueSince: T0 }),
        snapshot(),
      ];
      for (const input of cases) {
        const state = deriveSubscriptionState(input, T0);
        expect(state.operational).toBe(isOperationalSubscription(state.status));
      }
    });
  });

  describe('prevention de l abus du Trial', () => {
    it('autorise un compte sans signal', () => {
      const result = assessTrialAbuse([]);
      expect(result.decision).toBe('ALLOW');
      expect(result.score).toBe(0);
    });

    it('bloque la reutilisation d un numero deja verifie', () => {
      const result = assessTrialAbuse(['VERIFIED_PHONE_REUSED']);
      expect(result.decision).toBe('BLOCK');
    });

    it('n envoie pas en revue sur une simple collision d IP', () => {
      // Une IP partagee est un signal faible : cybercafe, 4G partagee, NAT operateur.
      const result = assessTrialAbuse(['SAME_IP_RECENT']);
      expect(result.decision).toBe('ALLOW');
    });

    it('envoie en revue manuelle sur un faisceau de signaux faibles', () => {
      const result = assessTrialAbuse(['SAME_IP_RECENT', 'SAME_DEVICE_FINGERPRINT']);
      expect(result.decision).toBe('MANUAL_REVIEW');
    });

    it('deduplique les signaux repetes', () => {
      const result = assessTrialAbuse(['SAME_IP_RECENT', 'SAME_IP_RECENT', 'SAME_IP_RECENT']);
      expect(result.signals).toEqual(['SAME_IP_RECENT']);
      expect(result.score).toBe(25);
    });

    it('explique chaque signal retenu', () => {
      const result = assessTrialAbuse(['RAPID_TENANT_CREATION', 'EMAIL_LOCAL_PART_REUSED']);
      expect(result.explanation).toHaveLength(2);
      for (const line of result.explanation) {
        expect(line).toMatch(/\(\+\d+\)$/);
      }
    });
  });
});
