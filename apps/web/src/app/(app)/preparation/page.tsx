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
import { getWilayaByCode } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  formatRelative,
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
      api.post(`/orders/${payload.orderId}/status`, { status: payload.status }),
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

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {t(`columns.${column.key}`)}
          {data ? <Badge tone="neutral">{data.meta.total}</Badge> : null}
        </span>
      }
      padded={false}
      footer={<p className="text-xs text-slate-500">{t(`hints.${column.key}`)}</p>}
    >
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
                  <div className="text-end">
                    <StatusBadge status={order.status} />
                    <p className="mt-0.5 text-xs text-slate-400">
                      {formatRelative(order.orderedAt)}
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
