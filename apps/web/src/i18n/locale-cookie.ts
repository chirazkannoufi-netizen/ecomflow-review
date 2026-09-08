/**
 * Miroir de la preference de langue dans un cookie.
 *
 * POURQUOI UN COOKIE ALORS QUE LA PREFERENCE VIT EN BASE
 *
 *   La source de verite reste `User.locale`, cote serveur : c'est elle qui
 *   suit l'utilisateur d'un poste a l'autre. Mais elle n'est connue qu'apres
 *   l'appel a `/tenants/current`, soit plusieurs centaines de millisecondes
 *   apres le premier rendu.
 *
 *   Sans ce cookie, un utilisateur arabophone verrait donc l'interface
 *   s'afficher en francais, alignee a gauche, puis basculer brutalement en
 *   arabe aligne a droite. Ce clignotement est particulierement violent en
 *   RTL, ou c'est toute la mise en page qui se retourne.
 *
 *   Le cookie est un CACHE, jamais une autorite : des que la session est
 *   chargee, la valeur du serveur s'impose et le cookie est realigne.
 *
 * PAS DE DONNEE SENSIBLE
 *   Le cookie ne contient qu'un code de langue sur deux caracteres. Il est
 *   donc lisible en JavaScript (`SameSite=Lax`, pas de `HttpOnly`), ce qui
 *   est necessaire pour que le client puisse l'ecrire lui-meme.
 */

import { DEFAULT_LOCALE, isLocale, type Locale } from '@ecomflow/shared';

export const LOCALE_COOKIE = 'ecomflow_locale';

/** Un an : la langue d'un utilisateur ne change pas tous les mois. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Lit la langue mise en cache dans le navigateur. */
export function readLocaleCookie(): Locale | null {
  if (typeof document === 'undefined') return null;

  const match = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`).exec(document.cookie);
  const value = match?.[1] ? decodeURIComponent(match[1]) : null;

  return isLocale(value) ? value : null;
}

/** Met le cache du navigateur en accord avec la preference du serveur. */
export function writeLocaleCookie(locale: Locale): void {
  if (typeof document === 'undefined') return;

  document.cookie =
    `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; ` +
    `Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

/** Extrait la langue d'un en-tete `Cookie` brut, cote serveur. */
export function localeFromCookieHeader(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;

  const match = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`).exec(header);
  const value = match?.[1] ? decodeURIComponent(match[1]) : null;

  return isLocale(value) ? value : DEFAULT_LOCALE;
}
