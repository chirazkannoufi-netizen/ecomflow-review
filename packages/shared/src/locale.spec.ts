import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_DIRECTION,
  LOCALE_LABELS,
  LOCALE_TAGS,
  directionOf,
  isLocale,
  isRtl,
  localeFromAcceptLanguage,
  resolveLocale,
} from './locale';

describe('langues', () => {
  it('expose exactement le francais et l arabe', () => {
    expect(LOCALES).toEqual(['fr', 'ar']);
  });

  it('retient le francais par defaut', () => {
    expect(DEFAULT_LOCALE).toBe('fr');
  });

  it('decrit chaque langue de facon complete', () => {
    // Une langue ajoutee sans son libelle, sa direction ou son etiquette
    // produirait une interface a moitie traduite.
    for (const locale of LOCALES) {
      expect(LOCALE_LABELS[locale]).toBeTruthy();
      expect(LOCALE_DIRECTION[locale]).toMatch(/^(ltr|rtl)$/);
      expect(LOCALE_TAGS[locale]).toContain('-DZ');
    }
  });

  it('nomme chaque langue dans sa propre ecriture', () => {
    // Un selecteur qui afficherait « Arabe » en francais obligerait un
    // arabophone a lire du francais pour choisir l'arabe.
    expect(LOCALE_LABELS.ar).toBe('العربية');
  });

  it('cible l Algerie pour le formatage', () => {
    // `ar-DZ` conserve les chiffres latins ; `ar-EG` afficherait ٠١٢٣,
    // illisibles pour un commercant algerien.
    expect(LOCALE_TAGS.ar).toBe('ar-DZ');
    expect(new Intl.NumberFormat(LOCALE_TAGS.ar).format(1234)).toMatch(/[0-9]/);
  });

  it('n affiche JAMAIS de chiffres arabo-indiens, quel que soit le formateur', () => {
    // POURQUOI CE TEST EXISTE
    //   `ar-DZ` ressemble a une coquille : la correction « evidente » est de
    //   le remplacer par `ar`, ou par `ar-EG` puisque l'Egypte est le plus
    //   gros marche arabophone. Les deux font basculer TOUTE l'application en
    //   ٠١٢٣ — montants, quantites, numeros de suivi, dates — sans qu'aucun
    //   type ne bronche, et sans qu'un relecteur francophone ne s'en apercoive.
    //
    //   L'assertion porte donc sur le RESULTAT observable plutot que sur
    //   l'etiquette : elle tient encore si quelqu'un ajoute un
    //   `-u-nu-arab` a la fin du tag, ce qu'une egalite de chaine laisserait
    //   passer.
    const EASTERN_DIGITS = /[٠-٩۰-۹]/;
    const tag = LOCALE_TAGS.ar;

    const rendered = [
      new Intl.NumberFormat(tag).format(1234567.89),
      new Intl.NumberFormat(tag, { style: 'currency', currency: 'DZD' }).format(4500),
      new Intl.NumberFormat(tag, { style: 'percent' }).format(0.125),
      new Intl.DateTimeFormat(tag, { dateStyle: 'short' }).format(new Date('2026-08-31T10:00:00Z')),
      new Intl.DateTimeFormat(tag, { dateStyle: 'long' }).format(new Date('2026-08-31T10:00:00Z')),
    ];

    for (const value of rendered) {
      expect(value).not.toMatch(EASTERN_DIGITS);
      // Un formatage qui ne produirait AUCUN chiffre signalerait un tag
      // invalide silencieusement retombe sur autre chose.
      expect(value).toMatch(/[0-9]/);
    }
  });

  describe('isLocale', () => {
    it('accepte les langues connues', () => {
      expect(isLocale('fr')).toBe(true);
      expect(isLocale('ar')).toBe(true);
    });

    it('rejette tout le reste', () => {
      expect(isLocale('en')).toBe(false);
      expect(isLocale('AR')).toBe(false);
      expect(isLocale('')).toBe(false);
      expect(isLocale(null)).toBe(false);
      expect(isLocale(undefined)).toBe(false);
      expect(isLocale(42)).toBe(false);
      expect(isLocale({ toString: () => 'fr' })).toBe(false);
    });
  });

  describe('direction', () => {
    it('lit le francais de gauche a droite', () => {
      expect(isRtl('fr')).toBe(false);
      expect(directionOf('fr')).toBe('ltr');
    });

    it('lit l arabe de droite a gauche', () => {
      expect(isRtl('ar')).toBe(true);
      expect(directionOf('ar')).toBe('rtl');
    });
  });

  describe('resolveLocale', () => {
    it('retient le premier candidat valide', () => {
      // Ordre attendu a l'usage : preference utilisateur, puis boutique,
      // puis defaut.
      expect(resolveLocale('ar', 'fr')).toBe('ar');
      expect(resolveLocale(null, 'ar')).toBe('ar');
      expect(resolveLocale(undefined, null, 'fr')).toBe('fr');
    });

    it('ignore les valeurs inconnues plutot que de les approximer', () => {
      expect(resolveLocale('en', 'ar')).toBe('ar');
      expect(resolveLocale('ar-DZ')).toBe(DEFAULT_LOCALE);
    });

    it('retombe sur la langue par defaut sans aucun candidat', () => {
      expect(resolveLocale()).toBe('fr');
      expect(resolveLocale(null, undefined, '')).toBe('fr');
    });
  });

  describe('localeFromAcceptLanguage', () => {
    it('reconnait une langue simple', () => {
      expect(localeFromAcceptLanguage('ar')).toBe('ar');
      expect(localeFromAcceptLanguage('fr')).toBe('fr');
    });

    it('reconnait une variante regionale', () => {
      expect(localeFromAcceptLanguage('ar-DZ')).toBe('ar');
      expect(localeFromAcceptLanguage('fr-FR')).toBe('fr');
    });

    it('respecte les facteurs de qualite', () => {
      // Le navigateur exprime un ordre de preference : le suivre evite de
      // servir de l'arabe a qui a demande du francais en priorite.
      expect(localeFromAcceptLanguage('en;q=0.9,ar;q=0.8,fr;q=1.0')).toBe('fr');
      expect(localeFromAcceptLanguage('en,ar;q=0.9,fr;q=0.5')).toBe('ar');
    });

    it('ignore les langues non prises en charge', () => {
      expect(localeFromAcceptLanguage('en-US,en;q=0.9')).toBeNull();
      expect(localeFromAcceptLanguage('de,es;q=0.7')).toBeNull();
    });

    it('tolere un en-tete absent ou vide', () => {
      expect(localeFromAcceptLanguage(null)).toBeNull();
      expect(localeFromAcceptLanguage(undefined)).toBeNull();
      expect(localeFromAcceptLanguage('')).toBeNull();
      expect(localeFromAcceptLanguage(',,;q=;')).toBeNull();
    });

    it('ignore un facteur de qualite malforme sans jeter la langue', () => {
      // RFC 9110 : un parametre invalide s'ignore, et la qualite par defaut
      // vaut 1. Le client a bien demande de l'arabe ; seul son « q » est
      // illisible. Le lui refuser pour cette raison serait absurde.
      expect(localeFromAcceptLanguage('ar;q=abc')).toBe('ar');
    });
  });
});
