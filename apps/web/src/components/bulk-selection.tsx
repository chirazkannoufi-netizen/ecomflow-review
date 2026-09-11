'use client';

/**
 * Selection de lignes et archivage en masse — Commandes, Clients, Produits.
 *
 * POURQUOI UN COMPOSANT COMMUN
 *   Le geste est le meme sur les trois ecrans : cocher, tout cocher, archiver
 *   la selection. Le recopier trois fois ferait diverger trois details qui
 *   comptent — la borne de selection, le libelle de confirmation, et surtout
 *   la facon de rendre compte d'un lot PARTIELLEMENT traite.
 *
 * LA SELECTION NE SURVIT PAS AU CHANGEMENT DE PAGE
 *   Elle est bornee aux lignes VISIBLES. Une selection qui persiste a travers
 *   la pagination donne un compteur que l'on ne peut plus verifier des yeux :
 *   « 47 selectionnes » sur un ecran qui en montre vingt oblige a croire le
 *   chiffre sur parole avant de cliquer sur une action destructive. Le hook
 *   vide donc la selection des que le jeu de lignes change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, ConfirmDialog } from './ui';

export interface RowSelection {
  readonly selected: ReadonlySet<string>;
  readonly count: number;
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  readonly toggle: (id: string) => void;
  readonly toggleAll: () => void;
  readonly clear: () => void;
  readonly isSelected: (id: string) => boolean;
}

/**
 * @param visibleIds identifiants des lignes actuellement affichees, dans
 *        l'ordre d'affichage. Toute modification de ce tableau (page suivante,
 *        filtre, recherche) remet la selection a zero.
 */
export function useRowSelection(visibleIds: readonly string[]): RowSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // `join` plutot que la reference du tableau : la liste est reconstruite a
  // chaque rendu par `map`, et comparer les references viderait la selection
  // au premier re-rendu venu — y compris celui que provoque le fait de cocher.
  const signature = visibleIds.join(',');

  useEffect(() => {
    setSelected(new Set());
  }, [signature]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((current) =>
      current.size === visibleIds.length ? new Set() : new Set(visibleIds),
    );
  }, [visibleIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  return useMemo(
    () => ({
      selected,
      count: selected.size,
      allSelected: visibleIds.length > 0 && selected.size === visibleIds.length,
      someSelected: selected.size > 0 && selected.size < visibleIds.length,
      toggle,
      toggleAll,
      clear,
      isSelected: (id: string) => selected.has(id),
    }),
    [selected, visibleIds.length, toggle, toggleAll, clear],
  );
}

/** Case a cocher d'en-tete, avec l'etat INTERMEDIAIRE quand la page est partiellement cochee. */
export function SelectAllCheckbox({
  selection,
  disabled,
}: {
  selection: RowSelection;
  disabled?: boolean;
}) {
  const t = useTranslations('bulk');

  return (
    <input
      type="checkbox"
      className="align-middle"
      checked={selection.allSelected}
      // `indeterminate` n'existe qu'en propriete DOM, jamais en attribut :
      // sans ce `ref`, une page a moitie cochee afficherait une case VIDE,
      // donc suggererait qu'un clic va tout cocher alors qu'il va tout vider.
      ref={(node) => {
        if (node) node.indeterminate = selection.someSelected;
      }}
      disabled={disabled}
      onChange={selection.toggleAll}
      aria-label={t('selectAll')}
    />
  );
}

export function RowCheckbox({
  id,
  selection,
  label,
}: {
  id: string;
  selection: RowSelection;
  label: string;
}) {
  const t = useTranslations('bulk');

  return (
    <input
      type="checkbox"
      className="align-middle"
      checked={selection.isSelected(id)}
      onChange={() => selection.toggle(id)}
      aria-label={t('selectRow', { label })}
    />
  );
}

export interface BulkArchiveSkip {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export interface BulkArchiveResult {
  readonly archived: number;
  readonly skipped: readonly BulkArchiveSkip[];
}

/**
 * Barre d'action de la selection, avec confirmation nommant le NOMBRE de
 * lignes.
 *
 * POURQUOI LE NOMBRE, ET PAS SEULEMENT « Confirmer ? »
 *   C'est le seul chiffre que l'agent peut recouper avec ce qu'il voit. Une
 *   confirmation generique valide une intention ; une confirmation qui annonce
 *   « archiver 12 lignes » valide une PORTEE, et c'est la portee qui derape —
 *   un « tout cocher » mal place, un clic sur la mauvaise ligne.
 */
export function BulkActionBar({
  selection,
  pending,
  result,
  onArchive,
  onDismissResult,
}: {
  selection: RowSelection;
  pending: boolean;
  result: BulkArchiveResult | null;
  onArchive: () => void;
  onDismissResult: () => void;
}) {
  const t = useTranslations('bulk');
  const tCommon = useTranslations('common');
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      {result ? (
        <div className="mb-3">
          <Alert
            tone={result.skipped.length > 0 ? 'warning' : 'success'}
            title={t('doneTitle', { count: result.archived })}
            action={
              <button
                className="text-xs font-semibold underline underline-offset-2"
                onClick={onDismissResult}
              >
                {tCommon('close')}
              </button>
            }
          >
            {result.skipped.length === 0 ? (
              t('doneAll')
            ) : (
              <>
                {/* Le motif est rendu ligne par ligne : « 2 non archivees »
                    sans dire pourquoi renverrait l'agent essayer au hasard. */}
                <p>{t('doneSkipped', { count: result.skipped.length })}</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {result.skipped.map((skip) => (
                    <li key={skip.id}>{skip.message}</li>
                  ))}
                </ul>
              </>
            )}
          </Alert>
        </div>
      ) : null}

      {selection.count > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="text-sm font-semibold text-ink">
            {t('selectedCount', { count: selection.count })}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={selection.clear}>
            {t('clearSelection')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={pending}
            onClick={() => setConfirming(true)}
          >
            {t('archiveSelection')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        danger
        loading={pending}
        title={t('confirmTitle', { count: selection.count })}
        message={t('confirmBody')}
        confirmLabel={t('confirmAction', { count: selection.count })}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onArchive();
        }}
      />
    </>
  );
}
