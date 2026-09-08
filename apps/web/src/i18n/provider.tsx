'use client';

/**
 * Fournisseur de langue — francais / arabe.
 *
 * BIBLIOTHEQUE : next-intl, en mode NON ROUTE.
 *
 *   next-intl est generalement utilise avec un segment d'URL (`/fr/...`,
 *   `/ar/...`). Ce n'est PAS ce que fait EcomFlow, et c'est delibere : la
 *   preference de langue est portee par l'UTILISATEUR, pas par l'adresse.
 *   Un agent qui envoie le lien d'une commande a un collegue ne doit pas lui
 *   imposer sa langue au passage, et l'URL d'une commande doit rester la meme
 *   pour tout le monde — c'est ce qui la rend citable dans un ticket.
 *
 *   Ce qu'on garde de next-intl : le formatage ICU. C'est la raison du choix.
 *   L'arabe possede SIX formes plurielles (zero, one, two, few, many, other)
 *   la ou le francais en a deux. Une implementation maison ferait
 *   inevitablement du « 3 commande(s) », acceptable en francais et faux en
 *   arabe. ICU resout cela correctement, et gere aussi les dates et nombres
 *   au format `ar-DZ`.
 *
 * DEUX SOURCES, UNE AUTORITE
 *   Le cookie donne la langue AVANT le premier rendu, ce qui evite un
 *   clignotement LTR -> RTL. La session, une fois chargee, fait autorite et
 *   realigne le cookie. Voir `locale-cookie.ts`.
 */

import { NextIntlClientProvider } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_TAGS,
  directionOf,
  type Locale,
  type TextDirection,
} from '@ecomflow/shared';
import { setErrorMessageResolver } from '@/lib/api-client';
import { readLocaleCookie, writeLocaleCookie } from './locale-cookie';
import ar from './messages/ar.json';
import fr from './messages/fr.json';

/**
 * Les deux catalogues sont embarques dans le bundle.
 *
 * Un chargement paresseux par langue economiserait quelques dizaines de
 * kilooctets, au prix d'un ecran vide pendant le telechargement a chaque
 * changement de langue. Sur une connexion mobile algerienne, l'attente est
 * plus couteuse que les octets : la traduction est de la structure, pas de la
 * donnee.
 */
// Le catalogue arabe est structurellement identique au francais : un test
// (`messages.spec.ts`) le verifie cle par cle, ce qui rend toute assertion
// de type superflue ici.
const MESSAGES: Record<Locale, typeof fr> = { fr, ar };

interface LocaleContextValue {
  readonly locale: Locale;
  readonly direction: TextDirection;
  readonly isRtl: boolean;
  /** Change la langue affichee. La persistance serveur est faite par l'appelant. */
  readonly setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  /** Langue rendue cote serveur, lue du cookie. */
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);

  // Au montage UNIQUEMENT : le cookie peut etre plus a jour que ce qu'a rendu
  // le serveur (page servie depuis un cache, par exemple). Ensuite, c'est
  // `setLocale` qui fait foi — reagir a `locale` ici creerait une boucle.
  //
  // La forme fonctionnelle de `setLocaleState` evite d'avoir `locale` en
  // dependance : la comparaison se fait sur la valeur courante fournie par
  // React, ce qui rend la liste de dependances vide et CORRECTE.
  useEffect(() => {
    const cached = readLocaleCookie();
    if (cached) setLocaleState((current) => (cached === current ? current : cached));
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeLocaleCookie(next);
  }, []);

  // Les erreurs de l'API sont traduites a partir de leur CODE, dans la langue
  // active. Sans cela, un message francais du backend s'afficherait tel quel
  // au milieu d'une page arabe — c'est le defaut que ce branchement corrige,
  // pour tous les ecrans a la fois.
  useEffect(() => {
    const table = MESSAGES[locale].errors as Record<string, string | undefined>;
    setErrorMessageResolver((code) => table[code] ?? null);
  }, [locale]);

  // `dir` et `lang` sont poses sur <html> : c'est le seul endroit qui retourne
  // REELLEMENT la mise en page. Les poser sur un <div> interne laisserait les
  // barres de defilement et les menus natifs du mauvais cote.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', locale);
    root.setAttribute('dir', directionOf(locale));
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      direction: directionOf(locale),
      isRtl: directionOf(locale) === 'rtl',
      setLocale,
    }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <NextIntlClientProvider
        locale={LOCALE_TAGS[locale]}
        messages={MESSAGES[locale]}
        timeZone="Africa/Algiers"
        now={undefined}
        onError={(error) => {
          // Une cle manquante ne doit JAMAIS faire tomber un ecran : mieux
          // vaut afficher la cle brute et corriger la traduction, que
          // presenter une page blanche a un agent en pleine journee d'appels.
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[i18n] ${error.message}`);
          }
        }}
        getMessageFallback={({ key, namespace }) =>
          namespace ? `${namespace}.${key}` : key
        }
      >
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}

export function useLocalePreference(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useLocalePreference doit etre utilise dans <LocaleProvider>.');
  }
  return context;
}
