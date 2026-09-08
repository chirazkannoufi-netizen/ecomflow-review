import {
  DEFAULT_DUPLICATE_POLICY,
  findDuplicates,
  normalizeForComparison,
  scoreDuplicate,
  type DuplicateCandidateInput,
} from './duplicates';

const NOW = new Date('2026-08-29T10:00:00.000Z');

function candidate(overrides: Partial<DuplicateCandidateInput> = {}): DuplicateCandidateInput {
  return {
    orderId: 'order-1',
    phoneNormalized: '+213555123456',
    customerNameNormalized: 'sara',
    wilayaCode: 16,
    addressNormalized: 'cite 1200 logements bab ezzouar',
    skus: ['ROB-001'],
    totalCentimes: 500_000,
    createdAt: NOW,
    ...overrides,
  };
}

describe('detection des doublons', () => {
  describe('cas evident', () => {
    it('signale une commande identique passee deux fois', () => {
      const match = scoreDuplicate(candidate(), candidate({ orderId: 'order-2' }));
      expect(match.confidence).toBe('LIKELY');
      expect(match.matchedRules).toEqual(
        expect.arrayContaining(['SAME_PHONE', 'SAME_PRODUCTS', 'SAME_ADDRESS', 'WITHIN_TIME_WINDOW']),
      );
    });

    it('explique chaque regle declenchee', () => {
      const match = scoreDuplicate(candidate(), candidate({ orderId: 'order-2' }));
      expect(match.explanation.length).toBe(match.matchedRules.length);
      expect(match.explanation.join(' ')).toContain('+213555123456');
    });
  });

  describe('faux positifs a eviter', () => {
    it('ne signale pas deux clients differents de la meme wilaya', () => {
      const match = scoreDuplicate(
        candidate(),
        candidate({
          orderId: 'order-2',
          phoneNormalized: '+213661234567',
          customerNameNormalized: 'yacine',
          addressNormalized: 'rue didouche mourad',
        }),
      );
      expect(match.confidence).toBe('NONE');
    });

    it('ne signale pas deux commandes du meme client espacees dans le temps', () => {
      const later = new Date(NOW.getTime() + 10 * 86_400_000);
      const match = scoreDuplicate(candidate(), candidate({ orderId: 'order-2', createdAt: later }));
      // Sans la fenetre temporelle, le score retombe sous le seuil eleve.
      expect(match.matchedRules).not.toContain('WITHIN_TIME_WINDOW');
      expect(match.confidence).not.toBe('LIKELY');
    });

    it('ne compare jamais une commande a elle-meme', () => {
      const subject = candidate();
      expect(findDuplicates(subject, [subject])).toEqual([]);
    });

    it('ignore un total nul dans la comparaison', () => {
      const match = scoreDuplicate(
        candidate({ totalCentimes: 0, phoneNormalized: null }),
        candidate({ orderId: 'order-2', totalCentimes: 0, phoneNormalized: null }),
      );
      expect(match.matchedRules).not.toContain('SAME_TOTAL');
    });

    it('ignore des telephones absents des deux cotes', () => {
      const match = scoreDuplicate(
        candidate({ phoneNormalized: null }),
        candidate({ orderId: 'order-2', phoneNormalized: null }),
      );
      expect(match.matchedRules).not.toContain('SAME_PHONE');
    });
  });

  describe('comparaison des produits', () => {
    it('considere identiques deux paniers de meme composition', () => {
      const match = scoreDuplicate(
        candidate({ skus: ['A', 'B'] }),
        candidate({ orderId: 'order-2', skus: ['B', 'A'] }),
      );
      expect(match.matchedRules).toContain('SAME_PRODUCTS');
    });

    it('distingue deux paniers de tailles differentes', () => {
      const match = scoreDuplicate(
        candidate({ skus: ['A'] }),
        candidate({ orderId: 'order-2', skus: ['A', 'B'] }),
      );
      expect(match.matchedRules).not.toContain('SAME_PRODUCTS');
    });

    it('ne rapproche pas deux commandes sans ligne', () => {
      const match = scoreDuplicate(
        candidate({ skus: [] }),
        candidate({ orderId: 'order-2', skus: [] }),
      );
      expect(match.matchedRules).not.toContain('SAME_PRODUCTS');
    });
  });

  describe('recherche sur une liste', () => {
    it('trie les correspondances par score decroissant', () => {
      const subject = candidate();
      const matches = findDuplicates(subject, [
        candidate({ orderId: 'weak', addressNormalized: 'autre adresse', skus: ['AUTRE'] }),
        candidate({ orderId: 'strong' }),
      ]);
      expect(matches[0]?.candidateOrderId).toBe('strong');
      expect(matches[0]?.score).toBeGreaterThanOrEqual(matches[1]?.score ?? 0);
    });

    it('exclut les correspondances sous le seuil', () => {
      const matches = findDuplicates(candidate(), [
        candidate({
          orderId: 'unrelated',
          phoneNormalized: '+213770000000',
          customerNameNormalized: 'autre',
          addressNormalized: 'ailleurs',
          skus: ['XYZ'],
          totalCentimes: 1,
          wilayaCode: 31,
        }),
      ]);
      expect(matches).toEqual([]);
    });

    it('respecte une politique personnalisee', () => {
      const strict = { ...DEFAULT_DUPLICATE_POLICY, alertThreshold: 200 };
      expect(findDuplicates(candidate(), [candidate({ orderId: 'order-2' })], strict)).toEqual([]);
    });
  });

  describe('normalisation de comparaison', () => {
    it('neutralise accents, casse et ponctuation', () => {
      expect(normalizeForComparison('Cité 1200 Logements, Bab-Ezzouar')).toBe(
        'cite 1200 logements bab ezzouar',
      );
    });

    it('retourne null sur une valeur vide', () => {
      expect(normalizeForComparison(null)).toBeNull();
      expect(normalizeForComparison('')).toBeNull();
      expect(normalizeForComparison('   ')).toBeNull();
      expect(normalizeForComparison('!!!')).toBeNull();
    });
  });
});
