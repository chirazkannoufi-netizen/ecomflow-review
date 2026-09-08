import {
  aggregateProfitability,
  computeCogs,
  computeItemsTotal,
  computeOrderProfitability,
  netMarginPercentage,
  type ProfitabilityOrderInput,
} from './profitability';

function order(overrides: Partial<ProfitabilityOrderInput> = {}): ProfitabilityOrderInput {
  return {
    status: 'DELIVERED',
    lines: [
      { quantity: 1, unitPriceCentimes: 450_000, unitPurchasePriceCentimes: 250_000 },
    ],
    deliveryFeeChargedCentimes: 50_000,
    carrierCostCentimes: 45_000,
    returnCostCentimes: 0,
    returnStockDecision: null,
    ...overrides,
  };
}

describe('rentabilite et pertes', () => {
  describe('totaux de base', () => {
    it('additionne les lignes, remises deduites', () => {
      const total = computeItemsTotal([
        { quantity: 2, unitPriceCentimes: 100_000, unitPurchasePriceCentimes: null },
        { quantity: 1, unitPriceCentimes: 50_000, unitPurchasePriceCentimes: null, discountCentimes: 10_000 },
      ]);
      expect(total).toBe(240_000);
    });

    it('signale un cout d achat incomplet plutot que de l estimer a zero', () => {
      const result = computeCogs([
        { quantity: 1, unitPriceCentimes: 100_000, unitPurchasePriceCentimes: 60_000 },
        { quantity: 1, unitPriceCentimes: 100_000, unitPurchasePriceCentimes: null },
      ]);
      expect(result.cogs).toBe(60_000);
      expect(result.incomplete).toBe(true);
    });
  });

  describe('commande livree', () => {
    it('reconnait le chiffre d affaires et calcule la marge', () => {
      const result = computeOrderProfitability(order());
      // CA = 4500 + 500 = 5000 DA ; COGS = 2500 ; transport = 450
      expect(result.recognizedRevenueCentimes).toBe(500_000);
      expect(result.cogsCentimes).toBe(250_000);
      expect(result.shippingCostCentimes).toBe(45_000);
      expect(result.grossMarginCentimes).toBe(250_000);
      expect(result.netResultCentimes).toBe(205_000);
      expect(result.realizedLossCentimes).toBe(0);
      expect(result.opportunityLossCentimes).toBe(0);
    });

    it('signale une livraison a perte', () => {
      const result = computeOrderProfitability(
        order({
          lines: [{ quantity: 1, unitPriceCentimes: 100_000, unitPurchasePriceCentimes: 120_000 }],
          deliveryFeeChargedCentimes: 0,
          carrierCostCentimes: 45_000,
        }),
      );
      expect(result.netResultCentimes).toBe(-65_000);
      expect(result.realizedLossCentimes).toBe(65_000);
    });
  });

  describe('commande retournee', () => {
    it('ne compte aucun CA et impute l aller-retour transporteur', () => {
      const result = computeOrderProfitability(
        order({ status: 'RETURNED', returnCostCentimes: 30_000, returnStockDecision: 'RESTOCK' }),
      );
      expect(result.recognizedRevenueCentimes).toBe(0);
      expect(result.shippingCostCentimes).toBe(75_000);
      expect(result.realizedLossCentimes).toBe(75_000);
      // Marchandise remise en stock : pas de perte de COGS.
      expect(result.cogsCentimes).toBe(0);
    });

    it('impute la marchandise lorsqu elle est perdue', () => {
      const result = computeOrderProfitability(
        order({ status: 'RETURNED', returnCostCentimes: 30_000, returnStockDecision: 'WRITE_OFF' }),
      );
      expect(result.cogsCentimes).toBe(250_000);
      expect(result.realizedLossCentimes).toBe(325_000);
    });

    it('valorise le manque a gagner au prix de vente', () => {
      const result = computeOrderProfitability(
        order({ status: 'REFUSED', returnCostCentimes: 30_000, returnStockDecision: 'RESTOCK' }),
      );
      expect(result.opportunityLossCentimes).toBe(500_000);
    });
  });

  describe('commande annulee avant expedition', () => {
    it('ne genere aucune perte reelle', () => {
      const result = computeOrderProfitability(
        order({ status: 'CANCELLED', carrierCostCentimes: 0, returnCostCentimes: 0 }),
      );
      expect(result.realizedLossCentimes).toBe(0);
      expect(result.netResultCentimes).toBe(0);
      // Le manque a gagner reste visible, distinct de la perte reelle.
      expect(result.opportunityLossCentimes).toBe(500_000);
    });

    it('impute les frais deja engages si le colis avait ete cree', () => {
      const result = computeOrderProfitability(
        order({ status: 'CANCELLED', carrierCostCentimes: 45_000 }),
      );
      expect(result.realizedLossCentimes).toBe(45_000);
    });
  });

  describe('commande en cours', () => {
    it('ne comptabilise rien et se declare provisoire', () => {
      for (const status of ['TO_CONFIRM', 'CONFIRMED', 'SHIPPED', 'IN_DELIVERY'] as const) {
        const result = computeOrderProfitability(order({ status }));
        expect(result.pending).toBe(true);
        expect(result.recognizedRevenueCentimes).toBe(0);
        expect(result.realizedLossCentimes).toBe(0);
      }
    });
  });

  describe('agregation', () => {
    it('somme les resultats et mesure la completude des couts', () => {
      const results = [
        computeOrderProfitability(order()),
        computeOrderProfitability(
          order({ status: 'RETURNED', returnCostCentimes: 30_000, returnStockDecision: 'RESTOCK' }),
        ),
        computeOrderProfitability(
          order({
            lines: [{ quantity: 1, unitPriceCentimes: 100_000, unitPurchasePriceCentimes: null }],
          }),
        ),
      ];
      const aggregate = aggregateProfitability(results);
      expect(aggregate.orders).toBe(3);
      expect(aggregate.recognizedRevenueCentimes).toBe(500_000 + 150_000);
      expect(aggregate.realizedLossCentimes).toBe(75_000);
      expect(aggregate.cogsCompletenessRatio).toBeCloseTo(2 / 3, 5);
    });

    it('retourne null plutot que 0 % quand aucun CA n a ete reconnu', () => {
      const aggregate = aggregateProfitability([
        computeOrderProfitability(order({ status: 'TO_CONFIRM' })),
      ]);
      expect(netMarginPercentage(aggregate)).toBeNull();
    });

    it('calcule la marge nette en pourcentage', () => {
      const aggregate = aggregateProfitability([computeOrderProfitability(order())]);
      expect(netMarginPercentage(aggregate)).toBeCloseTo(41, 0);
    });

    it('gere une periode sans commande', () => {
      const aggregate = aggregateProfitability([]);
      expect(aggregate.orders).toBe(0);
      expect(aggregate.cogsCompletenessRatio).toBe(1);
    });
  });
});
