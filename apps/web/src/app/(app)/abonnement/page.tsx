'use client';

/**
 * Abonnement — V2 §21, Addendum §35.
 *
 * DEUX REALITES DU MARCHE ALGERIEN, ASSUMEES.
 *   Le paiement par carte n'est pas la norme. Le virement bancaire et BaridiMob
 *   le sont. Les trois sont donc traites a egalite, sans presenter le paiement
 *   manuel comme un pis-aller.
 *
 * UN JUSTIFICATIF N'EST PAS UN PAIEMENT.
 *   Envoyer une capture d'ecran met le paiement « en attente de verification »,
 *   rien de plus. L'ecran le dit clairement : promettre une activation immediate
 *   serait un mensonge, et le premier litige detruirait la confiance.
 *
 * LE PAIEMENT PAR CARTE N'EST PROPOSE QUE S'IL EST REELLEMENT CONFIGURE.
 *   `paymentMethodsAvailable.card` vient du serveur et reflete la presence
 *   effective des cles Chargily.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PERMISSIONS, formatCentimes } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { subscriptionReasonKey } from '@/lib/subscription-reason';
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
  Textarea,
  formatDate,
  formatDateTime,
} from '@/components/ui';

interface Plan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceCentimes: number;
  readonly billingPeriod: string;
  readonly limits: Record<string, number | null>;
  readonly features: Record<string, boolean>;
}

interface Subscription {
  readonly status: string;
  readonly operational: boolean;
  readonly reason: string | null;
  readonly trialDaysRemaining: number | null;
  readonly periodDaysRemaining: number | null;
  readonly trialStartAt: string | null;
  readonly trialEndAt: string | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelledAt: string | null;
  readonly plan: {
    id: string;
    code: string;
    name: string;
    priceCentimes: number;
    billingPeriod: string;
  } | null;
  readonly paymentMethodsAvailable: {
    card: boolean;
    manualTransfer: boolean;
    baridimob: boolean;
  };
}

interface Payment {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
  readonly amountCentimes: number;
  readonly currency: string;
  readonly checkoutUrl: string | null;
  readonly proofUrl: string | null;
  readonly reviewNote: string | null;
  readonly paidAt: string | null;
  readonly createdAt: string;
}

export default function SubscriptionPage() {
  const t = useTranslations('subscription');
  const tCommon = useTranslations('common');
  const tBanner = useTranslations('subscriptionBanner');
  const { can } = useSession();
  const queryClient = useQueryClient();

  const canManage = can(PERMISSIONS.BILLING_MANAGE);

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [manualProvider, setManualProvider] = useState<'BANK_TRANSFER' | 'BARIDIMOB'>(
    'BANK_TRANSFER',
  );
  const [proofUrl, setProofUrl] = useState('');
  const [note, setNote] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );

  const subscriptionQuery = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: () => api.get<Subscription>('/subscriptions/current'),
  });

  const plansQuery = useQuery({
    queryKey: ['billing', 'plans'],
    queryFn: () => api.get<Plan[]>('/plans'),
  });

  const paymentsQuery = useQuery({
    queryKey: ['billing', 'payments'],
    queryFn: () => api.get<Payment[]>('/payments'),
    enabled: can(PERMISSIONS.BILLING_VIEW),
  });

  const checkoutMutation = useMutation({
    mutationFn: (planId: string) =>
      api.post<{ checkoutUrl: string }>('/payments/checkout', { planId }),
    onSuccess: (result) => {
      window.location.href = result.checkoutUrl;
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('cardFailed'),
      });
    },
  });

  const manualMutation = useMutation({
    mutationFn: () =>
      api.post('/payments/manual', {
        planId: selectedPlanId,
        provider: manualProvider,
        proofUrl: proofUrl.trim(),
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setProofUrl('');
      setNote('');
      setSelectedPlanId(null);
      setFeedback({
        tone: 'success',
        text: t('proofSent'),
      });
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('proofFailed'),
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post('/subscriptions/cancel', {}),
    onSuccess: () => {
      setConfirmCancel(false);
      setFeedback({
        tone: 'success',
        text: t('cancelled'),
      });
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('cancelFailed'),
      });
    },
  });

  if (subscriptionQuery.isLoading) return <LoadingState />;

  if (subscriptionQuery.error) {
    return (
      <ErrorState
        message={
          subscriptionQuery.error instanceof ApiError
            ? subscriptionQuery.error.userMessage
            : tCommon('loadFailed')
        }
        onRetry={() => void subscriptionQuery.refetch()}
      />
    );
  }

  const subscription = subscriptionQuery.data;
  if (!subscription) return null;

  const selectedPlan = plansQuery.data?.find((plan) => plan.id === selectedPlanId) ?? null;
  const reasonKey = subscriptionReasonKey(subscription.status);

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

      {/* --- Etat actuel ---------------------------------------------------- */}
      <Card
        title={t('currentTitle')}
        className="mb-4"
        action={
          <Badge
            tone={
              subscription.operational
                ? subscription.status === 'TRIALING'
                  ? 'info'
                  : 'success'
                : 'danger'
            }
          >
            {t(`status.${subscription.status}`)}
          </Badge>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <dl className="space-y-1.5 text-sm">
            <Row label={t('plan')}>{subscription.plan?.name ?? t('none')}</Row>
            {subscription.plan ? (
              <Row label={t('price')}>
                <Money centimes={subscription.plan.priceCentimes} />
                <span className="ms-1 text-xs text-slate-500">
                  {subscription.plan.billingPeriod === 'YEARLY' ? t('perYear') : t('perMonth')}
                </span>
              </Row>
            ) : null}
            {subscription.status === 'TRIALING' ? (
              <>
                <Row label={t('trialUntil')}>{formatDate(subscription.trialEndAt)}</Row>
                <Row label={t('daysRemaining')}>
                  <span
                    className={
                      (subscription.trialDaysRemaining ?? 0) <= 2
                        ? 'font-semibold text-warning'
                        : ''
                    }
                  >
                    {subscription.trialDaysRemaining ?? '—'}
                  </span>
                </Row>
              </>
            ) : (
              <>
                <Row label={t('currentPeriod')}>
                  {formatDate(subscription.currentPeriodStart)} —{' '}
                  {formatDate(subscription.currentPeriodEnd)}
                </Row>
                <Row label={t('daysRemaining')}>
                  {subscription.periodDaysRemaining ?? tCommon('none')}
                </Row>
              </>
            )}
            {subscription.cancelledAt ? (
              <Row label={t('cancelledOn')}>{formatDate(subscription.cancelledAt)}</Row>
            ) : null}
          </dl>

          <div>
            {!subscription.operational ? (
              <Alert tone="danger" title={t('restrictedTitle')}>
                {/* Meme motif que le bandeau de la coque applicative, meme
                    raison de ne pas afficher `reason` brut : il arrive du
                    serveur en francais. Voir `lib/subscription-reason.ts`. */}
                {reasonKey
                  ? tBanner(reasonKey)
                  : (subscription.reason ?? t('restrictedDefault'))}{' '}
                {t('restricted')}
              </Alert>
            ) : subscription.status === 'TRIALING' &&
              (subscription.trialDaysRemaining ?? 99) <= 3 ? (
              <Alert tone="warning">
                {t('trialEnding', { days: subscription.trialDaysRemaining ?? 0 })}
              </Alert>
            ) : (
              <Alert tone="success">
                {t('allGood')}
              </Alert>
            )}

            {canManage && subscription.status === 'ACTIVE' && !subscription.cancelledAt ? (
              <button
                className="mt-3 text-xs text-slate-500 hover:text-danger hover:underline"
                onClick={() => setConfirmCancel(true)}
              >
                {t('cancel')}
              </button>
            ) : null}
          </div>
        </div>
      </Card>

      {/* --- Formules -------------------------------------------------------- */}
      <Card title={t('plansTitle')} className="mb-4">
        {plansQuery.isLoading ? (
          <LoadingState />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {plansQuery.data?.map((plan) => {
              const isCurrent = subscription.plan?.id === plan.id;

              return (
                <div
                  key={plan.id}
                  className={
                    selectedPlanId === plan.id
                      ? 'rounded-lg border-2 border-brand-500 p-3.5'
                      : 'rounded-lg border border-slate-200 p-3.5'
                  }
                >
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-semibold text-slate-900">{plan.name}</h3>
                    {isCurrent ? <Badge tone="info">{t('current')}</Badge> : null}
                  </div>

                  <p className="mt-1">
                    <span className="tabular text-xl font-bold text-slate-900">
                      {formatCentimes(plan.priceCentimes)}
                    </span>
                    <span className="text-xs text-slate-500">
                      {' '}
                      {plan.billingPeriod === 'YEARLY' ? t('perYear') : t('perMonth')}
                    </span>
                  </p>

                  {plan.description ? (
                    <p className="mt-1 text-xs text-slate-600">{plan.description}</p>
                  ) : null}

                  <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                    {Object.entries(plan.limits ?? {}).map(([key, value]) => (
                      <li key={key}>
                        {t(`limits.${key}`)} :{' '}
                        <span className="tabular font-medium">
                          {value === null ? t('unlimited') : value}
                        </span>
                      </li>
                    ))}
                    {Object.entries(plan.features ?? {})
                      .filter(([, enabled]) => enabled)
                      .map(([key]) => (
                        <li key={key}>✓ {t(`features.${key}`)}</li>
                      ))}
                  </ul>

                  {canManage && !isCurrent ? (
                    <Button
                      size="sm"
                      variant={selectedPlanId === plan.id ? 'primary' : 'secondary'}
                      className="mt-3 w-full"
                      onClick={() => setSelectedPlanId(plan.id)}
                    >
                      {t('choose')}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* --- Paiement -------------------------------------------------------- */}
      {canManage && selectedPlan ? (
        <Card title={t('payTitle', { plan: selectedPlan.name })} className="mb-4">
          <p className="text-sm text-slate-700">
            {t('amountDue')} <Money centimes={selectedPlan.priceCentimes} bold />
          </p>

          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {/* Carte bancaire */}
            <div className="rounded-lg border border-slate-200 p-3.5">
              <h3 className="text-sm font-semibold text-slate-900">{t('cardTitle')}</h3>
              {subscription.paymentMethodsAvailable.card ? (
                <>
                  <p className="mt-1 text-xs text-slate-600">
                    {t('cardHint')}
                  </p>
                  <Button
                    size="sm"
                    className="mt-2 w-full"
                    loading={checkoutMutation.isPending}
                    onClick={() => checkoutMutation.mutate(selectedPlan.id)}
                  >
                    {t('payByCard')}
                  </Button>
                </>
              ) : (
                <Alert tone="info">
                  {t('cardUnavailable')}
                </Alert>
              )}
            </div>

            {/* Paiement manuel */}
            <div className="rounded-lg border border-slate-200 p-3.5">
              <h3 className="text-sm font-semibold text-slate-900">{t('manualTitle')}</h3>
              <p className="mt-1 text-xs text-slate-600">
                {t('manualHint')}
              </p>

              <div className="mt-2 flex rounded-md border border-slate-300 p-0.5">
                {(
                  [
                    ['BANK_TRANSFER', 'transfer'],
                    ['BARIDIMOB', 'baridimob'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setManualProvider(value)}
                    className={
                      manualProvider === value
                        ? 'flex-1 rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white'
                        : 'flex-1 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100'
                    }
                  >
                    {t(label)}
                  </button>
                ))}
              </div>

              <div className="mt-2 space-y-2">
                <Input
                  label={t('proofUrl')}
                  type="url"
                  required
                  value={proofUrl}
                  onChange={(event) => setProofUrl(event.target.value)}
                  placeholder="https://drive.google.com/…"
                  hint={t('proofHint')}
                />
                <Textarea
                  label={t('manualNote')}
                  rows={2}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t('manualNotePlaceholder')}
                />
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!proofUrl.trim()}
                  loading={manualMutation.isPending}
                  onClick={() => manualMutation.mutate()}
                >
                  {t('submitProof')}
                </Button>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                {t('proofWarning')}
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      {/* --- Historique des paiements ---------------------------------------- */}
      <Card title={t('historyTitle')} padded={false}>
        {paymentsQuery.isLoading ? (
          <LoadingState />
        ) : (paymentsQuery.data?.length ?? 0) === 0 ? (
          <p className="px-3 py-4 text-sm text-slate-500">{t('noPayment')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('paymentColumns.date')}</th>
                  <th>{t('paymentColumns.method')}</th>
                  <th className="text-end">{t('paymentColumns.amount')}</th>
                  <th>{t('paymentColumns.status')}</th>
                  <th>{t('paymentColumns.note')}</th>
                </tr>
              </thead>
              <tbody>
                {paymentsQuery.data?.map((payment) => (
                  <tr key={payment.id}>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {formatDateTime(payment.paidAt ?? payment.createdAt)}
                    </td>
                    <td className="text-sm text-slate-700">{payment.provider}</td>
                    <td className="text-end">
                      <Money centimes={payment.amountCentimes} />
                    </td>
                    <td>
                      <Badge
                        tone={
                          payment.status === 'PAID'
                            ? 'success'
                            : payment.status === 'AWAITING_REVIEW' || payment.status === 'PENDING'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {t(`paymentStatus.${payment.status}`)}
                      </Badge>
                    </td>
                    <td className="max-w-[240px] text-xs text-slate-600">
                      {payment.reviewNote ?? tCommon('none')}
                      {payment.checkoutUrl && payment.status === 'PENDING' ? (
                        <a
                          href={payment.checkoutUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="ms-1.5 text-brand-700 underline"
                        >
                          {t('resumePayment')}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmCancel}
        title={t('cancelTitle')}
        message={t('cancelWarning')}
        confirmLabel={t('cancelConfirm')}
        danger
        loading={cancelMutation.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => cancelMutation.mutate()}
      />
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-end text-slate-800">{children}</dd>
    </div>
  );
}
