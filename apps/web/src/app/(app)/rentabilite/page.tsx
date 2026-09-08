'use client';

/**
 * Pertes et rentabilite — Addendum §33.
 *
 * TROIS NOTIONS QUE LE COMMERCE ALGERIEN CONFOND SOUVENT, ET QU'IL FAUT
 * SEPARER POUR DECIDER :
 *
 *   CHIFFRE D'AFFAIRES RECONNU — uniquement les commandes LIVREES. En paiement
 *     a la livraison, une commande confirmee n'a rien rapporte tant que le
 *     colis n'est pas remis.
 *   PERTE REELLE — de la tresorerie sortie sans contrepartie : le transport
 *     aller-retour d'un colis refuse. C'est de l'argent effectivement perdu.
 *   MANQUE A GAGNER — du chiffre d'affaires qui ne s'est pas fait. Douloureux,
 *     mais ce n'est pas de l'argent sorti de la caisse.
 *
 * Les melanger conduit a des decisions absurdes, par exemple arreter une
 * wilaya rentable parce qu'elle affiche beaucoup d'annulations sans frais.
 *
 * L'HONNETETE DU CALCUL EST AFFICHEE.
 *   `cogsCompleteness` dit quelle part des commandes a un prix d'achat connu.
 *   En dessous de 100 %, la marge est partielle, et l'ecran le dit.
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatCentimes } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Card,
  ErrorState,
  LoadingState,
  Money,
  Select,
  SignedMoney,
  formatPercent,
} from '@/components/ui';

interface Financial {
  readonly recognizedRevenueCentimes: number;
  readonly cogsCentimes: number;
  readonly shippingCostCentimes: number;
  readonly netResultCentimes: number;
  readonly realizedLossCentimes: number;
  readonly opportunityLossCentimes: number;
  readonly netMarginPercent: number | null;
  readonly cogsCompleteness: number;
  readonly averageOrderValueCentimes: number;
}

interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly orders: number;
  readonly delivered: number;
  readonly failed: number;
  readonly failureRate: number;
  readonly realizedLossCentimes: number;
  readonly recognizedRevenueCentimes: number;
}

/** Les libelles et les questions vivent dans le catalogue de traduction. */
const DIMENSIONS = ['wilaya', 'carrier', 'product', 'agent', 'source'] as const;

const PERIODS = [7, 30, 90, 365] as const;

export default function ProfitabilityPage() {
  const t = useTranslations('profitability');
  const tCommon = useTranslations('common');
  const tDash = useTranslations('dashboard');
  const [days, setDays] = useState<number>(30);
  const [dimension, setDimension] = useState<string>('wilaya');

  const from = new Date(Date.now() - days * 86_400_000).toISOString();

  const financialQuery = useQuery({
    queryKey: ['reports', 'profitability', days],
    queryFn: () => api.get<Financial>('/reports/profitability', { query: { from } }),
  });

  const breakdownQuery = useQuery({
    queryKey: ['reports', 'losses', days, dimension],
    queryFn: () => api.get<BreakdownRow[]>('/reports/losses', { query: { from, dimension } }),
  });

  if (financialQuery.isLoading) return <LoadingState />;

  if (financialQuery.error) {
    return (
      <ErrorState
        message={
          financialQuery.error instanceof ApiError
            ? financialQuery.error.userMessage
            : tCommon('loadFailed')
        }
        onRetry={() => void financialQuery.refetch()}
      />
    );
  }

  const financial = financialQuery.data;
  if (!financial) return null;

  const rows = breakdownQuery.data ?? [];
  const maxLoss = Math.max(1, ...rows.map((row) => row.realizedLossCentimes));

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
                {tDash(`periods.${period}`)}
              </button>
            ))}
          </div>
        }
      />

      {financial.cogsCompleteness < 1 ? (
        <div className="mb-3">
          <Alert
            tone="warning"
            title={t('partialTitle')}
            action={
              <Link href="/produits">
                <span className="text-sm font-medium underline">{t('completeCatalog')}</span>
              </Link>
            }
          >
            {t('partial', { percent: Math.round(financial.cogsCompleteness * 100) })}
          </Alert>
        </div>
      ) : null}

      {/* --- Compte de resultat simplifie ----------------------------------- */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title={t('resultTitle')} className="lg:col-span-2">
          <dl className="space-y-2 text-sm">
            <LineItem
              label={t('revenue')}
              hint={t('revenueHint')}
            >
              <Money centimes={financial.recognizedRevenueCentimes} bold />
            </LineItem>
            <LineItem label={t('cogs')} hint={t('cogsHint')}>
              <span className="tabular text-danger">
                − {formatCentimes(financial.cogsCentimes)}
              </span>
            </LineItem>
            <LineItem
              label={t('shipping')}
              hint={t('shippingHint')}
            >
              <span className="tabular text-danger">
                − {formatCentimes(financial.shippingCostCentimes)}
              </span>
            </LineItem>

            <div className="border-t-2 border-slate-300 pt-2">
              <LineItem label={t('netResult')} hint={t('netResultHint')}>
                <SignedMoney centimes={financial.netResultCentimes} />
              </LineItem>
            </div>

            <LineItem label={t('netMargin')} hint={t('netMarginHint')}>
              <span
                className={
                  financial.netMarginPercent === null
                    ? 'tabular text-slate-400'
                    : financial.netMarginPercent >= 15
                      ? 'tabular font-semibold text-success'
                      : financial.netMarginPercent >= 0
                        ? 'tabular font-semibold text-warning'
                        : 'tabular font-semibold text-danger'
                }
              >
                {formatPercent(financial.netMarginPercent)}
              </span>
            </LineItem>

            <LineItem label={t('averageOrder')}>
              <Money centimes={financial.averageOrderValueCentimes} />
            </LineItem>
          </dl>
        </Card>

        <div className="space-y-4">
          <Card title={t('realizedLoss')}>
            <p className="tabular text-2xl font-bold text-danger">
              {formatCentimes(financial.realizedLossCentimes)}
            </p>
            <p className="mt-1 text-xs text-slate-600">{t('realizedLossHint')}</p>
          </Card>

          <Card title={t('opportunityLoss')}>
            <p className="tabular text-2xl font-bold text-warning">
              {formatCentimes(financial.opportunityLossCentimes)}
            </p>
            <p className="mt-1 text-xs text-slate-600">{t('opportunityLossHint')}</p>
          </Card>
        </div>
      </div>

      {/* --- Ventilation ---------------------------------------------------- */}
      <Card
        title={t('breakdownTitle')}
        action={
          <div className="sm:w-56">
            <Select value={dimension} onChange={(event) => setDimension(event.target.value)}>
              {DIMENSIONS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`dimensions.${entry}`)}
                </option>
              ))}
            </Select>
          </div>
        }
        padded={false}
        footer={
          <p className="text-xs text-slate-500">{t(`questions.${dimension}`)}</p>
        }
      >
        {breakdownQuery.isLoading ? (
          <LoadingState />
        ) : breakdownQuery.error ? (
          <ErrorState
            message={
              breakdownQuery.error instanceof ApiError
                ? breakdownQuery.error.userMessage
                : tCommon('loadFailed')
            }
            onRetry={() => void breakdownQuery.refetch()}
          />
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-500">{t('noData')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t(`dimensions.${dimension}`)}</th>
                  <th className="text-end">{t('columns.orders')}</th>
                  <th className="text-end">{t('columns.delivered')}</th>
                  <th className="text-end">{t('columns.failures')}</th>
                  <th className="text-end">{t('columns.failureRate')}</th>
                  <th className="text-end">{t('columns.revenue')}</th>
                  <th className="text-end">{t('columns.loss')}</th>
                  <th className="w-32" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="font-medium text-slate-800">{row.label}</td>
                    <td className="tabular text-end">{row.orders}</td>
                    <td className="tabular text-end text-success">{row.delivered}</td>
                    <td className="tabular text-end text-danger">{row.failed}</td>
                    <td className="text-end">
                      <span
                        className={
                          row.failureRate > 30
                            ? 'tabular font-semibold text-danger'
                            : row.failureRate > 15
                              ? 'tabular text-warning'
                              : 'tabular text-slate-600'
                        }
                      >
                        {formatPercent(row.failureRate)}
                      </span>
                    </td>
                    <td className="text-end">
                      <Money centimes={row.recognizedRevenueCentimes} />
                    </td>
                    <td className="text-end">
                      <span className="tabular text-danger">
                        {formatCentimes(row.realizedLossCentimes)}
                      </span>
                    </td>
                    <td>
                      {/* Barre de perte relative : rend la hierarchie lisible
                          d'un coup d'oeil, sans lire chaque montant. */}
                      <div className="h-2 w-full rounded-full bg-slate-100">
                        <div
                          className="h-2 rounded-full bg-danger/50"
                          style={{
                            width: `${Math.round((row.realizedLossCentimes / maxLoss) * 100)}%`,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function LineItem({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt>
        <span className="text-slate-700">{label}</span>
        {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
      </dt>
      <dd className="whitespace-nowrap">{children}</dd>
    </div>
  );
}
