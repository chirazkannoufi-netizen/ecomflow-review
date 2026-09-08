'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PackageCheck, Phone, RotateCcw, ShoppingBag, TrendingDown, TrendingUp } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  LoadingState,
  MetricCard,
  Money,
  Numeric,
  SignedMoney,
  StatusBadge,
  formatPercent,
} from '@/components/ui';

interface Overview {
  readonly range: { from: string; to: string };
  readonly orders: {
    total: number;
    byStatus: Record<string, number>;
    toConfirm: number;
    confirmed: number;
    shipped: number;
    inDelivery: number;
    delivered: number;
    returned: number;
    cancelled: number;
    refused: number;
    rates: {
      confirmation: number | null;
      delivery: number | null;
      return: number | null;
      cancellation: number | null;
    };
  };
  readonly financial: {
    recognizedRevenueCentimes: number;
    cogsCentimes: number;
    shippingCostCentimes: number;
    netResultCentimes: number;
    realizedLossCentimes: number;
    opportunityLossCentimes: number;
    netMarginPercent: number | null;
    cogsCompleteness: number;
    averageOrderValueCentimes: number;
  };
  readonly daily: readonly {
    day: string;
    orders: number;
    delivered: number;
    cancelled: number;
    revenueCentimes: number;
  }[];
  readonly alerts: {
    pendingConfirmation: number;
    lowStock: number;
    failedImports: number;
    pendingDuplicates: number;
    integrationsInError: number;
  };
}

const PERIODS = [7, 30, 90] as const;

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const [days, setDays] = useState<number>(30);

  const from = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'overview', days],
    queryFn: () => api.get<Overview>('/dashboard/overview', { query: { from } }),
  });

  if (isLoading) return <LoadingState />;

  if (error) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.userMessage : tCommon('loadFailed')}
        correlationId={error instanceof ApiError ? error.correlationId : undefined}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!data) return null;

  const { orders, financial, alerts, daily } = data;
  const maxDailyOrders = Math.max(1, ...daily.map((entry) => entry.orders));

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <div className="flex rounded-md border border-slate-300 bg-white p-0.5">
            {PERIODS.map((period) => (
              <button
                key={period}
                onClick={() => setDays(period)}
                className={
                  days === period
                    ? 'rounded bg-brand-600 px-2.5 py-1 text-xs font-medium text-white'
                    : 'rounded px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100'
                }
              >
                {t(`periods.${period}`)}
              </button>
            ))}
          </div>
        }
      />

      {/* --- Alertes actionnables ------------------------------------------ */}
      <div className="mb-4 space-y-2">
        {alerts.pendingConfirmation > 0 ? (
          <Alert
            tone="warning"
            action={
              <Link href="/confirmation">
                <Button variant="secondary" size="sm">
                  {t('alerts.pendingConfirmationAction')}
                </Button>
              </Link>
            }
          >
            {t('alerts.pendingConfirmation', { count: alerts.pendingConfirmation })}
          </Alert>
        ) : null}

        {alerts.failedImports > 0 ? (
          <Alert
            tone="danger"
            action={
              <Link href="/integrations">
                <Button variant="secondary" size="sm">
                  {t('alerts.failedImportsAction')}
                </Button>
              </Link>
            }
          >
            {t('alerts.failedImports', { count: alerts.failedImports })}
          </Alert>
        ) : null}

        {alerts.lowStock > 0 ? (
          <Alert
            tone="warning"
            action={
              <Link href="/stock">
                <Button variant="secondary" size="sm">
                  {t('alerts.lowStockAction')}
                </Button>
              </Link>
            }
          >
            {t('alerts.lowStock', { count: alerts.lowStock })}
          </Alert>
        ) : null}

        {alerts.pendingDuplicates > 0 ? (
          <Alert
            tone="info"
            action={
              <Link href="/commandes?doublons=1">
                <Button variant="secondary" size="sm">
                  {t('alerts.duplicatesAction')}
                </Button>
              </Link>
            }
          >
            {t('alerts.duplicates', { count: alerts.pendingDuplicates })}
          </Alert>
        ) : null}
      </div>

      {/* --- Indicateurs de volume ----------------------------------------- */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label={t('kpi.orders')}
          value={orders.total}
          tone="neutral"
          icon={<ShoppingBag className="h-3.5 w-3.5" strokeWidth={1.8} />}
        />
        <MetricCard
          label={t('kpi.toConfirm')}
          value={orders.toConfirm}
          tone="warning"
          href="/confirmation"
          icon={<Phone className="h-3.5 w-3.5" strokeWidth={1.8} />}
        />
        <MetricCard
          label={t('kpi.delivered')}
          value={orders.delivered}
          tone="success"
          icon={<PackageCheck className="h-3.5 w-3.5" strokeWidth={1.8} />}
        />
        <MetricCard
          label={t('kpi.returnsAndRefusals')}
          value={orders.returned + orders.refused}
          tone="danger"
          href="/retours"
          icon={<RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} />}
        />
      </div>

      {/* --- Taux ----------------------------------------------------------- */}
      <div className="mb-4 grid gap-3 lg:grid-cols-4">
        <RateTile
          label={t('rates.confirmation')}
          value={orders.rates.confirmation}
          hint={t('rates.confirmationHint')}
        />
        <RateTile
          label={t('rates.delivery')}
          value={orders.rates.delivery}
          hint={t('rates.deliveryHint')}
        />
        <RateTile
          label={t('rates.return')}
          value={orders.rates.return}
          hint={t('rates.returnHint')}
          inverse
        />
        <RateTile
          label={t('rates.cancellation')}
          value={orders.rates.cancellation}
          hint={t('rates.cancellationHint')}
          inverse
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- Activite quotidienne --------------------------------------- */}
        <Card title={t('daily.title')} className="lg:col-span-2">
          {daily.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">{t('daily.empty')}</p>
          ) : (
            /* `items-end` sur la ligne empechait les colonnes de s'etirer
               sur la hauteur du conteneur (elles se dimensionnaient a leur
               propre contenu, qui depend d'un pourcentage de CETTE hauteur
               — un effondrement circulaire qui rendait les barres
               invisibles). Sans classe d'alignement, `align-items: stretch`
               (valeur par defaut) etire chaque colonne sur les 160px du
               conteneur, et c'est `justify-end` sur CHAQUE colonne qui
               pousse ses deux barres vers le bas. */
            <div className="flex h-40 gap-1">
              {daily.map((entry) => (
                <div
                  key={entry.day}
                  className="group relative flex flex-1 flex-col items-center justify-end"
                  title={`${entry.day} — ${entry.orders} commande(s), ${entry.delivered} livree(s)`}
                >
                  <div
                    className="w-full rounded-t bg-brand-500/80 transition-colors group-hover:bg-brand-600"
                    style={{ height: `${(entry.orders / maxDailyOrders) * 100}%` }}
                  />
                  <div
                    className="w-full bg-success/80"
                    style={{ height: `${(entry.delivered / maxDailyOrders) * 100}%` }}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-brand-500" /> {t('daily.orders')}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-success" /> {t('daily.delivered')}
            </span>
          </div>
        </Card>

        {/* --- Resultat financier ------------------------------------------ */}
        <Card title={t('financial.title')}>
          <dl className="space-y-2.5 text-sm">
            <Row label={t('financial.revenue')}>
              <Money centimes={financial.recognizedRevenueCentimes} bold />
            </Row>
            <Row label={t('financial.cogs')}>
              <Money centimes={-financial.cogsCentimes} />
            </Row>
            <Row label={t('financial.shipping')}>
              <Money centimes={-financial.shippingCostCentimes} />
            </Row>
            <div className="border-t border-slate-200 pt-2.5">
              <Row label={t('financial.netResult')}>
                <SignedMoney centimes={financial.netResultCentimes} />
              </Row>
            </div>
            <Row label={t('financial.netMargin')}>
              <Numeric>{formatPercent(financial.netMarginPercent)}</Numeric>
            </Row>
            <div className="border-t border-slate-200 pt-2.5">
              <Row label={t('financial.realizedLoss')}>
                <Money centimes={financial.realizedLossCentimes} className="text-danger" />
              </Row>
              <Row label={t('financial.opportunityLoss')}>
                <Money centimes={financial.opportunityLossCentimes} className="text-warning" />
              </Row>
            </div>
          </dl>

          {financial.cogsCompleteness < 1 ? (
            <div className="mt-3">
              <Alert tone="warning">
                {t('financial.incompleteCogs', {
                  percent: Math.round((1 - financial.cogsCompleteness) * 100),
                })}
              </Alert>
            </div>
          ) : null}

          <p className="mt-3 text-xs text-slate-500">{t('financial.codNote')}</p>
        </Card>
      </div>

      {/* --- Repartition par statut ---------------------------------------- */}
      <Card title={t('byStatus.title')} className="mt-4">
        <div className="flex flex-wrap gap-2">
          {Object.entries(orders.byStatus)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => (
              <Link
                key={status}
                href={`/commandes?status=${status}`}
                className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50"
              >
                <StatusBadge status={status} />
                <span className="tabular text-sm font-medium text-slate-700">{count}</span>
              </Link>
            ))}
          {Object.keys(orders.byStatus).length === 0 ? (
            <p className="text-sm text-slate-500">{t('byStatus.empty')}</p>
          ) : null}
        </div>
      </Card>
    </>
  );
}

/**
 * Affiche un taux.
 *
 * Une valeur `null` s'affiche « — » et non « 0 % » : sur une boutique neuve,
 * annoncer 0 % de livraison serait faux et decourageant.
 */
function RateTile({
  label,
  value,
  hint,
  inverse,
}: {
  label: string;
  value: number | null;
  hint: string;
  inverse?: boolean;
}) {
  const tone =
    value === null
      ? 'text-muted'
      : inverse
        ? value > 20
          ? 'text-danger'
          : value > 10
            ? 'text-warning'
            : 'text-success'
        : value >= 70
          ? 'text-success'
          : value >= 40
            ? 'text-warning'
            : 'text-danger';

  const good = value !== null && (inverse ? value <= 10 : value >= 70);
  const TrendIcon = value === null ? null : good ? TrendingUp : TrendingDown;

  return (
    <div className="card p-3.5">
      <p className="text-xs font-bold text-ink-2">{label}</p>
      {/* Le taux passe par `Numeric` : sans isolation, « 12,5 % » se composait
          « % 12,5 » en arabe, le symbole ayant bascule de l'autre cote du
          nombre. L'icone de tendance, elle, est un element flex : elle se
          place d'elle-meme apres le chiffre dans le sens de lecture. */}
      <p className={`mt-1.5 flex items-center gap-1 text-xl font-extrabold ${tone}`}>
        <Numeric>{formatPercent(value)}</Numeric>
        {TrendIcon ? <TrendIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" /> : null}
      </p>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
