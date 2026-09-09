'use client';

/**
 * Expeditions — V1 §12/§13, V2 §16/§17.
 *
 * DEUX STATUTS, PAS UN.
 *   Chaque colis porte le statut BRUT du transporteur et le statut normalise
 *   EcomFlow. Les afficher tous les deux n'est pas de la redondance : quand un
 *   transporteur invente un libelle, l'exploitant doit pouvoir le lire tel quel
 *   pour appeler l'agence, tout en gardant un statut comparable entre
 *   transporteurs.
 *
 * LES COLIS SILENCIEUX SONT MIS EN AVANT.
 *   Un colis dont le transporteur n'a rien dit depuis plusieurs jours est le
 *   vrai probleme d'exploitation. Il est signale ici, avec la date de derniere
 *   synchronisation reelle — pas une estimation.
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SHIPMENT_STATUSES, getWilayaByCode, type ShipmentStatus } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
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
  Pagination,
  Select,
  formatDateTime,
  useRelativeTime,
} from '@/components/ui';

interface ShipmentRow {
  readonly id: string;
  readonly trackingNumber: string | null;
  readonly status: ShipmentStatus;
  readonly providerStatus: string | null;
  readonly labelUrl: string | null;
  readonly costCentimes: number | null;
  readonly errorMessage: string | null;
  readonly lastSyncedAt: string | null;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
  readonly carrier: { id: string; code: string; name: string };
  readonly order: {
    id: string;
    reference: string;
    status: string;
    customerNameSnapshot: string;
    phoneSnapshot: string;
    wilayaCodeSnapshot: number | null;
    communeSnapshot: string | null;
    totalCentimes: number;
  };
  readonly events: readonly {
    providerStatus: string;
    occurredAt: string;
    location: string | null;
  }[];
}

interface Paginated {
  readonly data: ShipmentRow[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

const STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  DRAFT: 'neutral',
  CREATION_PENDING: 'warning',
  CREATED: 'info',
  PICKED_UP: 'info',
  IN_TRANSIT: 'info',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  FAILED_ATTEMPT: 'warning',
  RETURNING: 'warning',
  RETURNED: 'danger',
  CANCELLED: 'neutral',
  ERROR: 'danger',
};

/** Au-dela de ce delai sans nouvelle du transporteur, le colis est signale. */
const STALE_AFTER_HOURS = 48;

export default function ShipmentsPage() {
  const t = useTranslations('shipments');
  const tStatus = useTranslations('shipmentStatus');
  const tCommon = useTranslations('common');
  const relativeTime = useRelativeTime();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['shipments', { page, status, debounced }],
    queryFn: () =>
      api.get<Paginated>('/shipments', {
        query: {
          page,
          pageSize: 25,
          status: status || undefined,
          search: debounced || undefined,
        },
      }),
    placeholderData: (previous) => previous,
  });

  const syncMutation = useMutation({
    mutationFn: (shipmentId: string) => api.post(`/shipments/${shipmentId}/sync-tracking`, {}),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: t('synced') });
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('syncFailed'),
      });
    },
  });

  const now = Date.now();

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
      />

      {feedback ? (
        <div className="mb-3">
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.text}</Alert>
        </div>
      ) : null}

      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label={tCommon('search')}
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label={t('statusLabel')}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('allStatuses')}</option>
            {SHIPMENT_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {tStatus(entry)}
              </option>
            ))}
          </Select>
          <div className="flex items-end">
            <button
              className="h-9 text-sm text-brand-700 hover:underline"
              onClick={() => {
                setStatus('IN_TRANSIT,OUT_FOR_DELIVERY,PICKED_UP,CREATED,FAILED_ATTEMPT');
                setPage(1);
              }}
            >
              {t('onlyActive')}
            </button>
          </div>
        </div>
      </Card>

      <Card padded={false}>
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState
            message={error instanceof ApiError ? error.userMessage : tCommon('loadFailed')}
            onRetry={() => void refetch()}
          />
        ) : !data || data.data.length === 0 ? (
          <EmptyState
            title={t('emptyTitle')}
            description={status || debounced ? t('emptyFiltered') : t('emptyFirst')}
            action={
              !status && !debounced ? (
                <Link href="/preparation">
                  <span className="text-sm text-brand-700 underline">
                    {t('seePreparation')}
                  </span>
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('columns.tracking')}</th>
                    <th>{t('columns.order')}</th>
                    <th>{t('columns.destination')}</th>
                    <th>{t('columns.internalStatus')}</th>
                    <th>{t('columns.carrierStatus')}</th>
                    <th>{t('columns.lastNews')}</th>
                    <th className="text-end">{t('columns.cost')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((shipment) => {
                    const lastEvent = shipment.events[0] ?? null;
                    const lastSignal = shipment.lastSyncedAt ?? shipment.createdAt;
                    const isActive = ![
                      'DELIVERED',
                      'RETURNED',
                      'CANCELLED',
                    ].includes(shipment.status);
                    const isStale =
                      isActive && now - new Date(lastSignal).getTime() > STALE_AFTER_HOURS * 3_600_000;
                    const wilaya = shipment.order.wilayaCodeSnapshot
                      ? getWilayaByCode(shipment.order.wilayaCodeSnapshot)
                      : null;

                    return (
                      <tr key={shipment.id} className={isStale ? 'bg-warning/50' : undefined}>
                        <td>
                          <p className="font-mono text-xs font-medium text-slate-800">
                            {shipment.trackingNumber ?? '—'}
                          </p>
                          <p className="text-xs text-slate-500">{shipment.carrier.name}</p>
                        </td>
                        <td>
                          <Link
                            href={`/commandes/${shipment.order.id}`}
                            className="font-mono text-xs font-medium text-brand-700 hover:underline"
                          >
                            {shipment.order.reference}
                          </Link>
                          <p className="text-xs text-slate-600">
                            {shipment.order.customerNameSnapshot}
                          </p>
                        </td>
                        <td className="text-xs text-slate-600">
                          {wilaya ? `${wilaya.code2} ${wilaya.name}` : '—'}
                          {shipment.order.communeSnapshot ? (
                            <p className="text-slate-500">{shipment.order.communeSnapshot}</p>
                          ) : null}
                        </td>
                        <td>
                          <Badge tone={STATUS_TONES[shipment.status] ?? 'neutral'}>
                            {tStatus(shipment.status)}
                          </Badge>
                          {shipment.errorMessage ? (
                            <p
                              className="mt-0.5 max-w-[180px] truncate text-xs text-danger"
                              title={shipment.errorMessage}
                            >
                              {shipment.errorMessage}
                            </p>
                          ) : null}
                        </td>
                        <td className="text-xs text-slate-600">
                          {shipment.providerStatus ?? '—'}
                          {lastEvent?.location ? (
                            <p className="text-slate-400">{lastEvent.location}</p>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          <span className={isStale ? 'font-medium text-warning' : 'text-slate-500'}>
                            {relativeTime(lastSignal)}
                          </span>
                          {isStale ? (
                            <p
                              className="text-warning"
                              title={t('staleTooltip', { hours: STALE_AFTER_HOURS })}
                            >
                              {t('stale')}
                            </p>
                          ) : null}
                          <p className="text-slate-400">{formatDateTime(lastSignal)}</p>
                        </td>
                        <td className="text-end">
                          {shipment.costCentimes === null ? (
                            <span className="text-xs text-slate-400">—</span>
                          ) : (
                            <Money centimes={shipment.costCentimes} />
                          )}
                        </td>
                        <td className="whitespace-nowrap text-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={syncMutation.isPending || !shipment.trackingNumber}
                            onClick={() => syncMutation.mutate(shipment.id)}
                          >
                            {t('refresh')}
                          </Button>
                          {shipment.labelUrl ? (
                            <a
                              href={shipment.labelUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="ms-2 text-xs text-brand-700 underline"
                            >
                              {t('label')}
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              total={data.meta.total}
              onChange={setPage}
            />
          </>
        )}
      </Card>
    </>
  );
}
