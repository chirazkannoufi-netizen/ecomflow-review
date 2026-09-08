'use client';

/**
 * Fiche client — Addendum §32.
 *
 * LE SCORE EST EXPLIQUE, JAMAIS ASSENE.
 *   Un score de fiabilite qui apparait sans justification est ingerable : un
 *   agent ne peut ni le contester ni l'expliquer au client. Cette fiche affiche
 *   donc chaque facteur avec son impact en points et son detail chiffre.
 *
 * LES ACTIONS RECOMMANDEES RESTENT DES RECOMMANDATIONS.
 *   Le systeme ne bloque jamais une commande de lui-meme : il propose, le
 *   commercant decide.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PERMISSIONS } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  Money,
  ReliabilityBadge,
  StatusBadge,
  Textarea,
  formatDate,
} from '@/components/ui';

interface CustomerDetail {
  readonly id: string;
  readonly fullName: string;
  readonly phoneE164: string;
  readonly secondaryPhone: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly ordersCount: number;
  readonly deliveredCount: number;
  readonly refusedCount: number;
  readonly returnedCount: number;
  readonly cancelledCount: number;
  readonly unreachableCount: number;
  readonly consecutiveFailures: number;
  readonly lastOrderAt: string | null;
  readonly anonymizedAt: string | null;
  readonly createdAt: string;
  readonly addresses: readonly {
    id: string;
    label: string | null;
    wilayaCode: number;
    commune: string | null;
    addressLine: string | null;
    isDefault: boolean;
  }[];
  readonly orders: readonly {
    id: string;
    reference: string;
    status: string;
    totalCentimes: number;
    orderedAt: string;
    deliveredAt: string | null;
    source: string;
  }[];
  readonly reliability: {
    score: number | null;
    tier: string;
    consideredOutcomes: number;
    factors: readonly { code: string; label: string; impact: number; detail: string }[];
    recommendedActions: readonly string[];
  };
}

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const customerId = params.id;
  const t = useTranslations('customerDetail');
  const tCommon = useTranslations('common');
  const { can } = useSession();
  const queryClient = useQueryClient();

  const [notes, setNotes] = useState<string | null>(null);
  const [confirmAnonymize, setConfirmAnonymize] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => api.get<CustomerDetail>(`/customers/${customerId}`),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.patch(`/customers/${customerId}`, payload),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: t('updated') });
      setNotes(null);
      void queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('updateFailed'),
      });
    },
  });

  const recomputeMutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/recompute-reliability`, {}),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: t('recomputed') });
      void queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
    },
  });

  const anonymizeMutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/anonymize`, {}),
    onSuccess: () => {
      setConfirmAnonymize(false);
      void queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('anonymizeFailed'),
      });
    },
  });

  if (isLoading) return <LoadingState />;

  if (error) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.userMessage : t('notFound')}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!data) return null;

  const { reliability } = data;

  return (
    <>
      <PageHeader
        title={data.fullName}
        description={t('since', { date: formatDate(data.createdAt) })}
        actions={
          <>
            <Link href="/clients">
              <span className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700">
                {tCommon('back')}
              </span>
            </Link>
            {can(PERMISSIONS.CUSTOMERS_MANAGE) ? (
              <Button
                size="sm"
                variant="secondary"
                loading={recomputeMutation.isPending}
                onClick={() => recomputeMutation.mutate()}
              >
                {t('recompute')}
              </Button>
            ) : null}
          </>
        }
      />

      {data.anonymizedAt ? (
        <div className="mb-3">
          <Alert tone="info" title={t('anonymizedTitle')}>
            {t('anonymized', { date: formatDate(data.anonymizedAt) })}
          </Alert>
        </div>
      ) : null}

      {feedback ? (
        <div className="mb-3">
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.text}</Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* --- Explication du score ------------------------------------- */}
          <Card
            title={t('scoreTitle')}
            action={<ReliabilityBadge tier={reliability.tier} score={reliability.score} />}
          >
            {reliability.score === null ? (
              <Alert tone="info">
                {t('insufficientHistory', { count: reliability.consideredOutcomes })}
              </Alert>
            ) : (
              <>
                <p className="text-sm text-slate-600">
                  {t('scoreIntro', { count: reliability.consideredOutcomes })}
                </p>

                <ul className="mt-3 space-y-1.5">
                  {reliability.factors.map((factor) => (
                    <li
                      key={factor.code}
                      className="flex items-start justify-between gap-3 rounded-md bg-slate-50 px-3 py-2"
                    >
                      <div>
                        <p className="text-sm font-medium text-slate-800">{factor.label}</p>
                        <p className="text-xs text-slate-500">{factor.detail}</p>
                      </div>
                      <span
                        className={
                          factor.impact >= 0
                            ? 'tabular whitespace-nowrap text-sm font-semibold text-success'
                            : 'tabular whitespace-nowrap text-sm font-semibold text-danger'
                        }
                      >
                        {t('points', {
                          impact: `${factor.impact > 0 ? '+' : ''}${factor.impact}`,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {reliability.recommendedActions.length > 0 ? (
              <div className="mt-3 border-t border-slate-200 pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {t('recommendations')}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {reliability.recommendedActions.map((action) => (
                    <li key={action} className="text-sm text-slate-700">
                      • {t(`actions.${action}`)}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-slate-500">
                  {t('recommendationsNote')}
                </p>
              </div>
            ) : null}
          </Card>

          {/* --- Historique de commandes ---------------------------------- */}
          <Card title={t('ordersTitle', { count: data.orders.length })} padded={false}>
            {data.orders.length === 0 ? (
              <p className="px-3 py-4 text-sm text-slate-500">{t('noOrders')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{tCommon('reference')}</th>
                    <th>{tCommon('status')}</th>
                    <th className="text-end">{tCommon('total')}</th>
                    <th>{t('orderedOn')}</th>
                    <th>{t('deliveredOn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <Link
                          href={`/commandes/${order.id}`}
                          className="font-mono text-xs font-medium text-brand-700 hover:underline"
                        >
                          {order.reference}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={order.status} />
                      </td>
                      <td className="text-end">
                        <Money centimes={order.totalCentimes} />
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatDate(order.orderedAt)}
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatDate(order.deliveredAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={t('contact')}>
            <dl className="space-y-1.5 text-sm">
              <Row label={tCommon('phone')}>
                <a href={`tel:${data.phoneE164}`} className="tabular text-brand-700">
                  {data.phoneE164}
                </a>
              </Row>
              <Row label={t('secondaryPhone')}>
                <span className="tabular">{data.secondaryPhone ?? '—'}</span>
              </Row>
              <Row label={t('email')}>{data.email ?? tCommon('none')}</Row>
              <Row label={t('lastOrder')}>{formatDate(data.lastOrderAt)}</Row>
            </dl>

            {data.tags.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {data.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Card>

          <Card title={t('summary')}>
            <dl className="space-y-1 text-sm">
              <Row label={t('orders')}>{data.ordersCount}</Row>
              <Row label={t('delivered')}>
                <span className="text-success">{data.deliveredCount}</span>
              </Row>
              <Row label={t('refused')}>
                <span className="text-danger">{data.refusedCount}</span>
              </Row>
              <Row label={t('returned')}>
                <span className="text-danger">{data.returnedCount}</span>
              </Row>
              <Row label={t('cancelled')}>{data.cancelledCount}</Row>
              <Row label={t('unreachable')}>{data.unreachableCount}</Row>
              <Row label={t('consecutiveFailures')}>
                <span
                  className={data.consecutiveFailures >= 3 ? 'font-semibold text-danger' : ''}
                >
                  {data.consecutiveFailures}
                </span>
              </Row>
            </dl>
          </Card>

          <Card title={t('addresses')}>
            {data.addresses.length === 0 ? (
              <p className="text-sm text-slate-500">{t('noAddress')}</p>
            ) : (
              <ul className="space-y-2">
                {data.addresses.map((address) => (
                  <li key={address.id} className="text-sm">
                    <p className="text-slate-800">
                      {address.commune ?? tCommon('none')}
                      <span className="tabular ms-1 text-xs text-slate-500">
                        {t('wilayaShort', { code: address.wilayaCode })}
                      </span>
                      {address.isDefault ? (
                        <Badge tone="info" className="ms-1.5">
                          {t('defaultAddress')}
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-xs text-slate-500">
                      {address.addressLine ?? tCommon('none')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {can(PERMISSIONS.CUSTOMERS_MANAGE) && !data.anonymizedAt ? (
            <Card title={t('internalNotes')}>
              <Textarea
                rows={4}
                value={notes ?? data.notes ?? ''}
                onChange={(event) => setNotes(event.target.value)}
                placeholder={t('notesPlaceholder')}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={notes === null}
                  loading={updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ notes: notes ?? '' })}
                >
                  {tCommon('save')}
                </Button>
                {notes !== null ? (
                  <Button size="sm" variant="ghost" onClick={() => setNotes(null)}>
                    {tCommon('cancel')}
                  </Button>
                ) : null}
              </div>

              <div className="mt-4 border-t border-slate-200 pt-3">
                <p className="text-xs text-slate-500">
                  {t('gdprNote')}
                </p>
                <button
                  className="mt-1.5 text-xs text-danger hover:underline"
                  onClick={() => setConfirmAnonymize(true)}
                >
                  {t('anonymize')}
                </button>
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmAnonymize}
        title={t('anonymizeTitle')}
        message={t('anonymizeWarning')}
        confirmLabel={t('anonymizeConfirm')}
        danger
        loading={anonymizeMutation.isPending}
        onCancel={() => setConfirmAnonymize(false)}
        onConfirm={() => anonymizeMutation.mutate()}
      />
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="tabular text-end text-slate-800">{children}</dd>
    </div>
  );
}
