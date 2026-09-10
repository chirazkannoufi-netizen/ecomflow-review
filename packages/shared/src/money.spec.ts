import {
  allocateCentimes,
  applyPercentage,
  assertCentimes,
  centimesToDinars,
  computeOrderTotal,
  dinarsToCentimes,
  formatCentimes,
  money,
  sumCentimes,
} from './money';

describe('representation monetaire', () => {
  describe('conversion dinars <-> centimes', () => {
    it('convertit un entier simple', () => {
      expect(dinarsToCentimes('4500')).toBe(450_000);
      expect(dinarsToCentimes(4500)).toBe(450_000);
    });

    it('accepte la virgule decimale francaise', () => {
      expect(dinarsToCentimes('4500,50')).toBe(450_050);
      expect(dinarsToCentimes('4500.50')).toBe(450_050);
    });

    it('ignore les espaces de milliers et les symboles', () => {
      expect(dinarsToCentimes('4 500 DA')).toBe(450_000);
      expect(dinarsToCentimes('4 500,00 DA')).toBe(450_000);
    });

    it('gere les montants negatifs (avoirs)', () => {
      expect(dinarsToCentimes('-250')).toBe(-25_000);
    });

    it('retourne null sur une saisie inexploitable', () => {
      expect(dinarsToCentimes('')).toBeNull();
      expect(dinarsToCentimes('gratuit')).toBeNull();
    });

    it('arrondit au centime le plus proche sans derive flottante', () => {
      // 0.1 + 0.2 en flottant vaut 0.30000000000000004 : la conversion
      // doit produire exactement 30 centimes.
      expect(dinarsToCentimes(String(0.1 + 0.2))).toBe(30);
    });

    it('revient au dinar', () => {
      expect(centimesToDinars(450_050)).toBe(4500.5);
    });
  });

  describe('garde d integrite', () => {
    it('refuse un montant fractionnaire', () => {
      expect(() => assertCentimes(10.5)).toThrow(RangeError);
    });

    it('refuse NaN et Infinity', () => {
      expect(() => assertCentimes(Number.NaN)).toThrow(RangeError);
      expect(() => assertCentimes(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('construit un DTO monetaire en dinar algerien', () => {
      expect(money(450_000)).toEqual({ amount: 450_000, currency: 'DZD' });
    });
  });

  describe('agregation', () => {
    it('somme sans perte', () => {
      expect(sumCentimes([100, 200, 300])).toBe(600);
      expect(sumCentimes([])).toBe(0);
    });

    it('applique un pourcentage avec arrondi commercial', () => {
      expect(applyPercentage(10_000, 10)).toBe(1_000);
      expect(applyPercentage(333, 50)).toBe(167);
    });
  });

  describe('ventilation des frais', () => {
    it('conserve exactement le total ventile', () => {
      const parts = allocateCentimes(1_000, [1, 1, 1]);
      expect(sumCentimes(parts)).toBe(1_000);
      expect(parts).toHaveLength(3);
    });

    it('repartit proportionnellement aux poids', () => {
      const parts = allocateCentimes(1_000, [3, 1]);
      expect(parts).toEqual([750, 250]);
    });

    it('distribue le reste sur les plus grandes fractions perdues', () => {
      const parts = allocateCentimes(100, [1, 1, 1]);
      expect(sumCentimes(parts)).toBe(100);
      expect(parts.sort((a, b) => b - a)).toEqual([34, 33, 33]);
    });

    it('repartit uniformement quand les poids sont nuls', () => {
      const parts = allocateCentimes(100, [0, 0, 0]);
      expect(sumCentimes(parts)).toBe(100);
    });

    it('retourne un tableau vide sans ligne', () => {
      expect(allocateCentimes(1_000, [])).toEqual([]);
    });
  });

  describe('total de commande', () => {
    it('additionne articles et livraison', () => {
      expect(
        computeOrderTotal({ itemsTotalCentimes: 450_000, deliveryFeeCentimes: 50_000 }),
      ).toBe(500_000);
    });

    it('soustrait la remise de commande', () => {
      // Le defaut que cette fonction corrige : la remise etait lue partout et
      // soustraite nulle part.
      expect(
        computeOrderTotal({
          itemsTotalCentimes: 450_000,
          discountCentimes: 50_000,
          deliveryFeeCentimes: 50_000,
        }),
      ).toBe(450_000);
    });

    it('n applique pas la remise aux frais de livraison', () => {
      // Une remise superieure aux articles ne doit pas manger le transport :
      // le transporteur le facture quand meme.
      const total = computeOrderTotal({
        itemsTotalCentimes: 100_000,
        discountCentimes: 100_000,
        deliveryFeeCentimes: 50_000,
      });
      expect(total).toBe(50_000);
    });

    it('ajoute un echange a la charge du client', () => {
      expect(
        computeOrderTotal({ itemsTotalCentimes: 450_000, exchangeAmountCentimes: 20_000 }),
      ).toBe(470_000);
    });

    it('accepte un echange negatif quand la boutique rembourse', () => {
      expect(
        computeOrderTotal({ itemsTotalCentimes: 450_000, exchangeAmountCentimes: -20_000 }),
      ).toBe(430_000);
    });

    it('traite remise et echange comme deux lignes distinctes', () => {
      // Tout l'interet de la ligne « echange » : deux ajustements de meme
      // montant, de sens contraires, ne s'annulent pas dans le meme compteur.
      const total = computeOrderTotal({
        itemsTotalCentimes: 450_000,
        discountCentimes: 20_000,
        deliveryFeeCentimes: 50_000,
        exchangeAmountCentimes: 20_000,
      });
      expect(total).toBe(500_000);
    });

    it('reste au comportement anterieur quand rien n est renseigne', () => {
      expect(computeOrderTotal({ itemsTotalCentimes: 450_000 })).toBe(450_000);
    });

    it('refuse un montant non entier', () => {
      expect(() => computeOrderTotal({ itemsTotalCentimes: 4_500.5 })).toThrow(RangeError);
    });
  });

  describe('formatage', () => {
    it('affiche le montant avec la devise', () => {
      const formatted = formatCentimes(450_000);
      expect(formatted).toContain('DA');
      expect(formatted.replace(/\s/g, '')).toContain('4500,00');
    });

    it('peut omettre la devise', () => {
      expect(formatCentimes(450_000, { withCurrency: false })).not.toContain('DA');
    });
  });
});
