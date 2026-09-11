'use client';

/**
 * Preparation des colis — V1 §10, V2 §13.
 *
 * L'ecran est concu pour le depot, pas pour le bureau : la liste est une liste
 * de picking. On y voit les SKU et les quantites, pas les montants — le
 * preparateur n'a aucun besoin de connaitre les prix, et les afficher
 * ralentirait la lecture.
 *
 * Deux etapes explicites, car ce sont deux gestes distincts :
 *   « Prendre en preparation » (le colis est en cours de montage)
 *   « Prete a expedier » (le colis est ferme, il attend le transporteur)
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getWilayaByCode, type PreparationBulkAction } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import {
  RowCheckbox,
  SelectAllCheckbox,
  useRowSelection,
  type BulkArchiveResult,
  type RowSelection,
} from '@/components/bulk-selection';
import { PageHeader } from '@/components/app-shell';
import { GroupTabs } from '@/components/group-tabs';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  StatusBadge,
  Textarea,
  useRelativeTime,
} from '@/components/ui';

interface OrderRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly orderedAt: string;
  readonly items: readonly { sku: string; productName: string; quantity: number }[];
}

interface Paginated {
  readonly data: OrderRow[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/** Les trois colonnes du flux logistique, dans l'ordre de progression. */
const COLUMNS = [
  {
    status: 'CONFIRMED',
    key: 'toPrepare',
    next: 'IN_PREPARATION',
    nextKey: 'takeInPreparation',
  },
  {
    status: 'IN_PREPARATION',
    key: 'inProgress',
    next: 'READY_TO_SHIP',
    nextKey: 'packReady',
  },
  {
    status: 'READY_TO_SHIP',
    key: 'readyToShip',
    next: null,
    nextKey: 'ship',
  },
] as const;

export default function PreparationPage() {
  const t = useTranslations('preparation');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const transitionMutation = useMutation({
    mutationFn: (payload: { orderId: string; status: string }) =>
      // « Colis pret » ne peut pas passer par la route generique de statut : la
      // transition exige que les lignes soient enregistrees comme preparees,
      // ce que seule cette route fait. Y aller directement produisait un refus
      // systematique, avec un message decrivant une action que l'interface
      // n'offrait pas.
      payload.status === 'READY_TO_SHIP'
        ? api.post(`/orders/${payload.orderId}/mark-ready`, {})
        : api.post(`/orders/${payload.orderId}/status`, { status: payload.status }),
    onSuccess: () => {
      setFeedback(null);
      void queryClient.invalidateQueries({ queryKey: ['preparation'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (caught) => {
      setFeedback(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed'));
    },
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
      />

      <GroupTabs />

      {feedback ? (
        <div className="mb-3">
          <Alert tone="danger">{feedback}</Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((column) => (
          <PreparationColumn
            key={column.status}
            column={column}
            pending={transitionMutation.isPending}
            onAdvance={(orderId, status) => transitionMutation.mutate({ orderId, status })}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Actions groupees d'une colonne de preparation.
 *
 * CHAQUE COLONNE N'OFFRE QUE CE QUE SON STATUT PERMET
 *   « A preparer » peut renvoyer en confirmation, annuler-et-archiver, ou
 *   declarer le colis pret. « Pretes a expedier » ne peut qu'expedier. La
 *   colonne du milieu n'a pas d'action groupee propre : le geste qui s'y trouve
 *   — declarer le colis pret — est deja couvert par « Colis pret » de la
 *   premiere colonne, qui enchaine les deux transitions.
 *
 * LE MOTIF EST DEMANDE AVANT, PAS APRES
 *   Deux des trois actions exigent un motif cote serveur. Le reclamer dans la
 *   boite de confirmation evite que l'agent decouvre le refus apres avoir coche
 *   quinze lignes.
 */
function ColumnBulkBar({
  columnKey,
  selection,
  onDone,
}: {
  columnKey: 'toPrepare' | 'inProgress' | 'readyToShip';
  selection: RowSelection;
  onDone: () => void;
}) {
  const t = useTranslations('preparation.bulk');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();

  const [pendingAction, setPendingAction] = useState<PreparationBulkAction | 'SHIP' | null>(null);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<BulkArchiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (action: PreparationBulkAction | 'SHIP') => {
      const ids = [...selection.selected];
      if (action === 'SHIP') {
        return api.post<BulkArchiveResult>('/orders/bulk-ship', { ids });
      }
      return api.post<BulkArchiveResult>('/orders/bulk-preparation', {
        ids,
        action,
        reason: reason.trim(),
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      setReason('');
      selection.clear();
      onDone();
      void queryClient.invalidateQueries({ queryKey: ['preparation'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed'));
    },
  });

  const actions: readonly (PreparationBulkAction | 'SHIP')[] =
    columnKey === 'toPrepare'
      ? ['RETURN_TO_CONFIRMATION', 'CANCEL_AND_ARCHIVE', 'MARK_READY']
      : columnKey === 'readyToShip'
        ? ['SHIP']
        : [];

  if (actions.length === 0) return null;

  const needsReason = pendingAction !== null && pendingAction !== 'SHIP';

  return (
    <>
      {result ? (
        <div className="border-b border-slate-100 p-2">
          <Alert
            tone={result.skipped.length > 0 ? 'warning' : 'success'}
            title={t('doneTitle', { count: result.archived })}
            action={
              <button
                className="text-xs font-semibold underline underline-offset-2"
                onClick={() => setResult(null)}
              >
                {tCommon('close')}
              </button>
            }
          >
            {result.skipped.length === 0 ? (
              t('doneAll')
            ) : (
              <ul className="space-y-0.5 text-xs">
                {result.skipped.map((skip) => (
                  <li key={skip.id}>{skip.message}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      {error ? (
        <div className="border-b border-slate-100 p-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      {selection.count > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/60 px-2 py-2">
          <span className="text-xs font-semibold text-slate-700">
            {t('selected', { count: selection.count })}
          </span>
          <div className="flex-1" />
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === 'CANCEL_AND_ARCHIVE' ? 'danger' : 'secondary'}
              disabled={mutation.isPending}
              onClick={() => setPendingAction(action)}
            >
              {t(`actions.${action}`)}
            </Button>
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingAction !== null}
        danger={pendingAction === 'CANCEL_AND_ARCHIVE'}
        loading={mutation.isPending}
        title={
          pendingAction
            ? t(`confirm.${pendingAction}`, { count: selection.count })
            : ''
        }
        message={pendingAction ? t(`confirmBody.${pendingAction}`) : undefined}
        confirmLabel={pendingAction ? t(`actions.${pendingAction}`) : undefined}
        onCancel={() => {
          setPendingAction(null);
          setReason('');
        }}
        onConfirm={() => {
          if (!pendingAction) return;
          if (needsReason && !reason.trim()) return;
          const action = pendingAction;
          setPendingAction(null);
          mutation.mutate(action);
        }}
      >
        {needsReason ? (
          <Textarea
            label={tCommon('reason')}
            required
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('reasonPlaceholder')}
          />
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function PreparationColumn({
  column,
  pending,
  onAdvance,
}: {
  column: (typeof COLUMNS)[number];
  pending: boolean;
  onAdvance: (orderId: string, status: string) => void;
}) {
  const t = useTranslations('preparation');
  const tCommon = useTranslations('common');
  const relativeTime = useRelativeTime();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['preparation', column.status],
    queryFn: () =>
      api.get<Paginated>('/orders', {
        query: { status: column.status, pageSize: 50, sortBy: 'orderedAt', sortDir: 'asc' },
      }),
    // Plusieurs preparateurs travaillent sur la meme file : sans
    // rafraichissement, deux personnes monteraient le meme colis.
    refetchInterval: 45_000,
  });

  const visibleIds = (data?.data ?? []).map((order) => order.id);
  const selection = useRowSelection(visibleIds);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {t(`columns.${column.key}`)}
          {data ? <Badge tone="neutral">{data.meta.total}</Badge> : null}
          {visibleIds.length > 0 ? (
            <span className="ms-auto">
              <SelectAllCheckbox selection={selection} />
            </span>
          ) : null}
        </span>
      }
      padded={false}
      footer={<p className="text-xs text-slate-500">{t(`hints.${column.key}`)}</p>}
    >
      <ColumnBulkBar
        columnKey={column.key}
        selection={selection}
        onDone={() => void refetch()}
      />

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState
          message={error instanceof ApiError ? error.userMessage : tCommon('loadFailed')}
          onRetry={() => void refetch()}
        />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('empty')} />
      ) : (
        <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
          {data?.data.map((order) => {
            const wilaya = order.wilayaCode ? getWilayaByCode(order.wilayaCode) : null;

            return (
              <li key={order.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 gap-2">
                    <span className="pt-0.5">
                      <RowCheckbox
                        id={order.id}
                        selection={selection}
                        label={order.reference}
                      />
                    </span>
                    <div className="min-w-0">
                    <Link
                      href={`/commandes/${order.id}`}
                      className="font-mono text-xs font-medium text-brand-700 hover:underline"
                    >
                      {order.reference}
                    </Link>
                    <p className="truncate text-sm text-slate-800">{order.customerName}</p>
                    <p className="text-xs text-slate-500">
                      {wilaya ? `${wilaya.code2} ${wilaya.name}` : '—'}
                      {order.commune ? ` · ${order.commune}` : ''}
                    </p>
                    </div>
                  </div>
                  <div className="text-end">
                    <StatusBadge status={order.status} />
                    <p className="mt-0.5 text-xs text-slate-400">
                      {relativeTime(order.orderedAt)}
                    </p>
                  </div>
                </div>

                {/* Liste de picking : SKU + quantite, rien d'autre. */}
                <ul className="mt-1.5 space-y-0.5">
                  {order.items.map((item) => (
                    <li key={item.sku} className="flex items-baseline gap-2 text-xs">
                      <span className="tabular w-6 shrink-0 font-semibold text-slate-900">
                        {item.quantity}×
                      </span>
                      <span className="font-mono text-slate-600">{item.sku}</span>
                      <span className="truncate text-slate-500">{item.productName}</span>
                    </li>
                  ))}
                </ul>

                {column.next ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2 w-full"
                    disabled={pending}
                    onClick={() => onAdvance(order.id, column.next)}
                  >
                    {t(`next.${column.nextKey}`)}
                  </Button>
                ) : (
                  <Link href={`/commandes/${order.id}`}>
                    <span className="mt-2 flex h-8 w-full items-center justify-center rounded-md bg-brand-600 text-sm font-medium text-white hover:bg-brand-700">
                      {t('next.ship')}
                    </span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
