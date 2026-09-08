/**
 * Langues de l'application — francais et arabe.
 *
 * POURQUOI CE MODULE VIT DANS LE PAQUET PARTAGE
 *   La langue n'est pas une affaire d'interface uniquement. Elle determine
 *   aussi le contenu des messages WhatsApp envoyes au CLIENT FINAL, qui sont
 *   produits cote serveur. Definir les langues a deux endroits garantirait
 *   qu'un jour l'API accepte une valeur que le front ne sait pas afficher.
 *
 * DEUX PREFERENCES DISTINCTES, VOLONTAIREMENT SEPAREES
 *
 *   La langue de l'UTILISATEUR (`User.locale`) — celle de l'agent qui travaille
 *   dans l'application toute la journee.
 *
 *   La langue du CLIENT FINAL (`Customer.locale`) — celle dans laquelle il
 *   recoit ses messages WhatsApp. Un agent peut parfaitement travailler en
 *   francais et ecrire a un client en arabe ; c'est meme le cas courant en
 *   Algerie. Les confondre reviendrait a imposer la langue de l'employe au
 *   client, ce qui a un effet direct et mesurable sur le taux de confirmation.
 */

export const LOCALES = ['fr', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Langue par defaut.
 *
 * Le francais est la langue de travail administrative et commerciale dominante
 * du e-commerce algerien : c'est celle des cahiers des charges, des factures et
 * des interfaces transporteurs. L'arabe est une seconde langue COMPLETE, pas un
 * repli partiel.
 */
export const DEFAULT_LOCALE: Locale = 'fr';

export type TextDirection = 'ltr' | 'rtl';

export const LOCALE_DIRECTION: Record<Locale, TextDirection> = {
  fr: 'ltr',
  ar: 'rtl',
};

/** Libelle de chaque langue, ecrit DANS cette langue. */
export const LOCALE_LABELS: Record<Locale, string> = {
  fr: 'Francais',
  ar: 'العربية',
};

/**
 * Etiquette BCP 47 complete.
 *
 * `ar-DZ` et non `ar` : le formatage des nombres et des dates differe
 * sensiblement d'un pays arabophone a l'autre. L'arabe algerien utilise les
 * chiffres latins (0-9), la ou `ar-EG` afficherait des chiffres arabes
 * orientaux (٠-٩) — illisibles pour un commercant algerien habitue aux
 * premiers.
 */
export const LOCALE_TAGS: Record<Locale, string> = {
  fr: 'fr-DZ',
  ar: 'ar-DZ',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function isRtl(locale: Locale): boolean {
  return LOCALE_DIRECTION[locale] === 'rtl';
}

export function directionOf(locale: Locale): TextDirection {
  return LOCALE_DIRECTION[locale];
}

/**
 * Choisit la langue a appliquer, par ordre de priorite decroissante.
 *
 * Le premier candidat valide gagne. Cette fonction ne devine jamais : une
 * valeur inconnue est ignoree plutot qu'approximee, et l'on retombe sur la
 * langue par defaut.
 */
export function resolveLocale(...candidates: readonly unknown[]): Locale {
  for (const candidate of candidates) {
    if (isLocale(candidate)) return candidate;
  }
  return DEFAULT_LOCALE;
}

/**
 * Deduit une langue d'un en-tete `Accept-Language`.
 *
 * Utilise UNIQUEMENT a l'inscription, pour proposer un premier reglage
 * plausible. Des qu'un utilisateur a exprime une preference, c'est elle qui
 * fait foi : un en-tete de navigateur n'est pas un choix, c'est un indice.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const quality = params
        .map((param) => /^q=([\d.]+)$/.exec(param.trim())?.[1])
        .find((value) => value !== undefined);
      return {
        base: (tag ?? '').trim().toLowerCase().split('-')[0] ?? '',
        quality: quality === undefined ? 1 : Number.parseFloat(quality),
      };
    })
    .filter((entry) => entry.base.length > 0 && Number.isFinite(entry.quality))
    .sort((a, b) => b.quality - a.quality);

  for (const entry of ranked) {
    if (isLocale(entry.base)) return entry.base;
  }
  return null;
}
