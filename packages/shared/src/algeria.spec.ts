import {
  getWilayaByCode,
  isKnownWilaya,
  normalizeGeoName,
  resolveWilaya,
  WILAYAS,
  WILAYA_COUNT,
} from './algeria';

describe('referentiel des wilayas', () => {
  it('contient les 58 wilayas du decoupage de 2019', () => {
    expect(WILAYA_COUNT).toBe(58);
  });

  it('numerote les wilayas de 1 a 58 sans trou ni doublon', () => {
    const codes = WILAYAS.map((w) => w.code).sort((a, b) => a - b);
    expect(codes).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
  });

  it('formate systematiquement le code sur deux chiffres', () => {
    for (const wilaya of WILAYAS) {
      expect(wilaya.code2).toHaveLength(2);
      expect(Number.parseInt(wilaya.code2, 10)).toBe(wilaya.code);
    }
  });

  it('renseigne un nom francais et un nom arabe pour chaque wilaya', () => {
    for (const wilaya of WILAYAS) {
      expect(wilaya.name.trim().length).toBeGreaterThan(0);
      expect(wilaya.nameAr.trim().length).toBeGreaterThan(0);
    }
  });

  describe('resolution depuis une saisie libre', () => {
    it('resout un code numerique', () => {
      expect(resolveWilaya(16)?.name).toBe('Alger');
      expect(resolveWilaya('16')?.name).toBe('Alger');
      expect(resolveWilaya('06')?.name).toBe('Bejaia');
      expect(resolveWilaya('6')?.name).toBe('Bejaia');
    });

    it('resout un nom francais avec ou sans accent ni casse', () => {
      expect(resolveWilaya('Alger')?.code).toBe(16);
      expect(resolveWilaya('alger')?.code).toBe(16);
      expect(resolveWilaya('  BEJAIA ')?.code).toBe(6);
      expect(resolveWilaya('Béjaïa')?.code).toBe(6);
      expect(resolveWilaya('Tizi Ouzou')?.code).toBe(15);
      expect(resolveWilaya('tizi-ouzou')?.code).toBe(15);
    });

    it('resout un nom arabe', () => {
      expect(resolveWilaya('الجزائر')?.code).toBe(16);
      expect(resolveWilaya('وهران')?.code).toBe(31);
    });

    it('resout les variantes de transliteration courantes', () => {
      expect(resolveWilaya('Algiers')?.code).toBe(16);
      expect(resolveWilaya('BBA')?.code).toBe(34);
      expect(resolveWilaya('Bordj Bou Arreridj')?.code).toBe(34);
      expect(resolveWilaya('M Sila')?.code).toBe(28);
      expect(resolveWilaya("M'Sila")?.code).toBe(28);
      expect(resolveWilaya('Sidi Bel Abbes')?.code).toBe(22);
    });

    it('resout la forme "16 - Alger"', () => {
      expect(resolveWilaya('16 - Alger')?.code).toBe(16);
      expect(resolveWilaya('31-Oran')?.code).toBe(31);
    });

    it('refuse de deviner sur une valeur inconnue', () => {
      expect(resolveWilaya('Casablanca')).toBeUndefined();
      expect(resolveWilaya('99')).toBeUndefined();
      expect(resolveWilaya('')).toBeUndefined();
      expect(resolveWilaya(null)).toBeUndefined();
      expect(resolveWilaya(undefined)).toBeUndefined();
      expect(isKnownWilaya('Wilaya inexistante')).toBe(false);
    });
  });

  describe('normalisation', () => {
    it('supprime accents, casse et ponctuation', () => {
      expect(normalizeGeoName('Béjaïa')).toBe('bejaia');
      expect(normalizeGeoName("M'Sila")).toBe('msila');
      expect(normalizeGeoName('Bordj Bou Arreridj')).toBe('bordjbouarreridj');
    });
  });

  it('retrouve une wilaya par son code', () => {
    expect(getWilayaByCode(1)?.name).toBe('Adrar');
    expect(getWilayaByCode(58)?.name).toBe('El Meniaa');
    expect(getWilayaByCode(0)).toBeUndefined();
    expect(getWilayaByCode(59)).toBeUndefined();
  });
});
