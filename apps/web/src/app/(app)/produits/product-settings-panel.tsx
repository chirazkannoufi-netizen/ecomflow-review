'use client';

/**
 * Reglages de vente d'un produit — troisieme niveau de divulgation.
 *
 * POURQUOI UN TROISIEME NIVEAU
 *   La table montre ce qu'on regarde tous les jours : nom, prix, marge, stock.
 *   L'ouverture d'une ligne montre ses declinaisons. Ces reglages-ci se
 *   touchent une fois, quand on cree le produit ou quand quelque chose a mal
 *   tourne — les afficher au meme rang que le prix de vente ferait payer a
 *   chaque consultation le cout d'un reglage annuel.
 *
 *   Ils restent pourtant a UN clic de la fiche, et non dans un ecran de
 *   parametres separe : « pourquoi cette commande a-t-elle ete refusee ? » se
 *   pose devant le produit, pas devant un menu.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OUT_OF_STOCK_BEHAVIORS,
  STOCK_EXIT_STRATEGIES,
  type OutOfStockBehavior,
  type StockExitStrategy,
} from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Input, Money, Select, Textarea } from '@/components/ui';

interface CrossSell {
  readonly productId: string;
  readonly name: string;
  readonly sku: string;
  readonly salePriceCentimes: number;
  readonly isActive: boolean;
}

interface PanelProps {
  readonly product: {
    readonly id: string;
    readonly confirmationNotes: string | null;
    readonly variants: readonly {
      readonly id: string;
      readonly sku: string;
      readonly label: string | null;
      readonly outOfStockBehavior: OutOfStockBehavior;
      readonly stockExitStrategy: StockExitStrategy;
    }[];
  };
  readonly canManage: boolean;
}

export function ProductSettingsPanel({ product, canManage }: PanelProps) {
  const t = useTranslations('products.settings');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(product.confirmationNotes ?? '');
  const [sku, setSku] = useState('');
  const [error, setError] = useState<string | null>(null);

  // La liste peut etre rechargee sous nos pieds (pagination, recherche) :
  // le brouillon suit alors la valeur enregistree plutot que de garder une
  // saisie qui ne concerne plus le produit affiche.
  useEffect(() => {
    setNotes(product.confirmationNotes ?? '');
  }, [product.id, product.confirmationNotes]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const notesMutation = useMutation({
    mutationFn: (value: string) =>
      api.patch(`/products/${product.id}`, { confirmationNotes: value }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.userMessage : t('saveFailed')),
  });

  const stockMutation = useMutation({
    mutationFn: (input: {
      variantId: string;
      changes: Partial<{ outOfStockBehavior: OutOfStockBehavior; stockExitStrategy: StockExitStrategy }>;
    }) =>
      api.patch(
        `/products/${product.id}/variants/${input.variantId}/stock-settings`,
        input.changes,
      ),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.userMessage : t('saveFailed')),
  });

  const { data: crossSells } = useQuery({
    queryKey: ['cross-sells', product.id],
    queryFn: () => api.get<CrossSell[]>(`/products/${product.id}/cross-sells`),
    // Inutile de charger les ventes additionnelles de chaque ligne du tableau :
    // seule celle qu'on a ouverte nous interesse.
    enabled: open,
  });

  const addMutation = useMutation({
    mutationFn: (value: string) => api.post(`/products/${product.id}/cross-sells`, { sku: value }),
    onSuccess: () => {
      setSku('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['cross-sells', product.id] });
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.userMessage : t('addFailed')),
  });

  const removeMutation = useMutation({
    mutationFn: (crossSellProductId: string) =>
      api.delete(`/products/${product.id}/cross-sells/${crossSellProductId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cross-sells', product.id] });
    },
  });

  const submitCrossSell = (event: FormEvent) => {
    event.preventDefault();
    if (sku.trim()) addMutation.mutate(sku.trim());
  };

  const notesChanged = notes !== (product.confirmationNotes ?? '');

  if (!open) {
    return (
      <button
        className="text-xs text-slate-500 underline-offset-2 hover:text-brand-700 hover:underline"
        onClick={() => setOpen(true)}
      >
        {t('open')}
      </button>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-line bg-white p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-slate-800">{t('title')}</h4>
        <button
          className="text-xs text-slate-500 hover:text-slate-800"
          onClick={() => setOpen(false)}
        >
          {tCommon('close')}
        </button>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {/* --- Consignes de confirmation ------------------------------------ */}
      <section className="space-y-2">
        <Textarea
          label={t('confirmationNotes')}
          hint={t('confirmationNotesHint')}
          rows={2}
          value={notes}
          disabled={!canManage}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={t('confirmationNotesPlaceholder')}
        />
        {canManage && notesChanged ? (
          <div className="flex gap-2">
            <Button size="sm" loading={notesMutation.isPending} onClick={() => notesMutation.mutate(notes)}>
              {tCommon('save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setNotes(product.confirmationNotes ?? '')}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        ) : null}
      </section>

      {/* --- Comportement de stock, par declinaison ------------------------ */}
      <section className="space-y-2">
        <h5 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {t('stockBehavior')}
        </h5>
        <p className="text-xs text-slate-500">{t('stockBehaviorHint')}</p>

        <div className="space-y-2">
          {product.variants.map((variant) => (
            <div key={variant.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr] sm:items-end">
              <div className="text-xs text-slate-600">
                <span className="block font-medium text-slate-800">
                  {variant.label ?? t('standardVariant')}
                </span>
                <span className="font-mono text-slate-500">{variant.sku}</span>
              </div>

              <Select
                label={t('outOfStock')}
                value={variant.outOfStockBehavior}
                disabled={!canManage || stockMutation.isPending}
                onChange={(event) =>
                  stockMutation.mutate({
                    variantId: variant.id,
                    changes: { outOfStockBehavior: event.target.value as OutOfStockBehavior },
                  })
                }
              >
                {OUT_OF_STOCK_BEHAVIORS.map((value) => (
                  <option key={value} value={value}>
                    {t(`outOfStockOptions.${value}`)}
                  </option>
                ))}
              </Select>

              <Select
                label={t('exitStrategy')}
                value={variant.stockExitStrategy}
                disabled={!canManage || stockMutation.isPending}
                onChange={(event) =>
                  stockMutation.mutate({
                    variantId: variant.id,
                    changes: { stockExitStrategy: event.target.value as StockExitStrategy },
                  })
                }
              >
                {STOCK_EXIT_STRATEGIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`exitStrategyOptions.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      </section>

      {/* --- Ventes additionnelles ---------------------------------------- */}
      <section className="space-y-2">
        <h5 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {t('crossSells')}
        </h5>
        <p className="text-xs text-slate-500">{t('crossSellsHint')}</p>

        {crossSells && crossSells.length > 0 ? (
          <ul className="divide-y divide-line rounded-md border border-line">
            {crossSells.map((item) => (
              <li key={item.productId} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                <span className="flex-1 text-slate-800">{item.name}</span>
                <span className="font-mono text-xs text-slate-500">{item.sku}</span>
                {!item.isActive ? <Badge tone="neutral">{t('inactive')}</Badge> : null}
                <Money centimes={item.salePriceCentimes} />
                {canManage ? (
                  <button
                    className="text-xs text-slate-400 hover:text-danger"
                    onClick={() => removeMutation.mutate(item.productId)}
                  >
                    {tCommon('remove')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-400">{t('crossSellsEmpty')}</p>
        )}

        {canManage ? (
          <form onSubmit={submitCrossSell} className="flex items-end gap-2">
            <Input
              label={t('addBySku')}
              value={sku}
              onChange={(event) => setSku(event.target.value)}
              placeholder="HOU-001"
              className="max-w-48"
            />
            <Button type="submit" size="sm" loading={addMutation.isPending}>
              {tCommon('add')}
            </Button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
