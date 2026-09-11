'use client';

/**
 * Barre d'onglets des ecrans FRERES, au sens des groupes de la barre laterale.
 *
 * D'OU ELLE VIENT
 *   Le centre de confirmation portait une barre « En confirmation / En
 *   preparation / En livraison / En retour », ecrite quand ces quatre etapes
 *   vivaient sur un seul ecran. Le decoupage en ecrans separes l'a laissee sur
 *   place : elle listait des etapes appartenant a DEUX groupes differents, et
 *   n'existait que sur un ecran des quatre.
 *
 *   Elle devient ici un composant, et ses onglets sont DERIVES de la meme
 *   structure que la barre laterale (`navigation.ts`). Ajouter un ecran a un
 *   groupe le fait apparaitre aux deux endroits, sans seconde saisie.
 *
 * TROIS CHOSES QU'ELLE CORRIGE AU PASSAGE
 *   1. Les onglets etaient des `<a>` nus : chaque clic rechargeait
 *      l'application entiere — jeton relu, session revalidee, cache React Query
 *      jete. Ce sont desormais des `<Link>`, donc une navigation cliente.
 *   2. Ils ne portaient pas d'icone, la barre laterale si : le meme ecran se
 *      reconnaissait a deux signes differents selon l'endroit d'ou on le
 *      regardait.
 *   3. Ils ignoraient les permissions. Un preparateur voyait un onglet
 *      « En confirmation » qui le menait a un ecran interdit.
 *
 * ELLE NE S'AFFICHE PAS PARTOUT
 *   Seulement sur les ecrans membres d'un groupe. Produits, Stock ou Clients
 *   n'ont pas de freres : leur coiffer une barre a une seule entree serait du
 *   bruit.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { api } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { findGroupFor } from './navigation';

type AlertCounts = Record<string, number>;

export function GroupTabs() {
  const pathname = usePathname();
  const tNav = useTranslations('nav');
  const { can } = useSession();

  const group = findGroupFor(pathname);

  const { data: alerts } = useQuery({
    queryKey: ['dashboard', 'alerts'],
    queryFn: () => api.get<AlertCounts>('/dashboard/alerts'),
    // Meme cle que la barre laterale : les deux partagent le cache, et les
    // compteurs ne peuvent pas se contredire d'un endroit a l'autre.
    enabled: group !== null,
    refetchInterval: 60_000,
  });

  if (!group) return null;

  const tabs = (group.children ?? []).filter(
    (child) => !child.permission || can(child.permission),
  );

  // Un seul onglet visible n'est plus une barre : c'est un titre redondant
  // avec celui de la page.
  if (tabs.length < 2) return null;

  return (
    <nav className="mb-3 flex flex-wrap gap-1.5" aria-label={tNav(group.labelKey)}>
      {tabs.map((tab) => {
        const current = tab.href !== null && pathname.startsWith(tab.href);
        const count = tab.alertKey ? (alerts?.[tab.alertKey] ?? 0) : 0;
        const Icon = tab.icon;
        const label = tNav(tab.labelKey);

        const inner = (
          <>
            <Icon
              className={clsx('h-4 w-4 shrink-0', current ? 'text-lime' : 'text-muted')}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span>{label}</span>
            {tab.href === null ? (
              <span className="rounded-full bg-canvas px-1.5 text-[10px] font-bold text-muted">
                {tNav('soon')}
              </span>
            ) : count > 0 ? (
              <span
                className={clsx(
                  'tabular rounded-full px-1.5 text-xs font-bold',
                  current ? 'bg-lime text-ink' : 'bg-canvas text-muted',
                )}
              >
                {count}
              </span>
            ) : null}
          </>
        );

        // Ecran pas encore construit : rendu inerte, comme dans la barre
        // laterale. Un onglet qui ne mene nulle part mais reste focusable
        // promet une navigation qui n'existe pas.
        if (tab.href === null) {
          return (
            <span
              key={tab.labelKey}
              title={tNav('soonHint')}
              className="flex cursor-default items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-muted opacity-60"
            >
              {inner}
            </span>
          );
        }

        return (
          <Link
            key={tab.labelKey}
            href={tab.href}
            aria-current={current ? 'page' : undefined}
            className={clsx(
              'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors',
              current
                ? 'bg-ink text-white'
                : 'border border-line bg-surface text-ink-2 hover:bg-canvas',
            )}
          >
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}
