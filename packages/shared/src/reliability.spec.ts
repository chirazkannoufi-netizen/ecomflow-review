import {
  assessCustomerReliability,
  DEFAULT_RELIABILITY_POLICY,
  reliabilityQueueWeight,
  type CustomerOrderStats,
} from './reliability';

const NOW = new Date('2026-08-29T10:00:00.000Z');

function stats(overrides: Partial<CustomerOrderStats> = {}): CustomerOrderStats {
  return {
    totalOrders: 0,
    confirmedOrders: 0,
    deliveredOrders: 0,
    refusedOrders: 0,
    returnedOrders: 0,
    cancelledOrders: 0,
    unreachableOrders: 0,
    consecutiveFailures: 0,
    lastOrderAt: NOW,
    ...overrides,
  };
}

describe('score de fiabilite client', () => {
  describe('historique insuffisant', () => {
    it('ne penalise jamais un nouveau client', () => {
      const result = assessCustomerReliability(stats(), DEFAULT_RELIABILITY_POLICY, NOW);
      expect(result.tier).toBe('UNKNOWN');
      expect(result.score).toBeNull();
      expect(result.recommendedActions).toEqual([]);
    });

    it('explique pourquoi aucun score n est produit', () => {
      const result = assessCustomerReliability(
        stats({ totalOrders: 2, deliveredOrders: 2 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(result.tier).toBe('UNKNOWN');
      expect(result.factors[0]?.code).toBe('INSUFFICIENT_HISTORY');
      expect(result.factors[0]?.detail).toContain('3');
    });
  });

  describe('client fiable', () => {
    it('classe RELIABLE un client toujours livre', () => {
      const result = assessCustomerReliability(
        stats({ totalOrders: 6, confirmedOrders: 6, deliveredOrders: 6 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(result.tier).toBe('RELIABLE');
      expect(result.score).toBeGreaterThanOrEqual(DEFAULT_RELIABILITY_POLICY.reliableThreshold);
      expect(result.recommendedActions).toEqual([]);
    });

    it('valorise un historique volumineux', () => {
      const small = assessCustomerReliability(
        stats({ totalOrders: 3, deliveredOrders: 3 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      const large = assessCustomerReliability(
        stats({ totalOrders: 10, deliveredOrders: 10 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(large.score as number).toBeGreaterThan(small.score as number);
      expect(large.factors.map((f) => f.code)).toContain('VOLUME_BONUS');
    });
  });

  describe('client a risque', () => {
    it('classe AT_RISK un client majoritairement en refus', () => {
      const result = assessCustomerReliability(
        stats({ totalOrders: 5, deliveredOrders: 1, refusedOrders: 4, consecutiveFailures: 2 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(result.tier).toBe('AT_RISK');
      expect(result.recommendedActions).toContain('REQUIRE_WHATSAPP_CONFIRMATION');
    });

    it('fait primer une serie d echecs recents sur un bon historique global', () => {
      // 20 livraisons anciennes, mais 3 echecs consecutifs recents.
      const result = assessCustomerReliability(
        stats({
          totalOrders: 23,
          deliveredOrders: 20,
          refusedOrders: 3,
          consecutiveFailures: 3,
        }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(result.tier).toBe('AT_RISK');
    });

    it('borne le score entre 0 et 100', () => {
      const worst = assessCustomerReliability(
        stats({
          totalOrders: 10,
          refusedOrders: 5,
          returnedOrders: 3,
          cancelledOrders: 2,
          unreachableOrders: 0,
          consecutiveFailures: 10,
        }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(worst.score).toBeGreaterThanOrEqual(0);
      expect(worst.score).toBeLessThanOrEqual(100);
    });
  });

  describe('explicabilite', () => {
    it('retourne un facteur par signal detecte', () => {
      const result = assessCustomerReliability(
        stats({
          totalOrders: 6,
          deliveredOrders: 3,
          refusedOrders: 1,
          returnedOrders: 1,
          cancelledOrders: 1,
          consecutiveFailures: 1,
        }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      const codes = result.factors.map((f) => f.code);
      expect(codes).toContain('DELIVERY_RATE');
      expect(codes).toContain('REFUSAL_RATE');
      expect(codes).toContain('RETURN_RATE');
      expect(codes).toContain('CANCELLATION_RATE');
      expect(codes).toContain('CONSECUTIVE_FAILURES');
    });

    it('trie les facteurs par impact absolu decroissant', () => {
      const result = assessCustomerReliability(
        stats({ totalOrders: 8, deliveredOrders: 4, refusedOrders: 4, consecutiveFailures: 1 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      const impacts = result.factors.map((f) => Math.abs(f.impact));
      const sorted = [...impacts].sort((a, b) => b - a);
      expect(impacts).toEqual(sorted);
    });

    it('chiffre chaque facteur', () => {
      const result = assessCustomerReliability(
        stats({ totalOrders: 4, deliveredOrders: 2, refusedOrders: 2 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      for (const factor of result.factors) {
        expect(factor.detail.length).toBeGreaterThan(0);
        expect(factor.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('attenuation d un historique ancien', () => {
    it('rapproche le score de la neutralite', () => {
      const old = new Date(NOW.getTime() - 500 * 86_400_000);
      const recent = assessCustomerReliability(
        stats({ totalOrders: 5, deliveredOrders: 5 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      const stale = assessCustomerReliability(
        stats({ totalOrders: 5, deliveredOrders: 5, lastOrderAt: old }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(stale.score as number).toBeLessThan(recent.score as number);
      expect(stale.factors.map((f) => f.code)).toContain('STALE_HISTORY');
    });
  });

  describe('seuils configurables par boutique', () => {
    it('respecte une politique plus stricte', () => {
      const strict = { ...DEFAULT_RELIABILITY_POLICY, reliableThreshold: 95, watchThreshold: 90 };
      const result = assessCustomerReliability(
        stats({ totalOrders: 4, deliveredOrders: 4 }),
        strict,
        NOW,
      );
      expect(result.tier).not.toBe('RELIABLE');
    });

    it('respecte une limite d echecs consecutifs plus permissive', () => {
      const history = stats({
        totalOrders: 18,
        deliveredOrders: 15,
        refusedOrders: 3,
        consecutiveFailures: 3,
      });

      // Politique par defaut : 3 echecs consecutifs declenchent la regle dure.
      expect(assessCustomerReliability(history, DEFAULT_RELIABILITY_POLICY, NOW).tier).toBe(
        'AT_RISK',
      );

      // Politique permissive : la regle dure ne s applique plus, et le score
      // agrege (bon historique) reprend la main.
      const permissive = { ...DEFAULT_RELIABILITY_POLICY, consecutiveFailureLimit: 10 };
      expect(assessCustomerReliability(history, permissive, NOW).tier).not.toBe('AT_RISK');
    });
  });

  describe('priorisation de la file', () => {
    it('place les clients fiables en tete', () => {
      const reliable = assessCustomerReliability(
        stats({ totalOrders: 5, deliveredOrders: 5 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      const risky = assessCustomerReliability(
        stats({ totalOrders: 5, refusedOrders: 5, consecutiveFailures: 5 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(reliabilityQueueWeight(reliable)).toBeLessThan(reliabilityQueueWeight(risky));
    });

    it('ne place jamais un client a risque hors de la file', () => {
      const risky = assessCustomerReliability(
        stats({ totalOrders: 5, refusedOrders: 5, consecutiveFailures: 5 }),
        DEFAULT_RELIABILITY_POLICY,
        NOW,
      );
      expect(reliabilityQueueWeight(risky)).toBeLessThanOrEqual(3);
    });
  });
});
