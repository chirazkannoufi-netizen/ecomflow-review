'use client';

/**
 * Fiche commande : timeline complete (V1 §20).
 *
 * Reunit tout ce qu'un operateur doit savoir sans changer d'ecran : l'etat, le
 * client et sa fiabilite, les articles, l'historique de statut, les tentatives
 * d'appel, les colis et leurs evenements transporteur, les retours et les
 * doublons signales.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getWilayaByCode, type OrderStatus } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Input,
  LoadingState,
  Money,
  ReliabilityBadge,
  StatusBadge,
  formatDateTime,
} from '@/components/ui';

interface Transition {
  readonly to: OrderStatus;
  readonly requiresReason: boolean;
  readonly permission: string;
}

interface OrderDetail {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly source: string;
  readonly customerNameSnapshot: string;
  readonly phoneSnapshot: string;
  readonly wilayaCodeSnapshot: number | null;
  readonly communeSnapshot: string | null;
  readonly addressSnapshot: string | null;
  readonly itemsTotalCentimes: number;
  readonly deliveryFeeCentimes: number;
  readonly totalCentimes: number;
  readonly carrierCostCentimes: number;
  readonly returnCostCentimes: number;
  readonly notes: string | null;
  readonly callAttemptsCount: number;
  readonly orderedAt: string;
  readonly confirmedAt: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly items: readonly {
    id: string;
    productNameSnapshot: string;
    skuSnapshot: string;
    variantLabelSnapshot: string | null;
    quantity: number;
    unitPriceCentimes: number;
    preparedQuantity: number | null;
    lineTotalCentimes: number;
  }[];
  readonly customer: {
    id: string;
    fullName: string;
    phoneE164: string;
    reliabilityScore: number | null;
    reliabilityTier: string;
    ordersCount: number;
    deliveredCount: number;
    refusedCount: number;
    returnedCount: number;
    cancelledCount: number;
  };
  readonly statusHistory: readonly {
    id: string;
    oldStatus: string | null;
    newStatus: string;
    actorKind: string;
    source: string;
    reason: string | null;
    note: string | null;
    createdAt: string;
  }[];
  readonly callAttempts: readonly {
    id: string;
    attemptNumber: number;
    outcome: string;
    note: string | null;
    scheduledCallbackAt: string | null;
    createdAt: string;
  }[];
  readonly shipments: readonly {
    id: string;
    trackingNumber: string | null;
    status: string;
    providerStatus: string | null;
    labelUrl: string | null;
    carrier: {
      code: string;
      name: string;
      /** `null` = capacites non renseignees : on n affirme rien. */
      capability: { printableLabel: boolean } | null;
    };
    events: readonly {
      id: string;
      providerStatus: string;
      normalizedStatus: string;
      description: string | null;
      location: string | null;
      occurredAt: string;
    }[];
  }[];
  readonly returns: readonly {
    id: string;
    reference: string;
    reason: string;
    status: string;
    stockDecision: string;
  }[];
  readonly duplicateFlagsAsSubject: readonly {
    id: string;
    score: number;
    confidence: string;
    explanation: string[];
    candidateOrder: { id: string; reference: string; status: string; createdAt: string };
  }[];
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations('orderDetail');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('orderStatus');
  const router = useRouter();
  const queryClient = useQueryClient();
  const orderId = params.id;

  const [pendingTransition, setPendingTransition] = useState<Transition | null>(null);
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const orderQuery = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.get<OrderDetail>(`/orders/${orderId}`),
  });

  const transitionsQuery = useQuery({
    queryKey: ['order', orderId, 'transitions'],
    queryFn: () => api.get<Transition[]>(`/orders/${orderId}/transitions`),
    enabled: Boolean(orderQuery.data),
  });

  const transitionMutation = useMutation({
    mutationFn: (payload: { status: string; reason?: string }) =>
      api.post(`/orders/${orderId}/status`, payload),
    onSuccess: () => {
      setPendingTransition(null);
      setReason('');
      setFeedback(null);
      void queryClient.invalidateQueries({ queryKey: ['order', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => {
      setFeedback(error instanceof ApiError ? error.userMessage : tCommon('actionFailed'));
    },
  });

  const shipMutation = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/ship`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['order', orderId] });
    },
    onError: (error) => {
      setFeedback(error instanceof ApiError ? error.userMessage : t('shipFailed'));
    },
  });

  if (orderQuery.isLoading) return <LoadingState />;

  if (orderQuery.error) {
    return (
      <ErrorState
        message={
          orderQuery.error instanceof ApiError
            ? orderQuery.error.userMessage
            : t('notFound')
        }
        onRetry={() => void orderQuery.refetch()}
      />
    );
  }

  const order = orderQuery.data;
  if (!order) return null;

  const wilaya = order.wilayaCodeSnapshot ? getWilayaByCode(order.wilayaCodeSnapshot) : null;

  return (
    <>
      <PageHeader
        title={order.reference}
        description={t('subtitle', {
          date: formatDateTime(order.orderedAt),
          source: order.source,
        })}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => router.push('/commandes')}>
              {t('backToList')}
            </Button>
            {order.status === 'READY_TO_SHIP' ? (
              <Button
                size="sm"
                loading={shipMutation.isPending}
                onClick={() => shipMutation.mutate()}
              >
                {t('ship')}
              </Button>
            ) : null}
          </>
        }
      />

      {feedback ? (
        <div className="mb-3">
          <Alert tone="danger">{feedback}</Alert>
        </div>
      ) : null}

      {order.duplicateFlagsAsSubject.length > 0 ? (
        <div className="mb-3">
          <Alert tone="warning" title={t('duplicateTitle')}>
            <ul className="mt-1 space-y-1">
              {order.duplicateFlagsAsSubject.map((flag) => (
                <li key={flag.id} className="text-sm">
                  <Link
                    href={`/commandes/${flag.candidateOrder.id}`}
                    className="font-mono font-medium underline"
                  >
                    {flag.candidateOrder.reference}
                  </Link>{' '}
                  —{' '}
                  {t('duplicateScore', {
                    score: flag.score,
                    confidence:
                      flag.confidence === 'LIKELY'
                        ? t('confidenceLikely')
                        : t('confidencePossible'),
                  })}
                  <ul className="ms-4 mt-0.5 list-disc text-xs opacity-80">
                    {flag.explanation.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs">
              {t('duplicateNote')}
            </p>
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* --- Etat et actions --- */}
          <Card title={t('stateTitle')}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={order.status} />
              {transitionsQuery.data?.map((transition) => (
                <Button
                  key={transition.to}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setPendingTransition(transition);
                    setReason('');
                  }}
                >
                  {t('transitionTo', { status: tStatus(transition.to) })}
                </Button>
              ))}
              {transitionsQuery.data?.length === 0 ? (
                <span className="text-sm text-slate-500">
                  {t('noTransition')}
                </span>
              ) : null}
            </div>
          </Card>

          {/* --- Articles --- */}
          <Card title={t('items')} padded={false}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{tCommon('product')}</th>
                  <th>{t('sku')}</th>
                  <th className="text-end">{tCommon('quantity')}</th>
                  <th className="text-end">{t('unitPrice')}</th>
                  <th className="text-end">{tCommon('total')}</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <p className="font-medium text-slate-800">{item.productNameSnapshot}</p>
                      {item.variantLabelSnapshot ? (
                        <p className="text-xs text-slate-500">{item.variantLabelSnapshot}</p>
                      ) : null}
                    </td>
                    <td className="font-mono text-xs text-slate-600">{item.skuSnapshot}</td>
                    <td className="tabular text-end">
                      {item.quantity}
                      {item.preparedQuantity !== null ? (
                        <span className="ms-1 text-xs text-success">
                          {t('prepared', { count: item.preparedQuantity })}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-end">
                      <Money centimes={item.unitPriceCentimes} />
                    </td>
                    <td className="text-end">
                      <Money centimes={item.lineTotalCentimes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="space-y-1 border-t border-slate-200 px-3 py-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">{t('itemsSubtotal')}</span>
                <Money centimes={order.itemsTotalCentimes} />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">{t('deliveryFee')}</span>
                <Money centimes={order.deliveryFeeCentimes} />
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold">
                <span>{t('totalDue')}</span>
                <Money centimes={order.totalCentimes} bold />
              </div>
              {order.carrierCostCentimes > 0 ? (
                <div className="flex justify-between text-xs text-slate-500">
                  <span>{t('carrierCost')}</span>
                  <Money centimes={order.carrierCostCentimes} />
                </div>
              ) : null}
            </div>
          </Card>

          {/* --- Expeditions --- */}
          {order.shipments.length > 0 ? (
            <Card title={t('shipmentTitle')}>
              {order.shipments.map((shipment) => (
                <div key={shipment.id} className="mb-4 last:mb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{shipment.carrier.name}</Badge>
                    <span className="font-mono text-sm font-medium">
                      {shipment.trackingNumber ?? '—'}
                    </span>
                    <Badge tone="neutral">{shipment.status}</Badge>
                    {shipment.providerStatus ? (
                      <span className="text-xs text-slate-500">
                        {t('providerStatus', { status: shipment.providerStatus })}
                      </span>
                    ) : null}
                    {/* Voir /expeditions : l absence d etiquette a deux causes
                        opposees, et le silence ne les distingue pas. */}
                    {shipment.labelUrl ? (
                      <a
                        href={shipment.labelUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-brand-700 underline"
                      >
                        {t('label')}
                      </a>
                    ) : shipment.carrier.capability?.printableLabel === false ? (
                      <span className="text-xs text-slate-400" title={t('noLabelHint')}>
                        {t('noLabel')}
                      </span>
                    ) : null}
                  </div>

                  <ol className="mt-2 space-y-1.5 border-s-2 border-slate-200 ps-3">
                    {shipment.events.map((event) => (
                      <li key={event.id} className="text-sm">
                        <span className="text-slate-800">{event.providerStatus}</span>
                        {event.location ? (
                          <span className="text-slate-500"> — {event.location}</span>
                        ) : null}
                        <span className="ms-2 text-xs text-slate-400">
                          {formatDateTime(event.occurredAt)}
                        </span>
                        {event.description ? (
                          <p className="text-xs text-slate-500">{event.description}</p>
                        ) : null}
                      </li>
                    ))}
                    {shipment.events.length === 0 ? (
                      <li className="text-sm text-slate-500">{t('noEvents')}</li>
                    ) : null}
                  </ol>
                </div>
              ))}
            </Card>
          ) : null}

          {/* --- Historique --- */}
          <Card title={t('history')}>
            <ol className="space-y-2 border-s-2 border-slate-200 ps-3">
              {order.statusHistory.map((entry) => (
                <li key={entry.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {entry.oldStatus ? <StatusBadge status={entry.oldStatus} /> : null}
                    {/* La fleche de transition suit le sens de lecture : elle
                        pointe vers la droite en francais, vers la gauche en
                        arabe. Un caractere « → » fige resterait tourne a
                        l'envers en RTL et inverserait le sens de l'histoire. */}
                    <span className="text-slate-400 rtl:-scale-x-100">→</span>
                    <StatusBadge status={entry.newStatus} />
                    <span className="text-xs text-slate-400">
                      {formatDateTime(entry.createdAt)}
                    </span>
                    <Badge tone="neutral">
                      {entry.actorKind === 'SYSTEM' ? t('actorSystem') : t('actorUser')}
                    </Badge>
                    <span className="text-xs text-slate-400">{entry.source}</span>
                  </div>
                  {entry.reason ? (
                    <p className="mt-0.5 text-xs text-slate-600">
                      {t('reasonLine', { reason: entry.reason })}
                    </p>
                  ) : null}
                  {entry.note ? (
                    <p className="mt-0.5 text-xs text-slate-600">{entry.note}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          </Card>

          {/* --- Appels --- */}
          {order.callAttempts.length > 0 ? (
            <Card title={t('callAttempts', { count: order.callAttempts.length })}>
              <ul className="space-y-2">
                {order.callAttempts.map((attempt) => (
                  <li key={attempt.id} className="flex items-start gap-2 text-sm">
                    <Badge tone="neutral">#{attempt.attemptNumber}</Badge>
                    <div>
                      <p className="text-slate-800">{attempt.outcome}</p>
                      {attempt.note ? (
                        <p className="text-xs text-slate-600">{attempt.note}</p>
                      ) : null}
                      <p className="text-xs text-slate-400">
                        {formatDateTime(attempt.createdAt)}
                        {attempt.scheduledCallbackAt
                          ? t('callbackScheduled', {
                              date: formatDateTime(attempt.scheduledCallbackAt),
                            })
                          : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        {/* --- Colonne laterale --- */}
        <div className="space-y-4">
          <Card title={t('customer')}>
            <p className="text-base font-medium text-slate-900">{order.customerNameSnapshot}</p>
            <a
              href={`tel:${order.phoneSnapshot}`}
              className="tabular mt-0.5 block text-sm text-brand-700 hover:underline"
            >
              {order.phoneSnapshot}
            </a>
            <div className="mt-2">
              <ReliabilityBadge
                tier={order.customer.reliabilityTier}
                score={order.customer.reliabilityScore}
              />
            </div>

            <dl className="mt-3 space-y-1 text-sm">
              <Row label={t('customerOrders')} value={order.customer.ordersCount} />
              <Row label={t('customerDelivered')} value={order.customer.deliveredCount} />
              <Row label={t('customerRefused')} value={order.customer.refusedCount} />
              <Row label={t('customerReturned')} value={order.customer.returnedCount} />
              <Row label={t('customerCancelled')} value={order.customer.cancelledCount} />
            </dl>

            <Link
              href={`/clients/${order.customer.id}`}
              className="mt-3 block text-sm text-brand-700 hover:underline"
            >
              {t('viewCustomer')}
            </Link>
          </Card>

          <Card title={t('delivery')}>
            <p className="text-sm text-slate-900">
              {wilaya ? `${wilaya.code2} — ${wilaya.name}` : tCommon('none')}
            </p>
            <p className="text-sm text-slate-700">{order.communeSnapshot ?? tCommon('none')}</p>
            <p className="mt-1 text-sm text-slate-600">
              {order.addressSnapshot ?? tCommon('none')}
            </p>
          </Card>

          <Card title={t('dates')}>
            <dl className="space-y-1 text-sm">
              <Row label={t('dateOrdered')} value={formatDateTime(order.orderedAt)} />
              <Row label={t('dateConfirmed')} value={formatDateTime(order.confirmedAt)} />
              <Row label={t('dateShipped')} value={formatDateTime(order.shippedAt)} />
              <Row label={t('dateDelivered')} value={formatDateTime(order.deliveredAt)} />
            </dl>
          </Card>

          {order.returns.length > 0 ? (
            <Card title={t('returns')}>
              {order.returns.map((entry) => (
                <div key={entry.id} className="text-sm">
                  <p className="font-mono font-medium">{entry.reference}</p>
                  <p className="text-slate-600">{entry.reason}</p>
                  <Badge tone="warning">{entry.status}</Badge>
                </div>
              ))}
            </Card>
          ) : null}
        </div>
      </div>

      {/* --- Confirmation de transition --- */}
      <ConfirmDialog
        open={pendingTransition !== null}
        title={t('confirmTransition', {
          status: pendingTransition ? tStatus(pendingTransition.to) : '',
        })}
        message={
          pendingTransition?.requiresReason ? t('reasonRequired') : t('transitionWarning')
        }
        danger={pendingTransition?.to === 'CANCELLED'}
        loading={transitionMutation.isPending}
        onCancel={() => setPendingTransition(null)}
        onConfirm={() => {
          if (!pendingTransition) return;
          transitionMutation.mutate({
            status: pendingTransition.to,
            reason: reason.trim() || undefined,
          });
        }}
      >
        {pendingTransition?.requiresReason ? (
          <Input
            label={tCommon('reason')}
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('reasonPlaceholder')}
          />
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="tabular text-slate-800">{value}</dd>
    </div>
  );
}
