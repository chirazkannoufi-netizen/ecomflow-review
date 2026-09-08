'use client';

/**
 * Catalogue produits — V1 §7, V2 §9.
 *
 * Le catalogue existe pour deux raisons operationnelles : reserver du stock a
 * la confirmation, et connaitre le prix d'achat pour calculer la marge reelle.
 * Le formulaire insiste donc sur le prix d'achat, meme facultatif : sans lui,
 * la rentabilite affichee ailleurs dans le produit reste incomplete, et la
 * table le signale explicitement plutot que d'afficher une marge fausse.
 */

import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, dinarsToCentimes, formatCentimes } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
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
  Textarea,
} from '@/components/ui';

interface Variant {
  readonly id: string;
  readonly sku: string;
  readonly label: string | null;
  readonly attributes: Record<string, string>;
  readonly salePriceCentimes: number;
  readonly isActive: boolean;
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
}

interface Product {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly salePriceCentimes: number;
  readonly purchasePriceCentimes: number | null;
  readonly isActive: boolean;
  readonly imageUrls: readonly string[];
  readonly categoryName: string | null;
  readonly variants: readonly Variant[];
  readonly totalAvailable: number;
}

interface Paginated {
  readonly data: Product[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

const EMPTY_FORM = {
  name: '',
  sku: '',
  categoryName: '',
  description: '',
  salePrice: '',
  purchasePrice: '',
  initialStock: '0',
};

export default function ProductsPage() {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const { can } = useSession();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['products', { page, debounced }],
    queryFn: () =>
      api.get<Paginated>('/products', {
        query: { page, pageSize: 20, search: debounced || undefined },
      }),
    placeholderData: (previous) => previous,
  });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post('/products', payload),
    onSuccess: () => {
      setShowForm(false);
      setForm(EMPTY_FORM);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (caught) => {
      setFormError(caught instanceof ApiError ? caught.userMessage : t('createFailed'));
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/products/${id}/archive`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['products'] }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    // Les montants sont saisis en dinars ; l'API ne parle qu'en centimes.
    const salePriceCentimes = dinarsToCentimes(form.salePrice);
    if (salePriceCentimes === null || salePriceCentimes < 0) {
      setFormError(t('invalidSalePrice'));
      return;
    }

    let purchaseCentimes: number | undefined;
    if (form.purchasePrice.trim()) {
      const parsed = dinarsToCentimes(form.purchasePrice);
      if (parsed === null || parsed < 0) {
        setFormError(t('invalidPurchasePrice'));
        return;
      }
      purchaseCentimes = parsed;
    }

    createMutation.mutate({
      name: form.name,
      sku: form.sku,
      categoryName: form.categoryName.trim() || undefined,
      description: form.description.trim() || undefined,
      salePriceCentimes,
      purchasePriceCentimes: purchaseCentimes,
      initialStock: Number(form.initialStock) || 0,
    });
  }

  const canManage = can(PERMISSIONS.PRODUCTS_MANAGE);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          canManage ? (
            <Button onClick={() => setShowForm((value) => !value)} size="sm">
              {showForm ? tCommon('close') : t('new')}
            </Button>
          ) : null
        }
      />

      {showForm ? (
        <Card title={t('formTitle')} className="mb-3">
          <form onSubmit={submit} className="space-y-3">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={t('name')}
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder={t('namePlaceholder')}
              />
              <Input
                label={t('sku')}
                required
                value={form.sku}
                onChange={(event) => setForm({ ...form, sku: event.target.value })}
                placeholder="ROB-001"
                hint={t('skuHint')}
              />
              <Input
                label={t('salePrice')}
                required
                inputMode="decimal"
                value={form.salePrice}
                onChange={(event) => setForm({ ...form, salePrice: event.target.value })}
                placeholder="4500"
              />
              <Input
                label={t('purchasePrice')}
                inputMode="decimal"
                value={form.purchasePrice}
                onChange={(event) => setForm({ ...form, purchasePrice: event.target.value })}
                placeholder="2500"
                hint={t('purchasePriceHint')}
              />
              <Input
                label={t('category')}
                value={form.categoryName}
                onChange={(event) => setForm({ ...form, categoryName: event.target.value })}
                placeholder={t('categoryPlaceholder')}
              />
              <Input
                label={t('initialStock')}
                type="number"
                min={0}
                value={form.initialStock}
                onChange={(event) => setForm({ ...form, initialStock: event.target.value })}
              />
            </div>

            <Textarea
              label={t('description')}
              rows={2}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />

            <div className="flex gap-2">
              <Button type="submit" loading={createMutation.isPending}>
                {t('create')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                {tCommon('cancel')}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card className="mb-3">
        <Input
          label={tCommon('search')}
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
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
            description={debounced ? t('emptyFiltered') : t('emptyFirst')}
            action={
              canManage && !debounced ? (
                <Button onClick={() => setShowForm(true)}>{t('createFirst')}</Button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('columns.product')}</th>
                    <th>{t('columns.sku')}</th>
                    <th>{t('columns.category')}</th>
                    <th className="text-end">{t('columns.salePrice')}</th>
                    <th className="text-end">{t('columns.purchasePrice')}</th>
                    <th className="text-end">{t('columns.margin')}</th>
                    <th className="text-end">{t('columns.available')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((product) => {
                    const margin =
                      product.purchasePriceCentimes === null
                        ? null
                        : product.salePriceCentimes - product.purchasePriceCentimes;

                    return (
                      <Fragment key={product.id}>
                        <tr>
                          <td>
                            <button
                              className="text-start font-medium text-slate-800 hover:text-brand-700"
                              onClick={() =>
                                setExpanded(expanded === product.id ? null : product.id)
                              }
                            >
                              {product.name}
                            </button>
                            {!product.isActive ? (
                              <Badge tone="neutral" className="ms-1.5">
                                {t('inactive')}
                              </Badge>
                            ) : null}
                            {product.variants.length > 1 ? (
                              <span className="ms-1.5 text-xs text-slate-400">
                                {t('variantCount', { count: product.variants.length })}
                              </span>
                            ) : null}
                          </td>
                          <td className="font-mono text-xs text-slate-600">{product.sku}</td>
                          <td className="text-slate-600">
                            {product.categoryName ?? tCommon('none')}
                          </td>
                          <td className="text-end">
                            <Money centimes={product.salePriceCentimes} />
                          </td>
                          <td className="text-end">
                            {product.purchasePriceCentimes === null ? (
                              <span
                                className="text-xs text-warning"
                                title={t('noPurchasePriceTooltip')}
                              >
                                {t('noPurchasePrice')}
                              </span>
                            ) : (
                              <Money centimes={product.purchasePriceCentimes} />
                            )}
                          </td>
                          <td className="text-end">
                            {margin === null ? (
                              <span className="text-slate-400">{tCommon('none')}</span>
                            ) : (
                              <span
                                className={
                                  margin >= 0
                                    ? 'tabular text-success'
                                    : 'tabular font-medium text-danger'
                                }
                              >
                                {formatCentimes(margin)}
                              </span>
                            )}
                          </td>
                          <td className="tabular text-end">
                            <span
                              className={
                                product.totalAvailable <= 0
                                  ? 'font-medium text-danger'
                                  : 'text-slate-800'
                              }
                            >
                              {product.totalAvailable}
                            </span>
                          </td>
                          <td className="text-end">
                            {canManage && product.isActive ? (
                              <button
                                className="text-xs text-slate-500 hover:text-danger"
                                onClick={() => archiveMutation.mutate(product.id)}
                              >
                                {t('archive')}
                              </button>
                            ) : null}
                          </td>
                        </tr>

                        {expanded === product.id
                          ? product.variants.map((variant) => (
                              <tr key={variant.id} className="bg-slate-50/60">
                                <td className="ps-8 text-sm text-slate-600">
                                  {variant.label ?? t('standardVariant')}
                                </td>
                                <td className="font-mono text-xs text-slate-500">{variant.sku}</td>
                                <td colSpan={2} className="text-xs text-slate-500">
                                  {Object.entries(variant.attributes)
                                    .map(([key, value]) => `${key} : ${value}`)
                                    .join(' · ') || tCommon('none')}
                                </td>
                                <td className="text-end">
                                  <Money centimes={variant.salePriceCentimes} />
                                </td>
                                <td />
                                <td className="tabular text-end text-sm">
                                  {variant.available}
                                  <span className="ms-1 text-xs text-slate-400">
                                    {t('reservedShort', {
                                      onHand: variant.onHand,
                                      reserved: variant.reserved,
                                    })}
                                  </span>
                                </td>
                                <td />
                              </tr>
                            ))
                          : null}
                      </Fragment>
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
