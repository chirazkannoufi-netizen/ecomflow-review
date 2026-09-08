/**
 * Referentiel geographique algerien.
 *
 * Perimetre assume : les 58 wilayas issues du decoupage administratif de 2019
 * (loi n° 19-11 portant creation de 10 nouvelles wilayas du Sud). Ce referentiel
 * est stable, verifiable et suffisant pour la normalisation des imports.
 *
 * Les COMMUNES ne sont volontairement PAS embarquees ici :
 *  - le referentiel officiel compte plus de 1500 communes, avec des variations
 *    de transliteration importantes selon les transporteurs ;
 *  - embarquer une liste approximative produirait des rejets d'import injustifies.
 * La commune est donc traitee comme un texte libre normalise, valide contre :
 *  1. la liste des communes deja utilisees par le tenant (apprentissage) ;
 *  2. le referentiel expose par le connecteur transporteur lorsqu'il en publie un.
 * Voir DECISIONS.md — decision « Referentiel communes ».
 */

export interface Wilaya {
  /** Code administratif officiel, 1 a 58. */
  readonly code: number;
  /** Code sur deux chiffres, format usuel des adresses ("16"). */
  readonly code2: string;
  /** Denomination francaise de reference. */
  readonly name: string;
  /** Denomination arabe. */
  readonly nameAr: string;
}

export const WILAYAS: readonly Wilaya[] = [
  { code: 1, code2: '01', name: 'Adrar', nameAr: 'أدرار' },
  { code: 2, code2: '02', name: 'Chlef', nameAr: 'الشلف' },
  { code: 3, code2: '03', name: 'Laghouat', nameAr: 'الأغواط' },
  { code: 4, code2: '04', name: 'Oum El Bouaghi', nameAr: 'أم البواقي' },
  { code: 5, code2: '05', name: 'Batna', nameAr: 'باتنة' },
  { code: 6, code2: '06', name: 'Bejaia', nameAr: 'بجاية' },
  { code: 7, code2: '07', name: 'Biskra', nameAr: 'بسكرة' },
  { code: 8, code2: '08', name: 'Bechar', nameAr: 'بشار' },
  { code: 9, code2: '09', name: 'Blida', nameAr: 'البليدة' },
  { code: 10, code2: '10', name: 'Bouira', nameAr: 'البويرة' },
  { code: 11, code2: '11', name: 'Tamanrasset', nameAr: 'تمنراست' },
  { code: 12, code2: '12', name: 'Tebessa', nameAr: 'تبسة' },
  { code: 13, code2: '13', name: 'Tlemcen', nameAr: 'تلمسان' },
  { code: 14, code2: '14', name: 'Tiaret', nameAr: 'تيارت' },
  { code: 15, code2: '15', name: 'Tizi Ouzou', nameAr: 'تيزي وزو' },
  { code: 16, code2: '16', name: 'Alger', nameAr: 'الجزائر' },
  { code: 17, code2: '17', name: 'Djelfa', nameAr: 'الجلفة' },
  { code: 18, code2: '18', name: 'Jijel', nameAr: 'جيجل' },
  { code: 19, code2: '19', name: 'Setif', nameAr: 'سطيف' },
  { code: 20, code2: '20', name: 'Saida', nameAr: 'سعيدة' },
  { code: 21, code2: '21', name: 'Skikda', nameAr: 'سكيكدة' },
  { code: 22, code2: '22', name: 'Sidi Bel Abbes', nameAr: 'سيدي بلعباس' },
  { code: 23, code2: '23', name: 'Annaba', nameAr: 'عنابة' },
  { code: 24, code2: '24', name: 'Guelma', nameAr: 'قالمة' },
  { code: 25, code2: '25', name: 'Constantine', nameAr: 'قسنطينة' },
  { code: 26, code2: '26', name: 'Medea', nameAr: 'المدية' },
  { code: 27, code2: '27', name: 'Mostaganem', nameAr: 'مستغانم' },
  { code: 28, code2: '28', name: "M'Sila", nameAr: 'المسيلة' },
  { code: 29, code2: '29', name: 'Mascara', nameAr: 'معسكر' },
  { code: 30, code2: '30', name: 'Ouargla', nameAr: 'ورقلة' },
  { code: 31, code2: '31', name: 'Oran', nameAr: 'وهران' },
  { code: 32, code2: '32', name: 'El Bayadh', nameAr: 'البيض' },
  { code: 33, code2: '33', name: 'Illizi', nameAr: 'إليزي' },
  { code: 34, code2: '34', name: 'Bordj Bou Arreridj', nameAr: 'برج بوعريريج' },
  { code: 35, code2: '35', name: 'Boumerdes', nameAr: 'بومرداس' },
  { code: 36, code2: '36', name: 'El Tarf', nameAr: 'الطارف' },
  { code: 37, code2: '37', name: 'Tindouf', nameAr: 'تندوف' },
  { code: 38, code2: '38', name: 'Tissemsilt', nameAr: 'تيسمسيلت' },
  { code: 39, code2: '39', name: 'El Oued', nameAr: 'الوادي' },
  { code: 40, code2: '40', name: 'Khenchela', nameAr: 'خنشلة' },
  { code: 41, code2: '41', name: 'Souk Ahras', nameAr: 'سوق أهراس' },
  { code: 42, code2: '42', name: 'Tipaza', nameAr: 'تيبازة' },
  { code: 43, code2: '43', name: 'Mila', nameAr: 'ميلة' },
  { code: 44, code2: '44', name: 'Ain Defla', nameAr: 'عين الدفلى' },
  { code: 45, code2: '45', name: 'Naama', nameAr: 'النعامة' },
  { code: 46, code2: '46', name: 'Ain Temouchent', nameAr: 'عين تموشنت' },
  { code: 47, code2: '47', name: 'Ghardaia', nameAr: 'غرداية' },
  { code: 48, code2: '48', name: 'Relizane', nameAr: 'غليزان' },
  { code: 49, code2: '49', name: 'Timimoun', nameAr: 'تيميمون' },
  { code: 50, code2: '50', name: 'Bordj Badji Mokhtar', nameAr: 'برج باجي مختار' },
  { code: 51, code2: '51', name: 'Ouled Djellal', nameAr: 'أولاد جلال' },
  { code: 52, code2: '52', name: 'Beni Abbes', nameAr: 'بني عباس' },
  { code: 53, code2: '53', name: 'In Salah', nameAr: 'عين صالح' },
  { code: 54, code2: '54', name: 'In Guezzam', nameAr: 'عين قزام' },
  { code: 55, code2: '55', name: 'Touggourt', nameAr: 'تقرت' },
  { code: 56, code2: '56', name: 'Djanet', nameAr: 'جانت' },
  { code: 57, code2: '57', name: "El M'Ghair", nameAr: 'المغير' },
  { code: 58, code2: '58', name: 'El Meniaa', nameAr: 'المنيعة' },
];

/**
 * Variantes de transliteration frequemment rencontrees dans les fichiers
 * Google Sheets des commercants. Cle = forme normalisee alternative,
 * valeur = code officiel de la wilaya.
 */
const WILAYA_ALIASES: Readonly<Record<string, number>> = {
  algiers: 16,
  alger_centre: 16,
  eldjazair: 16,
  bejaya: 6,
  bgayet: 6,
  bougie: 6,
  bejaa: 6,
  tizi: 15,
  tiziouzou: 15,
  setif2: 19,
  stif: 19,
  bba: 34,
  bordjbouarreridj: 34,
  bordjbouarridj: 34,
  bordj: 34,
  msila: 28,
  elmsila: 28,
  sba: 22,
  sidibelabbes: 22,
  ouargla2: 30,
  eloued: 39,
  souf: 39,
  ghardaya: 47,
  ghardaea: 47,
  tebessa2: 12,
  tbessa: 12,
  aindefla: 44,
  aintemouchent: 46,
  ainsalah: 53,
  ainguezzam: 54,
  elmghair: 57,
  elmenia: 58,
  elmeniaa: 58,
  beniabbes: 52,
  ouleddjellal: 51,
  bordjbadjimokhtar: 50,
  boumerdas: 35,
  boumardes: 35,
  medea2: 26,
  lemdia: 26,
  constantine2: 25,
  qacentina: 25,
  annaba2: 23,
  bone: 23,
  oran2: 31,
  wahran: 31,
  chlef2: 2,
  elasnam: 2,
  tipasa: 42,
  tipaza2: 42,
};

/**
 * Normalise une chaine pour comparaison : minuscules, sans accents,
 * sans ponctuation ni espaces. « Bordj Bou Arreridj » -> « bordjbouarreridj ».
 */
export function normalizeGeoName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const WILAYA_BY_CODE: ReadonlyMap<number, Wilaya> = new Map(WILAYAS.map((w) => [w.code, w]));

const WILAYA_BY_NORMALIZED_NAME: ReadonlyMap<string, Wilaya> = (() => {
  const map = new Map<string, Wilaya>();
  for (const wilaya of WILAYAS) {
    map.set(normalizeGeoName(wilaya.name), wilaya);
    map.set(wilaya.nameAr.replace(/\s/g, ''), wilaya);
  }
  for (const [alias, code] of Object.entries(WILAYA_ALIASES)) {
    const wilaya = WILAYA_BY_CODE.get(code);
    /* istanbul ignore next -- garde de coherence du referentiel */
    if (!wilaya) throw new Error(`Alias de wilaya invalide : ${alias} -> ${code}`);
    map.set(normalizeGeoName(alias), wilaya);
  }
  return map;
})();

export function getWilayaByCode(code: number): Wilaya | undefined {
  return WILAYA_BY_CODE.get(code);
}

/**
 * Resout une wilaya a partir d'une saisie libre : code numerique ("16", "6"),
 * nom francais, nom arabe ou variante de transliteration connue.
 * Retourne `undefined` plutot que de deviner : l'import journalise alors
 * une erreur UNKNOWN_WILAYA sur la ligne concernee.
 */
export function resolveWilaya(input: string | number | null | undefined): Wilaya | undefined {
  if (input === null || input === undefined) return undefined;

  const raw = String(input).trim();
  if (raw.length === 0) return undefined;

  // Forme numerique pure : "16", "06", 16
  if (/^\d{1,2}$/.test(raw)) {
    return WILAYA_BY_CODE.get(Number.parseInt(raw, 10));
  }

  // Forme "16 - Alger" ou "16-Alger"
  const prefixed = /^(\d{1,2})\s*[-_.]\s*(.+)$/.exec(raw);
  if (prefixed?.[1]) {
    const byCode = WILAYA_BY_CODE.get(Number.parseInt(prefixed[1], 10));
    if (byCode) return byCode;
  }

  // Saisie en caracteres arabes : `normalizeGeoName` les supprimerait
  // integralement (il ne conserve que [a-z0-9]). On tente donc d'abord une
  // correspondance sur la forme arabe debarrassee de ses espaces.
  const arabicKey = raw.replace(/\s/g, '');
  const byArabic = WILAYA_BY_NORMALIZED_NAME.get(arabicKey);
  if (byArabic) return byArabic;

  const latinKey = normalizeGeoName(raw);
  if (latinKey.length === 0) return undefined;

  return WILAYA_BY_NORMALIZED_NAME.get(latinKey);
}

export function isKnownWilaya(input: string | number | null | undefined): boolean {
  return resolveWilaya(input) !== undefined;
}

/** Nombre de wilayas du referentiel, expose pour les tests de coherence. */
export const WILAYA_COUNT = WILAYAS.length;
