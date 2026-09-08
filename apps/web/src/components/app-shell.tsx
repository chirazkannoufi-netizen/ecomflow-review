'use client';

/**
 * Coque applicative : navigation laterale, bandeau d'abonnement, en-tete.
 *
 * NAVIGATION FILTREE PAR LES DROITS
 *   Une entree dont l'utilisateur n'a pas la permission n'est pas affichee.
 *   Ce n'est PAS une mesure de securite — le serveur decide seul — mais une
 *   mesure d'ergonomie : montrer a un preparateur un menu « Abonnement » qui
 *   repond 403 est une mauvaise experience.
 */

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Boxes,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Phone,
  Plug,
  PlusCircle,
  Search,
  Settings,
  ShieldCheck,
  TrendingUp,
  Truck,
  Undo2,
  UserCog,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { PERMISSIONS } from '@ecomflow/shared';
import { api } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { subscriptionReasonKey } from '@/lib/subscription-reason';
import { LanguageSwitcher } from './language-switcher';
import { Badge, Button, LoadingState } from './ui';

interface NavEntry {
  readonly href: string;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  /** Permission requise pour afficher l'entree. */
  readonly permission?: string;
  /** Cle du compteur d'alerte a afficher en pastille. */
  readonly alertKey?: 'pendingConfirmation' | 'lowStock' | 'failedImports' | 'pendingDuplicates';
}

/**
 * Navigation, dans l'ordre du cahier des charges (V1 §26, V2 §25).
 *
 * Les entrees portent une CLE de traduction (`nav.orders`) et non un libelle :
 * c'est ce qui permet a la barre laterale de basculer en arabe sans dupliquer
 * la structure du menu.
 */
const NAVIGATION: readonly { sectionKey: string; entries: readonly NavEntry[] }[] = [
  {
    sectionKey: 'pilotage',
    entries: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard, permission: PERMISSIONS.DASHBOARD_VIEW },
      {
        href: '/rentabilite',
        labelKey: 'profitability',
        icon: TrendingUp,
        permission: PERMISSIONS.PROFITABILITY_VIEW,
      },
    ],
  },
  {
    sectionKey: 'operations',
    entries: [
      {
        href: '/confirmation',
        labelKey: 'confirmation',
        icon: Phone,
        permission: PERMISSIONS.CONFIRMATION_MANAGE,
        alertKey: 'pendingConfirmation',
      },
      { href: '/commandes', labelKey: 'orders', icon: ClipboardList, permission: PERMISSIONS.ORDERS_READ },
      {
        href: '/preparation',
        labelKey: 'preparation',
        icon: Package,
        permission: PERMISSIONS.PREPARATION_MANAGE,
      },
      {
        href: '/expeditions',
        labelKey: 'shipments',
        icon: Truck,
        permission: PERMISSIONS.SHIPMENTS_READ,
      },
      { href: '/retours', labelKey: 'returns', icon: Undo2, permission: PERMISSIONS.RETURNS_READ },
    ],
  },
  {
    sectionKey: 'catalogue',
    entries: [
      { href: '/produits', labelKey: 'products', icon: Boxes, permission: PERMISSIONS.PRODUCTS_READ },
      {
        href: '/stock',
        labelKey: 'stock',
        icon: Warehouse,
        permission: PERMISSIONS.INVENTORY_READ,
        alertKey: 'lowStock',
      },
      { href: '/clients', labelKey: 'customers', icon: Users, permission: PERMISSIONS.CUSTOMERS_READ },
    ],
  },
  {
    sectionKey: 'administration',
    entries: [
      {
        href: '/integrations',
        labelKey: 'integrations',
        icon: Plug,
        permission: PERMISSIONS.INTEGRATIONS_READ,
        alertKey: 'failedImports',
      },
      { href: '/utilisateurs', labelKey: 'users', icon: UserCog, permission: PERMISSIONS.USERS_READ },
      { href: '/abonnement', labelKey: 'subscription', icon: CreditCard, permission: PERMISSIONS.BILLING_VIEW },
      { href: '/parametres', labelKey: 'settings', icon: Settings, permission: PERMISSIONS.SETTINGS_MANAGE },
    ],
  },
];

interface SubscriptionState {
  readonly status: string;
  readonly operational: boolean;
  readonly reason: string;
  readonly trialDaysRemaining: number | null;
}

interface AlertCounts {
  readonly pendingConfirmation: number;
  readonly lowStock: number;
  readonly failedImports: number;
  readonly pendingDuplicates: number;
  readonly integrationsInError: number;
}

/** Initiales d'affichage — avatar circulaire quand aucune photo n'existe. */
function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0]![0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations('common');
  const tNav = useTranslations('nav');
  const tBanner = useTranslations('subscriptionBanner');
  const { user, tenant, role, can, loading, logout } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');

  // Redirection vers la connexion des que la session est connue comme absente.
  useEffect(() => {
    if (!loading && !user) router.replace('/connexion');
  }, [loading, user, router]);

  const { data: subscription } = useQuery({
    queryKey: ['subscription', 'current'],
    queryFn: () => api.get<SubscriptionState>('/subscriptions/current'),
    enabled: Boolean(user) && can(PERMISSIONS.BILLING_VIEW),
    // L'etat d'abonnement conditionne l'acces : on le rafraichit regulierement.
    refetchInterval: 5 * 60_000,
  });

  const { data: alerts } = useQuery({
    queryKey: ['dashboard', 'alerts'],
    queryFn: () => api.get<AlertCounts>('/dashboard/alerts'),
    enabled: Boolean(user) && can(PERMISSIONS.DASHBOARD_VIEW),
    refetchInterval: 60_000,
  });

  const sections = useMemo(
    () =>
      NAVIGATION.map((section) => ({
        ...section,
        entries: section.entries.filter((entry) => !entry.permission || can(entry.permission)),
      })).filter((section) => section.entries.length > 0),
    [can],
  );

  // Le motif de blocage vient du serveur EN FRANCAIS : il est retraduit a
  // partir du statut, sans quoi le bandeau le plus visible de l'application
  // restait francais en arabe. Voir `lib/subscription-reason.ts`.
  const reasonKey = subscription ? subscriptionReasonKey(subscription.status) : null;

  function submitSearch(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || !searchValue.trim()) return;
    router.push(`/commandes?recherche=${encodeURIComponent(searchValue.trim())}`);
  }

  if (loading) return <LoadingState label={t('openingWorkspace')} />;
  if (!user) return null;

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* --- Navigation laterale --- */}
      <aside
        className={clsx(
          // `fixed` a TOUTES les tailles d'ecran (et non uniquement en
          // mobile) : la navigation reste ancree et visible pendant que le
          // contenu defile, comme sur chaque maquette du systeme de design.
          // Le contenu principal compense avec un `lg:ms-64` (ci-dessous).
          'fixed inset-y-0 start-0 z-40 flex w-64 shrink-0 flex-col overflow-y-auto border-e border-line bg-surface',
          'transition-transform',
          // `translate` n'a pas d'equivalent logique dans Tailwind : le tiroir
          // se cache VERS LA GAUCHE en francais et VERS LA DROITE en arabe,
          // ou la barre laterale est ancree a droite. La variante `rtl:`
          // inverse donc le signe explicitement.
          //
          // LA RETRACTATION EST BORNEE PAR `max-lg`, PAS RATTRAPEE PAR UNE
          // VARIANTE `lg`.
          //   La forme precedente posait le decalage RTL sans condition de
          //   largeur, puis le remettait a zero au-dela de `lg`. Elle FAISAIT
          //   DISPARAITRE LA BARRE LATERALE ARABE A TOUTES LES LARGEURS :
          //   Tailwind compile la variante directionnelle en un
          //   `:where([dir=...])` de specificite NULLE, et une requete media
          //   n'en ajoute pas davantage — les deux regles pesaient donc une
          //   classe chacune, et le depart se jouait a l'ordre d'emission, ou
          //   la direction passe APRES la largeur.
          //
          //   Borner la retractation supprime le conflit au lieu de
          //   l'arbitrer : au-dela de `lg` plus aucune regle ne s'applique.
          //   En dessous, les deux variantes cohabitent dans la MEME requete
          //   media, ou l'ordre (base puis direction) joue dans le bon sens.
          //
          //   Ne pas nommer ici les classes ecartees : le scanner de Tailwind
          //   lit AUSSI les commentaires et regenererait les regles retirees.
          sidebarOpen ? 'translate-x-0' : 'max-lg:-translate-x-full max-lg:rtl:translate-x-full',
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-sm font-extrabold text-lime">
            E
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-ink">{tenant?.name ?? 'EcomFlow'}</p>
            {role ? <p className="truncate text-xs text-muted">{role}</p> : null}
          </div>
        </div>

        <nav className="flex-1 p-3">
          {sections.map((section) => (
            <div key={section.sectionKey} className="mb-4">
              <p className="eyebrow px-2.5 pb-1.5">{tNav(`sections.${section.sectionKey}`)}</p>
              <ul className="space-y-0.5">
                {section.entries.map((entry) => {
                  const active =
                    entry.href === '/' ? pathname === '/' : pathname.startsWith(entry.href);
                  const count = entry.alertKey ? (alerts?.[entry.alertKey] ?? 0) : 0;
                  const Icon = entry.icon;

                  return (
                    <li key={entry.href}>
                      <Link
                        href={entry.href}
                        onClick={() => setSidebarOpen(false)}
                        className={clsx(
                          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors',
                          active
                            ? 'bg-ink text-white'
                            : 'text-ink-2 hover:bg-canvas',
                        )}
                      >
                        <Icon
                          className={clsx('h-4 w-4 shrink-0', active ? 'text-lime' : 'text-muted')}
                          strokeWidth={1.6}
                          aria-hidden="true"
                        />
                        <span className="flex-1 truncate">{tNav(entry.labelKey)}</span>
                        {count > 0 ? (
                          <span
                            className={clsx(
                              'tabular rounded-full px-1.5 py-0.5 text-[11px] font-bold',
                              active ? 'bg-lime text-ink' : 'bg-peach text-peach-deep',
                            )}
                          >
                            {count > 99 ? '99+' : count}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* --- Bandeau d'essai, non bloquant --- */}
        {subscription?.operational && subscription.status === 'TRIAL_ENDING' ? (
          <div className="m-3 mt-0 shrink-0 rounded-xl bg-lime-wash p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-ink">{tBanner('trialEnding', { days: subscription.trialDaysRemaining ?? 0 })}</p>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70">
              <div
                className="h-full rounded-full bg-ink"
                style={{
                  width: `${Math.max(6, 100 - (subscription.trialDaysRemaining ?? 0) * 14)}%`,
                }}
              />
            </div>
            <Link
              href="/abonnement"
              className="mt-2 flex items-center gap-1 text-xs font-bold text-ink-2 hover:underline"
            >
              {tBanner('action')}
              {/* `rtl:-scale-x-100` : la fleche pointe vers l'avant du sens de
                  lecture, donc vers la gauche en arabe. */}
              <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        ) : null}
      </aside>

      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      {/* --- Contenu --- */}
      <div className="flex min-w-0 flex-1 flex-col lg:ms-64">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface px-4">
          <button
            className="rounded-md p-1.5 text-ink-2 hover:bg-canvas lg:hidden"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label={tNav('openMenu')}
          >
            <Menu className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
          </button>

          <div className="relative hidden max-w-sm flex-1 sm:block">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              onKeyDown={submitSearch}
              placeholder={tNav('searchPlaceholder')}
              className="h-9 w-full rounded-md border border-line bg-canvas ps-9 pe-3 text-sm text-ink placeholder:text-muted focus:border-ink focus:bg-white"
            />
          </div>

          <div className="flex-1 sm:hidden" />

          <div className="flex items-center gap-2">
            {can(PERMISSIONS.ORDERS_CREATE) ? (
              <Link href="/commandes/nouvelle" className="hidden sm:block">
                <Button variant="create" size="sm" icon={<PlusCircle className="h-4 w-4" strokeWidth={1.8} />}>
                  {tNav('newOrder')}
                </Button>
              </Link>
            ) : null}

            <LanguageSwitcher className="hidden sm:block" />

            <div className="mx-1 hidden h-6 w-px bg-line sm:block" />

            <div className="hidden text-end sm:block">
              <p className="text-sm font-bold text-ink">{user.fullName}</p>
              <p className="text-xs text-muted">{user.email}</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">
              {initialsOf(user.fullName)}
            </div>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-canvas"
              onClick={() => void logout()}
              aria-label={t('logout')}
              title={t('logout')}
            >
              <LogOut className="h-4 w-4 rtl:-scale-x-100" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* --- Bandeau d'abonnement bloquant : reste tout en haut du contenu,
              impossible a manquer, tant que l'acces est effectivement limite. --- */}
        {subscription && !subscription.operational ? (
          <div className="border-b border-danger/30 bg-danger/10 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="danger">
                <ShieldCheck className="me-1 inline h-3 w-3" strokeWidth={2} aria-hidden="true" />
                {tBanner('suspendedBadge')}
              </Badge>
              {/* `min-w-0` : sans lui, un motif long ne peut pas se reduire
                  sous sa largeur de contenu (regle `min-width:auto` des
                  elements flex) et pousse le bouton hors de la ligne. */}
              <p className="min-w-0 flex-1 text-sm font-medium text-danger">
                {reasonKey ? tBanner(reasonKey) : subscription.reason || tBanner('suspended')}
              </p>
              {/* `ms-auto` (logique) colle le bouton a la FIN de la ligne :
                  a droite en francais, a gauche en arabe. `shrink-0` lui
                  garde sa largeur quelle que soit la longueur du motif —
                  sa position ne depend donc plus de la langue. */}
              <Link href="/abonnement" className="ms-auto shrink-0">
                <Button size="sm">{tBanner('action')}</Button>
              </Link>
            </div>
            <p className="mt-1 text-xs text-danger/80">{tBanner('dataStillReadable')}</p>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

/** En-tete de page : titre, description et actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-title text-ink">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
