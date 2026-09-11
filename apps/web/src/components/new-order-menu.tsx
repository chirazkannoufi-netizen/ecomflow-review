'use client';

/**
 * Menu de creation de commande, par PROVENANCE.
 *
 * CE QUE LE MENU DIT, ET CE QU'IL NE PROMET PAS
 *   Dix entrees, trois comportements reels — et le menu le montre plutot que de
 *   le cacher derriere dix libelles identiques :
 *
 *     - SAISIE : le formulaire s'ouvre, pre-etiquete avec la provenance.
 *       C'est le cas des six canaux sans connecteur (Facebook, TikTok,
 *       Shopify, WooCommerce, Youcan, Lightfunnels) et du panier abandonne.
 *       L'agent qui saisit une commande arrivee par message TikTok choisit
 *       « Par Prospect TikTok » : la commande est enregistree AVEC cette
 *       provenance, et l'attribution par canal devient calculable des
 *       aujourd'hui, sans attendre aucune integration.
 *
 *     - GABARIT : « Par Excel » telecharge le classeur de saisie. Le depot du
 *       fichier rempli n'existe pas encore, et l'entree le DIT. Proposer un
 *       televersement qui n'aboutit pas ferait perdre a l'agent le temps de
 *       remplir cent lignes avant de s'en apercevoir.
 *
 *     - RENVOI : « Par Google Sheet » mene a l'ecran des integrations, ou la
 *       synchronisation se configure reellement.
 *
 *   C'est la meme regle que pour la matrice transporteur (D-049) : ne jamais
 *   afficher une action que le produit ne sait pas tenir. Ici, on affiche
 *   l'entree — parce qu'elle renseigne sur ce qui existe — mais on annonce ce
 *   qu'elle fait.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PlusCircle } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from './ui';

type EntryKind = 'form' | 'template' | 'link';

interface SourceEntry {
  readonly key: string;
  readonly kind: EntryKind;
  /** Valeur d'`OrderSource` transmise au formulaire. */
  readonly source?: string;
  readonly href?: string;
}

const ENTRIES: readonly SourceEntry[] = [
  { key: 'form', kind: 'form', source: 'MANUAL' },
  { key: 'excel', kind: 'template' },
  { key: 'abandonedCart', kind: 'form', source: 'ABANDONED_CART' },
  { key: 'facebook', kind: 'form', source: 'FACEBOOK' },
  { key: 'tiktok', kind: 'form', source: 'TIKTOK' },
  { key: 'shopify', kind: 'form', source: 'SHOPIFY' },
  { key: 'woocommerce', kind: 'form', source: 'WOOCOMMERCE' },
  { key: 'youcan', kind: 'form', source: 'YOUCAN' },
  { key: 'lightfunnels', kind: 'form', source: 'LIGHTFUNNELS' },
  { key: 'googleSheet', kind: 'link', href: '/integrations' },
];

export function NewOrderMenu() {
  const t = useTranslations('orderSourceMenu');
  const tNav = useTranslations('nav');
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fermeture au clic exterieur et a la touche d'echappement : un menu qui ne
  // se ferme qu'en recliquant sur son bouton piege l'utilisateur des qu'il a
  // change d'avis.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function downloadTemplate() {
    setDownloading(true);
    try {
      await api.download('/geo/order-template.xlsx', 'ecomflow-commandes.xlsx');
      setOpen(false);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="create"
        size="sm"
        icon={<PlusCircle className="h-4 w-4" strokeWidth={1.8} />}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {tNav('newOrder')}
      </Button>

      {open ? (
        <div
          role="menu"
          className="absolute end-0 z-50 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <p className="border-b border-line px-3 py-2 text-xs font-bold text-muted">
            {t('title')}
          </p>

          <ul className="max-h-80 overflow-y-auto py-1">
            {ENTRIES.map((entry) => (
              <li key={entry.key}>
                {entry.kind === 'form' ? (
                  <Link
                    role="menuitem"
                    href={`/commandes/nouvelle?source=${entry.source}`}
                    onClick={() => setOpen(false)}
                    className="block px-3 py-2 text-sm text-ink-2 hover:bg-canvas hover:text-ink"
                  >
                    {t(`entries.${entry.key}`)}
                  </Link>
                ) : entry.kind === 'link' ? (
                  <Link
                    role="menuitem"
                    href={entry.href ?? '/'}
                    onClick={() => setOpen(false)}
                    className="block px-3 py-2 text-sm text-ink-2 hover:bg-canvas hover:text-ink"
                  >
                    {t(`entries.${entry.key}`)}
                  </Link>
                ) : (
                  <button
                    role="menuitem"
                    disabled={downloading}
                    onClick={() => void downloadTemplate()}
                    className="block w-full px-3 py-2 text-start text-sm text-ink-2 hover:bg-canvas hover:text-ink disabled:opacity-60"
                  >
                    <span className="block">{t(`entries.${entry.key}`)}</span>
                    {/* Le depot du fichier rempli n'existe pas encore : le dire
                        ici coute une ligne, le taire coute cent lignes
                        remplies pour rien. */}
                    <span className="block text-xs text-muted">{t('excelHint')}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
