/**
 * Normalisation des numeros de telephone algeriens.
 *
 * Source de verite : V2 §12 (« Normalisation : telephone ») et §13 (« retrouver
 * un client a partir d'un identifiant metier principal, notamment telephone »).
 *
 * Le numero normalise est la CLE METIER du client au sein d'un tenant. Il est
 * stocke en E.164 (`+213XXXXXXXXX`) dans `customers.phone_normalized`, avec un
 * index unique `(tenant_id, phone_normalized)`. La forme saisie par le
 * commercant est conservee telle quelle dans `phone_raw` pour tracabilite.
 *
 * Ce module est volontairement sans dependance : il est utilise a l'identique
 * par l'API (validation autoritaire) et par le front (retour immediat a la saisie).
 */

export const DZ_COUNTRY_CODE = '213';
export const DZ_E164_PREFIX = `+${DZ_COUNTRY_CODE}`;

/** Prefixes des operateurs mobiles algeriens (premier chiffre du NSN). */
const MOBILE_LEADING_DIGITS = new Set(['5', '6', '7']);

/** Premier chiffre des indicatifs de lignes fixes (Alger 21, Oran 41, ...). */
const LANDLINE_LEADING_DIGITS = new Set(['2', '3', '4']);

export type PhoneKind = 'MOBILE' | 'LANDLINE';

export interface NormalizedPhone {
  /** Forme E.164 : +213 suivi du numero national significatif. */
  readonly e164: string;
  /** Numero national significatif, sans le 0 de service ni l'indicatif pays. */
  readonly nationalNumber: string;
  /** Forme nationale lisible, telle qu'affichee en Algerie : 0X XX XX XX XX. */
  readonly nationalFormatted: string;
  readonly kind: PhoneKind;
}

export type PhoneParseError =
  | 'EMPTY'
  | 'NOT_A_NUMBER'
  | 'FOREIGN_COUNTRY_CODE'
  | 'INVALID_LENGTH'
  | 'INVALID_PREFIX';

export type PhoneParseResult =
  | { readonly ok: true; readonly value: NormalizedPhone }
  | { readonly ok: false; readonly error: PhoneParseError };

/**
 * Convertit les chiffres arabes-indiens (٠-٩) et arabes-indiens orientaux (۰-۹)
 * en chiffres ASCII : ces variantes apparaissent regulierement dans les
 * exports Google Sheets saisis depuis un clavier arabe.
 */
function toAsciiDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x0660 && code <= 0x0669) {
      out += String.fromCharCode(code - 0x0660 + 48);
    } else if (code >= 0x06f0 && code <= 0x06f9) {
      out += String.fromCharCode(code - 0x06f0 + 48);
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Analyse une saisie libre et retourne le numero normalise, ou une erreur
 * explicite exploitable par le journal d'import (code INVALID_PHONE).
 *
 * Formes acceptees :
 *   0555 12 34 56 / 0555-123-456 / +213 555 12 34 56 / 00213555123456
 *   213555123456 / 555123456 (NSN mobile nu) / (0555) 123456
 */
export function parseAlgerianPhone(input: string | number | null | undefined): PhoneParseResult {
  if (input === null || input === undefined) return { ok: false, error: 'EMPTY' };

  const raw = toAsciiDigits(String(input)).trim();
  if (raw.length === 0) return { ok: false, error: 'EMPTY' };

  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return { ok: false, error: 'NOT_A_NUMBER' };

  // 00 international -> +
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    if (!digits.startsWith(DZ_COUNTRY_CODE)) return { ok: false, error: 'FOREIGN_COUNTRY_CODE' };
    digits = digits.slice(DZ_COUNTRY_CODE.length);
  } else if (hasPlus) {
    if (!digits.startsWith(DZ_COUNTRY_CODE)) return { ok: false, error: 'FOREIGN_COUNTRY_CODE' };
    digits = digits.slice(DZ_COUNTRY_CODE.length);
  } else if (digits.startsWith(DZ_COUNTRY_CODE) && digits.length > 10) {
    // "213555123456" saisi sans + ni 00.
    digits = digits.slice(DZ_COUNTRY_CODE.length);
  }

  // Retrait du 0 de service national.
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === 0) return { ok: false, error: 'INVALID_LENGTH' };

  const leading = digits.charAt(0);

  if (MOBILE_LEADING_DIGITS.has(leading)) {
    if (digits.length !== 9) return { ok: false, error: 'INVALID_LENGTH' };
    return { ok: true, value: buildNormalized(digits, 'MOBILE') };
  }

  if (LANDLINE_LEADING_DIGITS.has(leading)) {
    if (digits.length !== 8) return { ok: false, error: 'INVALID_LENGTH' };
    return { ok: true, value: buildNormalized(digits, 'LANDLINE') };
  }

  return { ok: false, error: 'INVALID_PREFIX' };
}

function buildNormalized(nationalNumber: string, kind: PhoneKind): NormalizedPhone {
  return {
    e164: `${DZ_E164_PREFIX}${nationalNumber}`,
    nationalNumber,
    nationalFormatted: formatNational(nationalNumber, kind),
    kind,
  };
}

/** 0555 12 34 56 pour un mobile, 021 23 45 67 pour un fixe. */
function formatNational(nationalNumber: string, kind: PhoneKind): string {
  if (kind === 'MOBILE') {
    const a = nationalNumber.slice(0, 3);
    const b = nationalNumber.slice(3, 5);
    const c = nationalNumber.slice(5, 7);
    const d = nationalNumber.slice(7, 9);
    return `0${a} ${b} ${c} ${d}`;
  }
  const area = nationalNumber.slice(0, 2);
  const b = nationalNumber.slice(2, 4);
  const c = nationalNumber.slice(4, 6);
  const d = nationalNumber.slice(6, 8);
  return `0${area} ${b} ${c} ${d}`;
}

/** Raccourci : retourne la forme E.164 ou `null` si la saisie est inexploitable. */
export function normalizePhone(input: string | number | null | undefined): string | null {
  const result = parseAlgerianPhone(input);
  return result.ok ? result.value.e164 : null;
}

export function isValidAlgerianPhone(input: string | number | null | undefined): boolean {
  return parseAlgerianPhone(input).ok;
}

/**
 * Masque un numero pour les journaux et les exports non autorises :
 * `+213555123456` -> `+213•••••3456`. Utilise par le middleware de redaction
 * afin de ne jamais ecrire un numero complet dans les logs applicatifs
 * (conformite loi 18-07, Addendum §37).
 */
export function maskPhone(e164: string): string {
  if (e164.length <= 8) return '••••';
  return `${e164.slice(0, 4)}${'•'.repeat(Math.max(0, e164.length - 8))}${e164.slice(-4)}`;
}
