import {
  isValidAlgerianPhone,
  maskPhone,
  normalizePhone,
  parseAlgerianPhone,
} from './phone';

describe('normalisation des numeros algeriens', () => {
  describe('formes acceptees', () => {
    const mobileVariants = [
      '0555123456',
      '0555 12 34 56',
      '0555-12-34-56',
      '  0555.12.34.56  ',
      '+213555123456',
      '+213 555 12 34 56',
      '00213555123456',
      '213555123456',
      '555123456',
      '(0555) 123456',
    ];

    it.each(mobileVariants)('normalise %s en +213555123456', (input) => {
      expect(normalizePhone(input)).toBe('+213555123456');
    });

    it('accepte les operateurs 05, 06 et 07', () => {
      expect(normalizePhone('0555123456')).toBe('+213555123456');
      expect(normalizePhone('0661234567')).toBe('+213661234567');
      expect(normalizePhone('0770123456')).toBe('+213770123456');
    });

    it('accepte une ligne fixe', () => {
      const result = parseAlgerianPhone('021234567');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.e164).toBe('+21321234567');
        expect(result.value.kind).toBe('LANDLINE');
        expect(result.value.nationalFormatted).toBe('021 23 45 67');
      }
    });

    it('convertit les chiffres arabes-indiens', () => {
      expect(normalizePhone('٠٥٥٥١٢٣٤٥٦')).toBe('+213555123456');
    });

    it('accepte un numero fourni sous forme numerique', () => {
      // Cas reel : Google Sheets renvoie parfois la cellule en nombre,
      // ce qui fait disparaitre le zero initial.
      expect(normalizePhone(555123456)).toBe('+213555123456');
    });
  });

  describe('formatage', () => {
    it('produit une forme nationale lisible pour un mobile', () => {
      const result = parseAlgerianPhone('0555123456');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.nationalFormatted).toBe('0555 12 34 56');
        expect(result.value.nationalNumber).toBe('555123456');
        expect(result.value.kind).toBe('MOBILE');
      }
    });
  });

  describe('rejets', () => {
    it('rejette une saisie vide', () => {
      expect(parseAlgerianPhone('')).toEqual({ ok: false, error: 'EMPTY' });
      expect(parseAlgerianPhone('   ')).toEqual({ ok: false, error: 'EMPTY' });
      expect(parseAlgerianPhone(null)).toEqual({ ok: false, error: 'EMPTY' });
      expect(parseAlgerianPhone(undefined)).toEqual({ ok: false, error: 'EMPTY' });
    });

    it('rejette une chaine sans chiffre', () => {
      expect(parseAlgerianPhone('a confirmer')).toEqual({ ok: false, error: 'NOT_A_NUMBER' });
    });

    it('rejette un indicatif etranger', () => {
      expect(parseAlgerianPhone('+33612345678')).toEqual({
        ok: false,
        error: 'FOREIGN_COUNTRY_CODE',
      });
      expect(parseAlgerianPhone('0033612345678')).toEqual({
        ok: false,
        error: 'FOREIGN_COUNTRY_CODE',
      });
    });

    it('rejette une longueur invalide', () => {
      expect(parseAlgerianPhone('055512345')).toEqual({ ok: false, error: 'INVALID_LENGTH' });
      expect(parseAlgerianPhone('05551234567')).toEqual({ ok: false, error: 'INVALID_LENGTH' });
    });

    it('rejette un prefixe operateur inconnu', () => {
      expect(parseAlgerianPhone('0955123456')).toEqual({ ok: false, error: 'INVALID_PREFIX' });
      expect(parseAlgerianPhone('0155123456')).toEqual({ ok: false, error: 'INVALID_PREFIX' });
    });

    it('retourne null via le raccourci normalizePhone', () => {
      expect(normalizePhone('inexploitable')).toBeNull();
      expect(isValidAlgerianPhone('inexploitable')).toBe(false);
    });
  });

  describe('masquage pour les journaux', () => {
    it('ne laisse apparaitre que le prefixe et les 4 derniers chiffres', () => {
      const masked = maskPhone('+213555123456');
      expect(masked.startsWith('+213')).toBe(true);
      expect(masked.endsWith('3456')).toBe(true);
      expect(masked).not.toContain('55512');
    });

    it('masque integralement une valeur trop courte', () => {
      expect(maskPhone('+213')).toBe('••••');
    });
  });

  describe('propriete d idempotence', () => {
    it('renormalise un numero deja normalise sans le modifier', () => {
      const once = normalizePhone('0555 12 34 56');
      expect(once).not.toBeNull();
      expect(normalizePhone(once as string)).toBe(once);
    });
  });
});
