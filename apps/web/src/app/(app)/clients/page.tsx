'use client';

/**
 * Clients — V2 §12, Addendum §32.
 *
 * Le score de fiabilite est le coeur de cet ecran. Il n'est jamais affiche seul
 * comme un verdict : la fiche detaillee explique ses facteurs. Ici, la liste
 * permet de filtrer par palier pour repondre a la seule question qui compte au
 * quotidien — « a qui puis-je expedier sans arriere-pensee ? »
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PERMISSIONS, RELIABILITY_TIERS } from '@ecomflow/shared';
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
  Pagination,
  ReliabilityBadge,
  Select,
  formatDate,
} from '@/components/ui';

interface CustomerRow {
  readonly id: string;
  readonly fullName: string;
  readonly phoneE164: string;
  readonly ordersCount: number;
  readonly deliveredCount: number;
  readonly refusedCount: number;
  readonly returnedCount: number;
  readonly cancelledCount: number;
  readonly reliabilityScore: number | null;
  readonly reliabilityTier: string;
  readonly lastOrderAt: string | null;
  readonly tags: readonly string[];
}

interface Paginated {
  readonly data: CustomerRow[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export default function CustomersPage() {
  const t = useTranslations('customers');
  const tTier = useTranslations('reliability');
  const tBulk = useTranslations('bulk');
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canManage = can(PERMISSIONS.CUSTOMERS_MANAGE);
  const [bulkResult, setBulkResult] = useState<BulkArchiveResult | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tier, setTier] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', { page, debounced, tier }],
    queryFn: () =>
      api.get<Paginated>('/customers', {
        query: {
          page,
          pageSize: 25,
          search: debounced || undefined,
          reliabilityTier: tier || undefined,
        },
      }),
    placeholderData: (previous) => previous,
  });

  const visibleIds = (data?.data ?? []).map((customer) => customer.id);
  const selection = useRowSelection(visibleIds);

  const bulkArchiveMutation = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkArchiveResult>('/customers/bulk-archive', { ids }),
    onSuccess: (result) => {
      setBulkResult(result);
      setBulkError(null);
      selection.clear();
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
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
      />

      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label={t('columns.customer')}
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label={t('reliabilityFilter')}
            value={tier}
            onChange={(event) => {
              setTier(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('allCustomers')}</option>
            {RELIABILITY_TIERS.map((entry) => (
              <option key={entry} value={entry}>
                {tTier(entry)}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {bulkError ? (
        <div className="mb-3">
          <Alert tone="danger">{bulkError}</Alert>
        </div>
      ) : null}

      {canManage ? (
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
            message={error instanceof ApiError ? error.userMessage : t('loadFailedFallback')}
            onRetry={() => void refetch()}
          />
        ) : !data || data.data.length === 0 ? (
          <EmptyState
            title={t('emptyTitle')}
            description={debounced || tier ? t('emptyFiltered') : t('emptyFirst')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    {canManage ? (
                      <th className="w-8">
                        <SelectAllCheckbox selection={selection} />
                      </th>
                    ) : null}
                    <th>{t('columns.customer')}</th>
                    <th>{t('columns.phone')}</th>
                    <th>{t('columns.reliability')}</th>
                    <th className="text-end">{t('columns.orders')}</th>
                    <th className="text-end">{t('columns.delivered')}</th>
                    <th className="text-end">{t('columns.failures')}</th>
                    <th>{t('columns.lastOrder')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((customer) => (
                    <tr key={customer.id}>
                      {canManage ? (
                        <td>
                          <RowCheckbox
                            id={customer.id}
                            selection={selection}
                            label={customer.fullName}
                          />
                        </td>
                      ) : null}
                      <td>
                        <Link
                          href={`/clients/${customer.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {customer.fullName}
                        </Link>
                        {customer.tags.length > 0 ? (
                          <span className="ms-1.5">
                            {customer.tags.slice(0, 2).map((tag) => (
                              <Badge key={tag} tone="neutral" className="me-1">
                                {tag}
                              </Badge>
                            ))}
                          </span>
                        ) : null}
                      </td>
                      <td className="tabular text-slate-600">{customer.phoneE164}</td>
                      <td>
                        <ReliabilityBadge
                          tier={customer.reliabilityTier}
                          score={customer.reliabilityScore}
                        />
                      </td>
                      <td className="tabular text-end">{customer.ordersCount}</td>
                      <td className="tabular text-end text-success">
                        {customer.deliveredCount}
                      </td>
                      <td className="tabular text-end text-danger">
                        {customer.refusedCount + customer.returnedCount}
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatDate(customer.lastOrderAt)}
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
