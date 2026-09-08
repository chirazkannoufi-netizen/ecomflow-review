import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { Manrope, IBM_Plex_Mono, IBM_Plex_Sans_Arabic } from 'next/font/google';
import type { ReactNode } from 'react';
import { directionOf } from '@ecomflow/shared';
import './globals.css';
import { LOCALE_COOKIE, localeFromCookieHeader } from '@/i18n/locale-cookie';
import { Providers } from './providers';

/**
 * `display: 'swap'` affiche immediatement le texte avec la police de secours
 * plutot que de laisser un ecran blanc pendant le telechargement : sur une
 * connexion mobile algerienne, la difference est tres perceptible.
 *
 * TROIS POLICES, UNE SEULE FAMILLE VISUELLE
 *   Manrope porte l'interface latine, IBM Plex Sans Arabic l'interface arabe,
 *   IBM Plex Mono les identifiants (reference de commande, SKU, code OTP).
 *
 *   Manrope ne contient AUCUN glyphe arabe : sans police dediee, l'arabe
 *   retombait sur la police systeme — Times/Arial selon la machine, avec des
 *   hauteurs de ligne et une graisse qui ne correspondent a rien du systeme
 *   de design. IBM Plex Sans Arabic est choisie parce qu'elle partage la
 *   construction et les proportions d'IBM Plex Mono deja utilisee pour les
 *   identifiants : les deux ecritures cohabitent alors dans une meme ligne
 *   (« ORD-2026-000418 » dans une phrase arabe) sans rupture de style.
 *
 *   L'alternance est faite en CSS par `html[lang="ar"]` (voir globals.css),
 *   et non par une condition React : l'attribut `lang` est deja pose sur
 *   <html> par le serveur PUIS par le changement de langue cote client, donc
 *   la bascule de police suit exactement la bascule de direction, sans
 *   rendu intermediaire dans la mauvaise police.
 */
const manrope = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-manrope',
});

const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-plex-arabic',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['500', '600'],
  display: 'swap',
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: {
    default: 'EcomFlow',
    template: '%s — EcomFlow',
  },
  description:
    'Plateforme de gestion et d automatisation des operations e-commerce : ' +
    'commandes, confirmation, preparation, expedition, tracking, retours et rentabilite.',
  // L'application est un outil interne : elle n'a pas vocation a etre indexee.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#171A2D',
};

/**
 * La langue est resolue COTE SERVEUR, depuis le cookie.
 *
 * C'est ce qui permet de servir `<html dir="rtl">` des le premier octet. Sans
 * cela, un utilisateur arabophone verrait la page s'afficher alignee a gauche
 * puis se retourner entierement une fois la session chargee — un clignotement
 * particulierement desagreable en RTL, ou c'est toute la mise en page qui
 * bascule, pas seulement le texte.
 *
 * Le cookie n'est qu'un cache : la source de verite reste `User.locale`, et le
 * client realigne les deux des que la session est connue.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const locale = localeFromCookieHeader(
    store.has(LOCALE_COOKIE) ? `${LOCALE_COOKIE}=${store.get(LOCALE_COOKIE)?.value ?? ''}` : null,
  );

  return (
    <html
      lang={locale}
      dir={directionOf(locale)}
      className={`${manrope.variable} ${plexArabic.variable} ${plexMono.variable}`}
    >
      <body>
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
