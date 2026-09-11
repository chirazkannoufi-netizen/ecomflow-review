'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ORDER_STATUSES, PERMISSIONS, WILAYAS } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import { useSession } from '@/lib/session';
import {
  BulkActionBar,
  RowCheckbox,
  SelectAllCheckbox,
  useRowSelection,
  type BulkArchiveResult,
} from '@/components/bulk-selection';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Money,
  Pagination,
  Select,
  StatusBadge,
  formatDate,
} from '@/components/ui';

interface OrderRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly totalCentimes: number;
  readonly orderedAt: string;
  readonly assigneeName: string | null;
  readonly items: readonly { sku: string; productName: string; quantity: number }[];
  readonly tracking: { number: string | null; status: string; carrierName: string } | null;
  readonly pendingDuplicateFlags: number;
}

interface Paginated {
  readonly data: OrderRow[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <OrdersContent />
    </Suspense>
  );
}

function OrdersContent() {
  const t = useTranslations('orders');
  const tStatus = useTranslations('orderStatus');
  const tCommon = useTranslations('common');
  const tBulk = useTranslations('bulk');
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canDelete = can(PERMISSIONS.ORDERS_DELETE);

  const [page, setPage] = useState(1);
  // Pre-rempli depuis la barre de recherche globale de la coque applicative
  // (`?recherche=`) : un agent qui tape un nom depuis n'importe quel ecran
  // atterrit directement sur le resultat, sans ressaisir sa requete.
  const [search, setSearch] = useState(searchParams.get('recherche') ?? '');
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get('recherche') ?? '');
  const [status, setStatus] = useState<string>(searchParams.get('status') ?? '');
  const [wilayaCode, setWilayaCode] = useState<string>('');

  // La recherche est temporisee : sans cela, chaque frappe declencherait une
  // requete, et la liste clignoterait a chaque caractere.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [bulkResult, setBulkResult] = useState<BulkArchiveResult | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['orders', { page, debouncedSearch, status, wilayaCode }],
    queryFn: () =>
      api.get<Paginated>('/orders', {
        query: {
          page,
          pageSize: 25,
          search: debouncedSearch || undefined,
          status: status || undefined,
          wilayaCode: wilayaCode || undefined,
        },
      }),
    // Conserve l'affichage precedent pendant le chargement de la page
    // suivante : la liste ne disparait pas sous les yeux de l'utilisateur.
    placeholderData: (previous) => previous,
  });

  const visibleIds = (data?.data ?? []).map((order) => order.id);
  const selection = useRowSelection(visibleIds);

  const bulkArchiveMutation = useMutation({
    mutationFn: (ids: string[]) => api.post<BulkArchiveResult>('/orders/bulk-archive', { ids }),
    onSuccess: (result) => {
      setBulkResult(result);
      setBulkError(null);
      selection.clear();
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (caught) => {
      setBulkError(caught instanceof ApiError ? caught.userMessage : tBulk('failed'));
    },
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <Link href="/commandes/nouvelle">
            <span className="inline-flex h-9 items-center rounded-md bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
              {t('new')}
            </span>
          </Link>
        }
      />

      {/* --- Filtres ------------------------------------------------------- */}
      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              setPage(1);
            }}
          >
            <option value="">{t('allStatuses')}</option>
            {ORDER_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {tStatus(entry)}
              </option>
            ))}
          </Select>

          <Select
            label={tCommon('wilaya')}
            value={wilayaCode}
            onChange={(event) => {
              setWilayaCode(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('allWilayas')}</option>
            {WILAYAS.map((wilaya) => (
              <option key={wilaya.code} value={wilaya.code}>
                {wilaya.code2} — {wilaya.name}
              </option>
            ))}
          </Select>

          <div className="flex items-end">
            {search || status || wilayaCode ? (
              <button
                className="h-9 text-sm text-brand-700 hover:underline"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                  setWilayaCode('');
                  setPage(1);
                }}
              >
                {tCommon('resetFilters')}
              </button>
            ) : null}
          </div>
        </div>
      </Card>

      {/* --- Liste --------------------------------------------------------- */}
      {bulkError ? (
        <div className="mb-3">
          <Alert tone="danger">{bulkError}</Alert>
        </div>
      ) : null}

      {canDelete ? (
        <BulkActionBar
          selection={selection}
          pending={bulkArchiveMutation.isPending}
          result={bulkResult}
          onArchive={() => bulkArchiveMutation.mutate([...selection.selected])}
          onDismissResult={() => setBulkResult(null)}
        />
      ) : null}

      <Card padded={false}>
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState
            message={error instanceof ApiError ? error.userMessage : tCommon('loadFailed')}
            correlationId={error instanceof ApiError ? error.correlationId : undefined}
            onRetry={() => void refetch()}
          />
        ) : !data || data.data.length === 0 ? (
          <EmptyState
            title={t('emptyTitle')}
            description={
              debouncedSearch || status || wilayaCode ? t('emptyFiltered') : t('emptyFirst')
            }
            action={
              !debouncedSearch && !status && !wilayaCode ? (
                <Link href="/integrations">
                  <span className="inline-flex h-9 items-center rounded-md bg-brand-600 px-3.5 text-sm font-medium text-white">
                    {t('connectSheets')}
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
                    {canDelete ? (
                      <th className="w-8">
                        <SelectAllCheckbox selection={selection} />
                      </th>
                    ) : null}
                    <th>{t('columns.reference')}</th>
                    <th>{t('columns.customer')}</th>
                    <th>{t('columns.wilaya')}</th>
                    <th>{t('columns.items')}</th>
                    <th className="text-end">{t('columns.total')}</th>
                    <th>{t('columns.status')}</th>
                    <th>{t('columns.tracking')}</th>
                    <th>{t('columns.date')}</th>
                  </tr>
                </thead>
                <tbody className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
                  {data.data.map((order) => (
                    <tr key={order.id}>
                      {canDelete ? (
                        <td>
                          <RowCheckbox
                            id={order.id}
                            selection={selection}
                            label={order.reference}
                          />
                        </td>
                      ) : null}
                      <td>
                        <Link
                          href={`/commandes/${order.id}`}
                          className="font-mono text-xs font-medium text-brand-700 hover:underline"
                        >
                          {order.reference}
                        </Link>
                        {order.pendingDuplicateFlags > 0 ? (
                          <Badge tone="warning" className="ms-1.5">
                            {t('duplicateBadge')}
                          </Badge>
                        ) : null}
                      </td>
                      <td>
                        <p className="font-medium text-slate-800">{order.customerName}</p>
                        <p className="tabular text-xs text-slate-500">{order.phone}</p>
                      </td>
                      <td className="text-slate-600">
                        {order.wilayaCode ? (
                          <>
                            <span className="tabular">{order.wilayaCode}</span>
                            {order.commune ? (
                              <span className="ms-1 text-xs text-slate-500">{order.commune}</span>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="max-w-[220px]">
                        <p className="truncate text-xs text-slate-600">
                          {order.items
                            .map((item) => `${item.quantity}× ${item.productName}`)
                            .join(', ')}
                        </p>
                      </td>
                      <td className="text-end">
                        <Money centimes={order.totalCentimes} />
                      </td>
                      <td>
                        <StatusBadge status={order.status} />
                      </td>
                      <td>
                        {order.tracking?.number ? (
                          <div>
                            <p className="font-mono text-xs text-slate-700">
                              {order.tracking.number}
                            </p>
                            <p className="text-xs text-slate-500">{order.tracking.carrierName}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatDate(order.orderedAt)}
                      </td>
                    </tr>
                  ))}
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
