'use client';

/**
 * Retours — V1 §14, V2 §18.
 *
 * LE STOCK NE BOUGE QU'A L'INSPECTION.
 *   Un retour annonce n'est pas un retour recu, et un retour recu n'est pas un
 *   produit revendable. Le cycle est donc explicite : annonce → en transit →
 *   recu → inspecte → cloture. C'est uniquement a l'inspection, ligne par
 *   ligne, que le magasinier tranche : remise en vente, quarantaine, ou perte.
 *
 * LA PERTE EST NOMMEE.
 *   Un produit mis au rebut est une perte reelle, comptee comme telle dans la
 *   rentabilite. L'ecran le dit franchement plutot que de faire disparaitre la
 *   marchandise sans trace.
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PERMISSIONS,
  PRODUCT_CONDITIONS,
  RETURN_STATUSES,
  type ProductCondition,
  type ReturnReason,
  type ReturnStatus,
} from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/app-shell';
import { GroupTabs } from '@/components/group-tabs';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  Input,
  Select,
  Textarea,
  formatDate,
} from '@/components/ui';

type StockDecision = 'RESTOCK' | 'QUARANTINE' | 'WRITE_OFF';

interface ReturnItem {
  readonly id: string;
  readonly quantity: number;
  readonly condition: ProductCondition;
  readonly stockDecision: string;
  readonly stockApplied: boolean;
  readonly variant: { sku: string; label: string | null };
  readonly orderItem: { productNameSnapshot: string; skuSnapshot: string };
}

interface ReturnRow {
  readonly id: string;
  readonly reference: string;
  readonly reason: ReturnReason;
  readonly reasonDetail: string | null;
  readonly status: ReturnStatus;
  readonly stockDecision: string;
  readonly returnCostCentimes: number;
  readonly notes: string | null;
  readonly receivedAt: string | null;
  readonly inspectedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly order: {
    id: string;
    reference: string;
    customerNameSnapshot: string;
    totalCentimes: number;
  };
  readonly items: readonly { id: string; quantity: number; condition: string }[];
}

interface ReturnDetail extends Omit<ReturnRow, 'items' | 'order'> {
  readonly order: { id: string; reference: string; customerNameSnapshot: string };
  readonly shipment: { trackingNumber: string | null; carrier: { name: string } } | null;
  readonly items: readonly ReturnItem[];
}

const STATUS_TONES: Record<ReturnStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  PENDING: 'warning',
  IN_TRANSIT: 'info',
  RECEIVED: 'info',
  INSPECTED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'neutral',
};

/** Les trois decisions possibles, dans l'ordre ou elles sont proposees. */
const DECISIONS: readonly StockDecision[] = ['RESTOCK', 'QUARANTINE', 'WRITE_OFF'];

export default function ReturnsPage() {
  const t = useTranslations('returns');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('returnStatus');
  const tReason = useTranslations('returnReason');
  const { can } = useSession();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState('');
  /**
   * Recherche LOCALE de cet ecran, distincte de celle de l'en-tete.
   *
   * `/returns` renvoie la liste complete pour le statut demande, sans
   * pagination : le filtrage se fait ici, sur ce qui est deja charge.
   */
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );

  const canManage = can(PERMISSIONS.RETURNS_MANAGE);

  const listQuery = useQuery({
    queryKey: ['returns', status],
    queryFn: () => api.get<ReturnRow[]>('/returns', { query: { status: status || undefined } }),
  });

  // Reference du retour, reference de la commande ou nom du client : les trois
  // facons dont un retour est designe au telephone ou au depot.
  const returnsSearch = search.trim().toLowerCase();
  const visibleReturns = (listQuery.data ?? []).filter((entry) => {
    if (!returnsSearch) return true;
    return [entry.reference, entry.order.reference, entry.order.customerNameSnapshot]
      .join(' ')
      .toLowerCase()
      .includes(returnsSearch);
  });

  const detailQuery = useQuery({
    queryKey: ['return', selectedId],
    queryFn: () => api.get<ReturnDetail>(`/returns/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['returns'] });
    void queryClient.invalidateQueries({ queryKey: ['return'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }

  const stepMutation = useMutation({
    mutationFn: (payload: { id: string; step: 'in-transit' | 'received' | 'close' }) =>
      api.post(`/returns/${payload.id}/${payload.step}`, {}),
    onSuccess: () => {
      setFeedback(null);
      refresh();
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed'),
      });
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
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.text}</Alert>
        </div>
      ) : null}

      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-2 sm:max-w-2xl">
          <Input
            label={tCommon('search')}
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label={tCommon('status')}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setSelectedId(null);
            }}
          >
            <option value="">{t('allReturns')}</option>
            {RETURN_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {tStatus(entry)}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('listTitle')} className="lg:col-span-2" padded={false}>
          {listQuery.isLoading ? (
            <LoadingState />
          ) : listQuery.error ? (
            <ErrorState
              message={
                listQuery.error instanceof ApiError
                  ? listQuery.error.userMessage
                  : tCommon('loadFailed')
              }
              onRetry={() => void listQuery.refetch()}
            />
          ) : visibleReturns.length === 0 ? (
            <EmptyState
              title={t('emptyTitle')}
              description={status || search ? t('emptyFiltered') : t('emptyFirst')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('columns.reference')}</th>
                    <th>{t('columns.order')}</th>
                    <th>{t('columns.reason')}</th>
                    <th>{t('columns.status')}</th>
                    <th className="text-end">{t('columns.cost')}</th>
                    <th>{tCommon('createdAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleReturns.map((entry) => (
                    <tr
                      key={entry.id}
                      className={selectedId === entry.id ? 'bg-brand-50/60' : undefined}
                    >
                      <td>
                        <button
                          className="font-mono text-xs font-medium text-brand-700 hover:underline"
                          onClick={() => setSelectedId(entry.id)}
                        >
                          {entry.reference}
                        </button>
                      </td>
                      <td>
                        <Link
                          href={`/commandes/${entry.order.id}`}
                          className="font-mono text-xs text-slate-700 hover:underline"
                        >
                          {entry.order.reference}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {entry.order.customerNameSnapshot}
                        </p>
                      </td>
                      <td className="text-xs text-slate-600">
                        {tReason(entry.reason)}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONES[entry.status] ?? 'neutral'}>
                          {tStatus(entry.status)}
                        </Badge>
                      </td>
                      <td className="text-end">
                        <Money centimes={entry.returnCostCentimes} />
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatDate(entry.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div>
          {selectedId && detailQuery.data ? (
            <ReturnDetailPanel
              detail={detailQuery.data}
              canManage={canManage}
              stepPending={stepMutation.isPending}
              onStep={(step) => stepMutation.mutate({ id: selectedId, step })}
              onInspected={() => {
                setFeedback({
                  tone: 'success',
                  text: t('inspected'),
                });
                refresh();
              }}
              onError={(text) => setFeedback({ tone: 'danger', text })}
            />
          ) : (
            <Card title={t('panelTitle')}>
              <p className="text-sm text-slate-600">{t('panelHint')}</p>
              <ol className="mt-3 space-y-1 text-xs text-slate-500">
                {(['1', '2', '3', '4', '5'] as const).map((step) => (
                  <li key={step}>{t(`cycle.${step}`)}</li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function ReturnDetailPanel({
  detail,
  canManage,
  stepPending,
  onStep,
  onInspected,
  onError,
}: {
  detail: ReturnDetail;
  canManage: boolean;
  stepPending: boolean;
  onStep: (step: 'in-transit' | 'received' | 'close') => void;
  onInspected: () => void;
  onError: (text: string) => void;
}) {
  const [lines, setLines] = useState<
    Record<string, { condition: ProductCondition; stockDecision: StockDecision }>
  >(() =>
    Object.fromEntries(
      detail.items.map((item) => [
        item.id,
        {
          condition: (item.condition === 'UNKNOWN' ? 'SELLABLE' : item.condition),
          stockDecision: (item.condition === 'DAMAGED'
            ? 'WRITE_OFF'
            : 'RESTOCK'),
        },
      ]),
    ),
  );
  const t = useTranslations('returns');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('returnStatus');
  const tReason = useTranslations('returnReason');
  const [notes, setNotes] = useState('');

  const inspectMutation = useMutation({
    mutationFn: () =>
      api.post(`/returns/${detail.id}/inspect`, {
        lines: detail.items.map((item) => ({
          returnItemId: item.id,
          condition: lines[item.id]?.condition ?? 'UNKNOWN',
          stockDecision: lines[item.id]?.stockDecision ?? 'QUARANTINE',
        })),
        notes: notes.trim() || undefined,
      }),
    onSuccess: onInspected,
    onError: (caught) => {
      onError(caught instanceof ApiError ? caught.userMessage : t('inspectionFailed'));
    },
  });

  const writeOffCount = detail.items.filter(
    (item) => lines[item.id]?.stockDecision === 'WRITE_OFF',
  ).length;

  return (
    <Card
      title={detail.reference}
      action={
        <Badge tone={STATUS_TONES[detail.status] ?? 'neutral'}>{tStatus(detail.status)}</Badge>
      }
    >
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">{t('columns.order')}</dt>
          <dd>
            <Link
              href={`/commandes/${detail.order.id}`}
              className="font-mono text-xs text-brand-700 hover:underline"
            >
              {detail.order.reference}
            </Link>
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">{tCommon('customer')}</dt>
          <dd className="text-slate-800">{detail.order.customerNameSnapshot}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">{tCommon('reason')}</dt>
          <dd className="text-end text-slate-800">
            {tReason(detail.reason)}
          </dd>
        </div>
        {detail.shipment ? (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">{t('parcel')}</dt>
            <dd className="font-mono text-xs text-slate-700">
              {detail.shipment.trackingNumber ?? '—'}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">{t('cost')}</dt>
          <dd>
            <Money centimes={detail.returnCostCentimes} />
          </dd>
        </div>
      </dl>

      {detail.reasonDetail ? (
        <p className="mt-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
          {detail.reasonDetail}
        </p>
      ) : null}

      {/* --- Avancement du cycle ------------------------------------------- */}
      {canManage ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
          {detail.status === 'PENDING' ? (
            <Button size="sm" variant="secondary" disabled={stepPending} onClick={() => onStep('in-transit')}>
              {t('stepInTransit')}
            </Button>
          ) : null}
          {detail.status === 'PENDING' || detail.status === 'IN_TRANSIT' ? (
            <Button size="sm" variant="secondary" disabled={stepPending} onClick={() => onStep('received')}>
              {t('stepReceived')}
            </Button>
          ) : null}
          {detail.status === 'INSPECTED' ? (
            <Button size="sm" disabled={stepPending} onClick={() => onStep('close')}>
              {t('stepClose')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* --- Inspection ligne par ligne ------------------------------------ */}
      <div className="mt-3 border-t border-slate-200 pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {t('goods', { count: detail.items.length })}
        </p>

        {detail.items.length === 0 ? (
          <p className="mt-1.5 text-sm text-slate-500">
            {t('noItems')}
          </p>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {detail.items.map((item) => (
              <li key={item.id} className="rounded-md border border-slate-200 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {item.orderItem.productNameSnapshot}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {item.variant.sku}
                      {item.variant.label ? ` · ${item.variant.label}` : ''}
                    </p>
                  </div>
                  <span className="tabular shrink-0 text-sm font-semibold text-slate-900">
                    ×{item.quantity}
                  </span>
                </div>

                {item.stockApplied ? (
                  <p className="mt-1.5 text-xs text-slate-500">
                    {t('applied', {
                      decision: t(`decisions.${item.stockDecision}`),
                      condition: t(`conditions.${item.condition}`),
                    })}
                  </p>
                ) : canManage && detail.status === 'RECEIVED' ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Select
                      label={t('condition')}
                      value={lines[item.id]?.condition ?? 'UNKNOWN'}
                      onChange={(event) =>
                        setLines({
                          ...lines,
                          [item.id]: {
                            condition: event.target.value as ProductCondition,
                            stockDecision: lines[item.id]?.stockDecision ?? 'QUARANTINE',
                          },
                        })
                      }
                    >
                      {PRODUCT_CONDITIONS.map((entry) => (
                        <option key={entry} value={entry}>
                          {t(`conditions.${entry}`)}
                        </option>
                      ))}
                    </Select>

                    <Select
                      label={t('decision')}
                      value={lines[item.id]?.stockDecision ?? 'QUARANTINE'}
                      onChange={(event) =>
                        setLines({
                          ...lines,
                          [item.id]: {
                            condition: lines[item.id]?.condition ?? 'UNKNOWN',
                            stockDecision: event.target.value as StockDecision,
                          },
                        })
                      }
                    >
                      {DECISIONS.map((entry) => (
                        <option key={entry} value={entry}>
                          {t(`decisions.${entry}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-slate-500">
                    {t('notReceivedYet')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && detail.status === 'RECEIVED' && detail.items.length > 0 ? (
          <div className="mt-3 space-y-2">
            {writeOffCount > 0 ? (
              <Alert tone="warning">
                {t('writeOffWarning', { count: writeOffCount })}
              </Alert>
            ) : null}

            <Textarea
              label={t('observations')}
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={t('observationsPlaceholder')}
            />

            <Button
              className="w-full"
              loading={inspectMutation.isPending}
              onClick={() => inspectMutation.mutate()}
            >
              {t('submitInspection')}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
