'use client';

/**
 * Stock — V1 §8, V2 §10.
 *
 * TROIS CHIFFRES, PAS UN SEUL.
 *   Le commercant algerien raisonne en « ce qu'il me reste ». Or en paiement a
 *   la livraison, une commande confirmee immobilise du stock sans l'avoir
 *   consomme. Afficher un seul nombre conduirait a survendre. L'ecran montre
 *   donc systematiquement : physique, reserve, et disponible a la vente.
 *
 * LA RECONCILIATION EST VISIBLE.
 *   Le stock projete doit toujours egaler la somme des mouvements. L'ecart est
 *   signale ici, jamais corrige en silence : un ecart est un defaut d'ecriture,
 *   et le masquer reviendrait a mentir sur l'inventaire.
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { PERMISSIONS, dinarsToCentimes } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Money,
  Textarea,
  formatDate,
  formatDateTime,
} from '@/components/ui';

interface LowStockEntry {
  readonly variantId: string;
  readonly sku: string;
  readonly variantLabel: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly quarantine: number;
  readonly available: number;
  readonly lowStockThreshold: number;
  readonly isLow: boolean;
}

interface Movement {
  readonly id: string;
  readonly type: string;
  readonly quantity: number;
  readonly referenceType: string;
  readonly referenceId: string | null;
  readonly note: string | null;
  readonly onHandAfter: number;
  readonly reservedAfter: number;
  readonly quarantineAfter: number;
  readonly createdAt: string;
}

interface StockBatch {
  readonly id: string;
  readonly reference: string | null;
  readonly quantity: number;
  readonly remainingQuantity: number;
  readonly costCentimes: number;
  readonly expiresAt: string | null;
  readonly receivedAt: string;
  readonly note: string | null;
}

interface Reconciliation {
  readonly consistent: boolean;
  readonly discrepancies: readonly {
    variantId: string;
    sku: string;
    projected: number;
    computed: number;
  }[];
}

export default function StockPage() {
  const t = useTranslations('stock');
  const tCommon = useTranslations('common');
  const { can } = useSession();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<LowStockEntry | null>(null);
  const [mode, setMode] = useState<'inbound' | 'adjust'>('inbound');
  /**
   * Recherche LOCALE de cet ecran, distincte de celle de l'en-tete.
   *
   * `/inventory/low-stock` renvoie la liste complete des declinaisons sous
   * seuil, sans pagination : le filtrage se fait donc ici, sur les donnees
   * deja chargees. Aucun aller-retour reseau, et le compte affiche reste juste
   * puisque rien n'est tronque cote serveur.
   */
  const [search, setSearch] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // --- Suivi par lot ------------------------------------------------------
  // `batchOpen` reste ouvert d'une reception a l'autre : une boutique qui suit
  // ses couts les suit pour tout, et rouvrir la section a chaque saisie serait
  // une friction quotidienne pour un choix fait une fois.
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchCost, setBatchCost] = useState('');
  const [batchExpiry, setBatchExpiry] = useState('');
  const [batchReference, setBatchReference] = useState('');
  const [showExhausted, setShowExhausted] = useState(false);

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE);

  const lowStockQuery = useQuery({
    queryKey: ['inventory', 'low-stock'],
    queryFn: () => api.get<LowStockEntry[]>('/inventory/low-stock'),
  });

  // Nom de produit, declinaison ou SKU : l'agent cherche avec ce qu'il a sous
  // la main, un code-barres comme un nom de robe.
  const alertsSearch = search.trim().toLowerCase();
  const visibleAlerts = (lowStockQuery.data ?? []).filter((entry) => {
    if (!alertsSearch) return true;
    return [entry.productName, entry.variantLabel ?? '', entry.sku]
      .join(' ')
      .toLowerCase()
      .includes(alertsSearch);
  });

  const reconciliationQuery = useQuery({
    queryKey: ['inventory', 'reconciliation'],
    queryFn: () => api.get<Reconciliation>('/inventory/reconciliation'),
    enabled: canManage,
  });

  const movementsQuery = useQuery({
    queryKey: ['inventory', 'movements', selected?.variantId],
    queryFn: () => api.get<Movement[]>(`/inventory/variants/${selected?.variantId}/movements`),
    enabled: Boolean(selected),
  });

  const batchesQuery = useQuery({
    queryKey: ['inventory', 'batches', selected?.variantId, showExhausted],
    queryFn: () =>
      api.get<StockBatch[]>(`/inventory/variants/${selected?.variantId}/batches`, {
        query: { includeExhausted: showExhausted || undefined },
      }),
    enabled: Boolean(selected),
  });

  /** Horizon d'alerte de peremption : trente jours. */
  const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const stockMutation = useMutation({
    mutationFn: () => {
      const value = Number(quantity);
      if (mode === 'inbound') {
        // Le cout est le SEUL declencheur de lot : sans lui, la reception reste
        // un simple incrementement du compteur, comme avant.
        const cost = batchCost.trim() ? dinarsToCentimes(batchCost) : null;

        return api.post(`/inventory/variants/${selected?.variantId}/inbound`, {
          quantity: value,
          note: note.trim() || undefined,
          ...(cost !== null
            ? {
                costCentimes: cost,
                ...(batchExpiry ? { expiresAt: new Date(batchExpiry).toISOString() } : {}),
                ...(batchReference.trim() ? { batchReference: batchReference.trim() } : {}),
              }
            : {}),
        });
      }
      return api.post(`/inventory/variants/${selected?.variantId}/adjust`, {
        delta: value,
        note: note.trim(),
      });
    },
    onSuccess: () => {
      setQuantity('');
      setNote('');
      setBatchCost('');
      setBatchExpiry('');
      setBatchReference('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (caught) => {
      setFormError(caught instanceof ApiError ? caught.userMessage : t('operationFailed'));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const value = Number(quantity);
    if (!Number.isInteger(value) || (mode === 'inbound' && value < 1) || value === 0) {
      setFormError(mode === 'inbound' ? t('invalidInbound') : t('invalidAdjust'));
      return;
    }

    if (mode === 'adjust' && !note.trim()) {
      setFormError(t('reasonRequired'));
      return;
    }

    if (mode === 'inbound' && batchCost.trim()) {
      const cost = dinarsToCentimes(batchCost);
      if (cost === null || cost < 0) {
        setFormError(t('invalidBatchCost'));
        return;
      }
    }

    stockMutation.mutate();
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
      />

      {/* --- Reconciliation ------------------------------------------------- */}
      {canManage && reconciliationQuery.data && !reconciliationQuery.data.consistent ? (
        <div className="mb-3">
          <Alert tone="danger" title={t('discrepancyTitle')}>
            <p className="text-sm">{t('discrepancyIntro')}</p>
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {reconciliationQuery.data.discrepancies.map((entry) => (
                <li key={entry.variantId} className="font-mono">
                  {t('discrepancyLine', {
                    sku: entry.sku,
                    projected: entry.projected,
                    computed: entry.computed,
                    difference: `${entry.projected - entry.computed > 0 ? '+' : ''}${
                      entry.projected - entry.computed
                    }`,
                  })}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- Alertes de stock --------------------------------------------- */}
        <Card
          title={t('alertsTitle')}
          className="lg:col-span-2"
          padded={false}
          footer={
            canManage && reconciliationQuery.data?.consistent ? (
              <p className="text-xs text-success">{t('consistent')}</p>
            ) : null
          }
        >
          <div className="border-b border-line p-3">
            <Input
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {lowStockQuery.isLoading ? (
            <LoadingState />
          ) : lowStockQuery.error ? (
            <ErrorState
              message={
                lowStockQuery.error instanceof ApiError
                  ? lowStockQuery.error.userMessage
                  : tCommon('loadFailed')
              }
              onRetry={() => void lowStockQuery.refetch()}
            />
          ) : visibleAlerts.length === 0 ? (
            <EmptyState
              title={t('noAlertTitle')}
              description={t('noAlert')}
              action={
                <Link href="/produits">
                  <span className="text-sm text-brand-700 underline">{t('viewCatalog')}</span>
                </Link>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('columns.variant')}</th>
                    <th>{t('columns.sku')}</th>
                    <th className="text-end">{t('columns.physical')}</th>
                    <th className="text-end">{t('columns.reserved')}</th>
                    <th className="text-end">{t('columns.available')}</th>
                    <th className="text-end">{t('columns.threshold')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleAlerts.map((entry) => (
                    <tr
                      key={entry.variantId}
                      className={
                        selected?.variantId === entry.variantId ? 'bg-brand-50/60' : undefined
                      }
                    >
                      <td>
                        <p className="font-medium text-slate-800">{entry.productName}</p>
                        {entry.variantLabel ? (
                          <p className="text-xs text-slate-500">{entry.variantLabel}</p>
                        ) : null}
                      </td>
                      <td className="font-mono text-xs text-slate-600">{entry.sku}</td>
                      <td className="tabular text-end">{entry.onHand}</td>
                      <td className="tabular text-end text-slate-500">{entry.reserved}</td>
                      <td className="text-end">
                        <span
                          className={
                            entry.available <= 0
                              ? 'tabular font-semibold text-danger'
                              : 'tabular font-medium text-warning'
                          }
                        >
                          {entry.available}
                        </span>
                        {entry.quarantine > 0 ? (
                          <Badge tone="neutral" className="ms-1.5">
                            {t('quarantined', { count: entry.quarantine })}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="tabular text-end text-slate-500">
                        {entry.lowStockThreshold}
                      </td>
                      <td className="text-end">
                        <button
                          className="text-xs text-brand-700 hover:underline"
                          onClick={() => {
                            setSelected(entry);
                            setFormError(null);
                          }}
                        >
                          {t('manage')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* --- Panneau de gestion ------------------------------------------- */}
        <div className="space-y-4">
          {selected ? (
            <>
              <Card title={selected.productName}>
                <p className="font-mono text-xs text-slate-500">{selected.sku}</p>

                <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <Metric label={t('columns.physical')} value={selected.onHand} />
                  <Metric label={t('columns.reserved')} value={selected.reserved} tone="muted" />
                  <Metric
                    label={t('columns.available')}
                    value={selected.available}
                    tone={selected.available <= 0 ? 'danger' : 'warning'}
                  />
                </dl>

                {canManage ? (
                  <form onSubmit={submit} className="mt-3 space-y-3 border-t border-slate-200 pt-3">
                    {formError ? <Alert tone="danger">{formError}</Alert> : null}

                    <div className="flex rounded-md border border-slate-300 p-0.5">
                      {(['inbound', 'adjust'] as const).map((entry) => (
                        <button
                          key={entry}
                          type="button"
                          onClick={() => {
                            setMode(entry);
                            setFormError(null);
                          }}
                          className={
                            mode === entry
                              ? 'flex-1 rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white'
                              : 'flex-1 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100'
                          }
                        >
                          {entry === 'inbound' ? t('modeInbound') : t('modeAdjust')}
                        </button>
                      ))}
                    </div>

                    <Input
                      label={mode === 'inbound' ? t('quantityReceived') : t('variation')}
                      type="number"
                      required
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                      placeholder={mode === 'inbound' ? '20' : '-2'}
                      hint={mode === 'inbound' ? t('inboundHint') : t('adjustHint')}
                    />

                    <Textarea
                      label={mode === 'inbound' ? t('receiptReference') : tCommon('reason')}
                      required={mode === 'adjust'}
                      rows={2}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={
                        mode === 'inbound' ? t('receiptPlaceholder') : t('adjustReasonPlaceholder')
                      }
                    />

                    {/* --- Suivi par lot, replie par defaut ---------------
                        Une reception ordinaire n'a aucune raison de payer le
                        cout de trois champs supplementaires. Ceux qui suivent
                        leurs couts d'achat reels, ou vendent du perissable,
                        ouvrent la section une fois et la retrouvent ouverte
                        pour les receptions suivantes. */}
                    {mode === 'inbound' ? (
                      <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between text-xs font-medium text-slate-600 hover:text-slate-900"
                          onClick={() => setBatchOpen((value) => !value)}
                        >
                          <span>{t('batchSection')}</span>
                          <span className="text-slate-400">{batchOpen ? '−' : '+'}</span>
                        </button>

                        {batchOpen ? (
                          <div className="mt-2 space-y-2">
                            <p className="text-xs text-slate-500">{t('batchSectionHint')}</p>
                            <Input
                              label={t('batchCost')}
                              inputMode="decimal"
                              value={batchCost}
                              onChange={(event) => setBatchCost(event.target.value)}
                              placeholder="2500"
                              hint={t('batchCostHint')}
                            />
                            <Input
                              label={t('batchExpiry')}
                              type="date"
                              value={batchExpiry}
                              onChange={(event) => setBatchExpiry(event.target.value)}
                              hint={t('batchExpiryHint')}
                            />
                            <Input
                              label={t('batchReference')}
                              value={batchReference}
                              onChange={(event) => setBatchReference(event.target.value)}
                              placeholder="BL-2026-0142"
                            />
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <Button type="submit" className="w-full" loading={stockMutation.isPending}>
                      {mode === 'inbound' ? t('submitInbound') : t('submitAdjust')}
                    </Button>
                  </form>
                ) : (
                  <p className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-500">
                    {t('noPermission')}
                  </p>
                )}
              </Card>

              {/* --- Lots -------------------------------------------------
                  Affiche seulement s'il y en a : une boutique qui ne suit pas
                  ses lots ne doit pas voir une carte vide lui reprocher un
                  usage qu'elle n'a pas choisi. */}
              {(batchesQuery.data?.length ?? 0) > 0 ? (
                <Card title={t('batchesTitle')} padded={false}>
                  <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
                    {batchesQuery.data?.map((batch) => {
                      const exhausted = batch.remainingQuantity === 0;
                      const expiring =
                        batch.expiresAt !== null && new Date(batch.expiresAt) <= soon;

                      return (
                        <li key={batch.id} className="px-3 py-2 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={
                                exhausted ? 'text-slate-400' : 'font-medium text-slate-800'
                              }
                            >
                              {t('batchRemaining', {
                                remaining: batch.remainingQuantity,
                                quantity: batch.quantity,
                              })}
                            </span>
                            <Money centimes={batch.costCentimes} />
                          </div>

                          <p className="text-xs text-slate-500">
                            {t('batchReceived', { date: formatDate(batch.receivedAt) })}
                            {batch.reference ? ` · ${batch.reference}` : ''}
                          </p>

                          {batch.expiresAt ? (
                            <p
                              className={
                                expiring ? 'text-xs font-medium text-warning' : 'text-xs text-slate-500'
                              }
                            >
                              {t('batchExpires', { date: formatDate(batch.expiresAt) })}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>

                  <div className="border-t border-slate-100 px-3 py-2">
                    <label className="flex items-center gap-1.5 text-xs text-slate-500">
                      <input
                        type="checkbox"
                        checked={showExhausted}
                        onChange={(event) => setShowExhausted(event.target.checked)}
                      />
                      {t('batchShowExhausted')}
                    </label>
                  </div>
                </Card>
              ) : null}

              <Card title={t('movementsTitle')} padded={false}>
                {movementsQuery.isLoading ? (
                  <LoadingState />
                ) : (movementsQuery.data?.length ?? 0) === 0 ? (
                  <p className="px-3 py-4 text-sm text-slate-500">{t('noMovements')}</p>
                ) : (
                  <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
                    {movementsQuery.data?.map((movement) => (
                      <li key={movement.id} className="px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-slate-800">
                            {t(`movements.${movement.type}`)}
                          </span>
                          <span
                            className={
                              movement.quantity >= 0
                                ? 'tabular font-medium text-success'
                                : 'tabular font-medium text-danger'
                            }
                          >
                            {movement.quantity > 0 ? '+' : ''}
                            {movement.quantity}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {t('movementRemaining', {
                            onHand: movement.onHandAfter,
                            reserved: movement.reservedAfter,
                          })}
                        </p>
                        {movement.note ? (
                          <p className="text-xs text-slate-500">{movement.note}</p>
                        ) : null}
                        <p className="text-xs text-slate-400">
                          {formatDateTime(movement.createdAt)} · {movement.referenceType}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          ) : (
            <Card title={t('panelTitle')}>
              <p className="text-sm text-slate-600">{t('panelHint')}</p>
              <p className="mt-2 text-xs text-slate-500">{t('reservedExplain')}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'muted' | 'warning' | 'danger';
}) {
  const tones = {
    default: 'text-slate-900',
    muted: 'text-slate-500',
    warning: 'text-warning',
    danger: 'text-danger',
  } as const;

  return (
    <div className="rounded-md bg-slate-50 p-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`tabular text-lg font-semibold ${tones[tone]}`}>{value}</dd>
    </div>
  );
}
