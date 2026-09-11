'use client';

/**
 * Preparation — V1 §10, V2 §13.
 *
 * UNE TABLE, PLUS UN KANBAN
 *   L'ecran montrait trois colonnes : a preparer, en cours, pretes a expedier.
 *   Elles decrivaient la machine a etats, pas le travail. Entre la confirmation
 *   d'une commande et le depart du colis, il n'y a qu'un seul moment de verite
 *   pour l'exploitant : celui ou l'on remet la marchandise au livreur. Les deux
 *   etapes intermediaires se franchissaient sans que rien d'observable ne se
 *   passe entre elles.
 *
 *   `IN_PREPARATION` et `READY_TO_SHIP` existent TOUJOURS dans la machine a
 *   etats, et le dispatch les traverse. Elles cessent seulement d'etre des
 *   ECRANS. C'est ce qui permet a l'historique de rester exact — et a tout
 *   indicateur de duree de preparation de continuer a fonctionner — pendant que
 *   l'interface se simplifie.
 *
 * LE TRANSPORTEUR EST UN PREREQUIS, ET LA TABLE LE MONTRE
 *   Une commande sans transporteur choisi ne peut pas etre dispatchee. La
 *   colonne « Livreur » le dit AVANT le clic, plutot que de laisser
 *   l'exploitant decouvrir dix refus dans un compte-rendu.
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  WILAYAS,
  getWilayaByCode,
  type PreparationBulkAction,
} from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import { GroupTabs } from '@/components/group-tabs';
import {
  RowCheckbox,
  SelectAllCheckbox,
  useRowSelection,
  type BulkArchiveResult,
} from '@/components/bulk-selection';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Money,
  Pagination,
  Select,
  Textarea,
  formatDate,
  useRelativeTime,
} from '@/components/ui';

interface OrderRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly totalCentimes: number;
  readonly orderedAt: string;
  readonly carrierAccount: { id: string; label: string } | null;
  readonly items: readonly { sku: string; productName: string; quantity: number }[];
}

interface Paginated {
  readonly data: OrderRow[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

interface CarrierAccountOption {
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

/**
 * Ce qu'une selection peut declencher.
 *
 * `STEP_BACK` n'y figure pas : il reculait d'une colonne a l'autre dans le
 * kanban, et les colonnes intermediaires ont disparu de l'interface. L'action
 * reste dans l'API — rien ne la supprime — mais elle n'a plus de sens ici.
 */
type TableAction =
  | Extract<PreparationBulkAction, 'RETURN_TO_CONFIRMATION' | 'CANCEL_AND_ARCHIVE'>
  | 'DISPATCH'
  | 'ASSIGN_CARRIER'
  | 'EXPORT';

export default function PreparationPage() {
  const t = useTranslations('preparation');
  const tBulk = useTranslations('preparation.bulk');
  const tCommon = useTranslations('common');
  const relativeTime = useRelativeTime();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [wilayaFilter, setWilayaFilter] = useState('');
  const [search, setSearch] = useState('');
  const [carrierFilter, setCarrierFilter] = useState('');

  const [pendingAction, setPendingAction] = useState<TableAction | null>(null);
  const [reason, setReason] = useState('');
  const [chosenCarrier, setChosenCarrier] = useState('');
  const [result, setResult] = useState<BulkArchiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError, refetch, isFetching } = useQuery({
    queryKey: ['preparation', { page, wilayaFilter, search }],
    queryFn: () =>
      api.get<Paginated>('/orders', {
        query: {
          page,
          pageSize: 25,
          status: 'CONFIRMED',
          wilayaCode: wilayaFilter || undefined,
          search: search.trim() || undefined,
          sortBy: 'orderedAt',
          sortDir: 'asc',
        },
      }),
    // Plusieurs preparateurs travaillent sur la meme file : sans
    // rafraichissement, deux personnes monteraient le meme colis.
    refetchInterval: 45_000,
    placeholderData: (previous) => previous,
  });

  const carriersQuery = useQuery({
    queryKey: ['carrier-accounts'],
    queryFn: () => api.get<CarrierAccountOption[]>('/carrier-accounts'),
  });

  /**
   * Filtre livreur applique ICI, et non cote serveur.
   *
   * `/orders` ne connait pas ce filtre, et l'y ajouter pour un ecran unique
   * elargirait son contrat. La page ne montre que vingt-cinq lignes : filtrer
   * dessus ne coute rien et reste exact — le compteur affiche est celui des
   * lignes visibles, jamais un total qui inclurait ce qu'on vient de masquer.
   */
  const rows = useMemo(() => {
    const all = data?.data ?? [];
    if (!carrierFilter) return all;
    if (carrierFilter === 'none') return all.filter((row) => row.carrierAccount === null);
    return all.filter((row) => row.carrierAccount?.id === carrierFilter);
  }, [data, carrierFilter]);

  const selection = useRowSelection(rows.map((row) => row.id));

  const mutation = useMutation({
    mutationFn: async (action: TableAction): Promise<BulkArchiveResult | null> => {
      const ids = [...selection.selected];

      switch (action) {
        case 'EXPORT':
          // L'export ne change rien : le fichier qui arrive EST le retour.
          await api.download('/orders/export.xlsx', 'ecomflow-preparation.xlsx', { ids });
          return null;

        case 'DISPATCH':
          return api.post<BulkArchiveResult>('/orders/bulk-dispatch', { ids });

        case 'ASSIGN_CARRIER':
          return api.post<BulkArchiveResult>('/orders/bulk-assign-carrier', {
            ids,
            carrierAccountId: chosenCarrier,
          });

        default:
          return api.post<BulkArchiveResult>('/orders/bulk-preparation', {
            ids,
            action,
            reason: reason.trim(),
          });
      }
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      setReason('');
      selection.clear();
      if (data === null) return;
      void queryClient.invalidateQueries({ queryKey: ['preparation'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed'));
    },
  });

  const carriers = (carriersQuery.data ?? []).filter(
    (account) => account.status === 'CONNECTED' || account.status === 'DEGRADED',
  );

  // Combien de lignes cochees n'ont pas de transporteur : le dire AVANT le clic
  // vaut mieux que dix refus dans un compte-rendu.
  const selectedWithoutCarrier = rows.filter(
    (row) => selection.isSelected(row.id) && row.carrierAccount === null,
  ).length;

  const needsReason =
    pendingAction === 'RETURN_TO_CONFIRMATION' || pendingAction === 'CANCEL_AND_ARCHIVE';

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      <GroupTabs />

      {/* --- Filtres, au-dessus de la table et non par colonne -------------- */}
      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label={tCommon('search')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={t('searchPlaceholder')}
          />
          <Select
            label={tCommon('wilaya')}
            value={wilayaFilter}
            onChange={(event) => {
              setWilayaFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{tCommon('all')}</option>
            {WILAYAS.map((wilaya) => (
              <option key={wilaya.code} value={String(wilaya.code)}>
                {wilaya.code2} — {wilaya.name}
              </option>
            ))}
          </Select>
          <Select
            label={t('carrierColumn')}
            value={carrierFilter}
            onChange={(event) => setCarrierFilter(event.target.value)}
          >
            <option value="">{tCommon('all')}</option>
            <option value="none">{t('noCarrier')}</option>
            {carriers.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {result ? (
        <div className="mb-3">
          <Alert
            tone={result.skipped.length > 0 ? 'warning' : 'success'}
            title={tBulk('doneTitle', { count: result.archived })}
            action={
              <button
                className="text-xs font-semibold underline underline-offset-2"
                onClick={() => setResult(null)}
              >
                {tCommon('close')}
              </button>
            }
          >
            {result.skipped.length === 0 ? (
              tBulk('doneAll')
            ) : (
              <ul className="space-y-0.5 text-xs">
                {result.skipped.map((skip) => (
                  <li key={skip.id}>{skip.message}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      {error ? (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      {/* --- Barre d'actions ------------------------------------------------
          Elle reste visible meme sans selection, avec ses boutons desactives :
          une barre qui apparait au premier clic fait sauter la table et cache
          la ligne qu'on vient de cocher. */}
      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-ink">
            {tBulk('selected', { count: selection.count })}
          </span>
          <div className="flex-1" />

          <Button
            size="sm"
            variant="secondary"
            disabled={selection.count === 0 || mutation.isPending}
            onClick={() => setPendingAction('ASSIGN_CARRIER')}
          >
            {tBulk('actions.ASSIGN_CARRIER')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={selection.count === 0 || mutation.isPending}
            onClick={() => setPendingAction('RETURN_TO_CONFIRMATION')}
          >
            {tBulk('actions.RETURN_TO_CONFIRMATION')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={selection.count === 0 || mutation.isPending}
            onClick={() => setPendingAction('CANCEL_AND_ARCHIVE')}
          >
            {tBulk('actions.CANCEL_AND_ARCHIVE')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={selection.count === 0 || mutation.isPending}
            onClick={() => mutation.mutate('EXPORT')}
          >
            {tBulk('actions.EXPORT')}
          </Button>
          <Button
            size="sm"
            loading={mutation.isPending && pendingAction === null}
            disabled={selection.count === 0 || mutation.isPending}
            onClick={() => setPendingAction('DISPATCH')}
          >
            {tBulk('actions.DISPATCH')}
          </Button>
        </div>

        {selection.count > 0 && selectedWithoutCarrier > 0 ? (
          <p className="mt-2 text-xs text-warning">
            {t('missingCarrierWarning', { count: selectedWithoutCarrier })}
          </p>
        ) : null}
      </Card>

      <Card padded={false}>
        {isLoading ? (
          <LoadingState />
        ) : loadError ? (
          <ErrorState
            message={loadError instanceof ApiError ? loadError.userMessage : tCommon('loadFailed')}
            onRetry={() => void refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('empty')} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-8">
                      <SelectAllCheckbox selection={selection} />
                    </th>
                    <th>{t('columns.reference')}</th>
                    <th>{tCommon('customer')}</th>
                    <th>{tCommon('wilaya')}</th>
                    <th>{t('columns.items')}</th>
                    <th className="text-end">{tCommon('total')}</th>
                    <th>{t('carrierColumn')}</th>
                    <th>{t('columns.confirmedAt')}</th>
                  </tr>
                </thead>
                <tbody className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
                  {rows.map((order) => {
                    const wilaya = order.wilayaCode ? getWilayaByCode(order.wilayaCode) : null;

                    return (
                      <tr key={order.id}>
                        <td>
                          <RowCheckbox
                            id={order.id}
                            selection={selection}
                            label={order.reference}
                          />
                        </td>
                        <td>
                          <Link
                            href={`/commandes/${order.id}`}
                            className="font-mono text-xs font-medium text-brand-700 hover:underline"
                          >
                            {order.reference}
                          </Link>
                        </td>
                        <td>
                          <span className="block text-sm text-ink">{order.customerName}</span>
                          <span className="tabular text-xs text-muted">{order.phone}</span>
                        </td>
                        <td className="text-sm text-ink-2">
                          {wilaya ? `${wilaya.code2} ${wilaya.name}` : '—'}
                          {order.commune ? (
                            <span className="block text-xs text-muted">{order.commune}</span>
                          ) : null}
                        </td>
                        {/* Liste de picking : SKU et quantite, pas de prix — le
                            preparateur n'en a pas besoin, et les afficher
                            ralentirait la lecture. */}
                        <td className="text-xs text-ink-2">
                          {order.items.map((item) => (
                            <span key={item.sku} className="block">
                              <span className="tabular font-semibold">{item.quantity}×</span>{' '}
                              <span className="font-mono">{item.sku}</span>
                            </span>
                          ))}
                        </td>
                        <td className="text-end">
                          <Money centimes={order.totalCentimes} />
                        </td>
                        <td>
                          {order.carrierAccount ? (
                            <Badge tone="info">{order.carrierAccount.label}</Badge>
                          ) : (
                            <Badge tone="warning">{t('noCarrier')}</Badge>
                          )}
                        </td>
                        <td className="text-xs text-muted">
                          {formatDate(order.orderedAt)}
                          <span className="block">{relativeTime(order.orderedAt)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {data ? (
              <Pagination
                page={data.meta.page}
                totalPages={data.meta.totalPages}
                total={data.meta.total}
                onChange={setPage}
              />
            ) : null}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={pendingAction !== null}
        danger={pendingAction === 'CANCEL_AND_ARCHIVE'}
        loading={mutation.isPending}
        title={pendingAction ? tBulk(`confirm.${pendingAction}`, { count: selection.count }) : ''}
        message={pendingAction ? tBulk(`confirmBody.${pendingAction}`) : undefined}
        confirmLabel={pendingAction ? tBulk(`actions.${pendingAction}`) : undefined}
        onCancel={() => {
          setPendingAction(null);
          setReason('');
        }}
        onConfirm={() => {
          if (!pendingAction) return;
          if (needsReason && !reason.trim()) return;
          if (pendingAction === 'ASSIGN_CARRIER' && !chosenCarrier) return;
          const action = pendingAction;
          setPendingAction(null);
          mutation.mutate(action);
        }}
      >
        {needsReason ? (
          <Textarea
            label={tCommon('reason')}
            required
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={tBulk('reasonPlaceholder')}
          />
        ) : null}

        {pendingAction === 'ASSIGN_CARRIER' ? (
          <Select
            label={t('carrierColumn')}
            required
            value={chosenCarrier}
            onChange={(event) => setChosenCarrier(event.target.value)}
          >
            <option value="">{tCommon('select')}</option>
            {carriers.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </Select>
        ) : null}

        {pendingAction === 'DISPATCH' && selectedWithoutCarrier > 0 ? (
          <Alert tone="warning">
            {t('missingCarrierWarning', { count: selectedWithoutCarrier })}
          </Alert>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
