'use client';

/**
 * Corbeille — ce qui a ete archive, sur les trois entites.
 *
 * POURQUOI UNE PAGE, ET NON UN FILTRE PAR ECRAN
 *   Archiver est le meme geste partout : retirer des listes sans rien effacer.
 *   Mais ce qui avait ete retire n'etait visible NULLE PART. Une commande
 *   archivee par erreur ne se retrouvait qu'en connaissant sa reference — et un
 *   commercant qui ne la retrouve pas la recree, ce qui produit le doublon que
 *   tout le reste du produit s'emploie a eviter.
 *
 * DEUX BOUTONS QUI NE FONT PAS LA MEME CHOSE, ET QUI LE DISENT
 *   « Supprimer » efface la LIGNE. « Anonymiser » efface les DONNEES
 *   PERSONNELLES d'un client en gardant son historique commercial. Les fondre
 *   sous un seul libelle aurait rendu le geste imprevisible : sur une selection
 *   melangee, le meme clic aurait fait deux choses differentes selon la ligne.
 *
 * « SUPPRIMER » REFUSE SOUVENT, ET CE N'EST PAS UNE PANNE
 *   Les cles etrangeres retiennent tout ce dont un chiffre passe depend. L'ecran
 *   annonce donc le refus AVANT le clic, et le compte-rendu donne le motif de
 *   chaque ligne — dans les termes du metier, pas ceux de PostgreSQL.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/app-shell';
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
  LoadingState,
  Pagination,
  Select,
  Textarea,
  formatDateTime,
} from '@/components/ui';

type ArchivedKind = 'ORDER' | 'PRODUCT' | 'CUSTOMER';

interface ArchivedItem {
  readonly kind: ArchivedKind;
  readonly id: string;
  readonly label: string;
  readonly sublabel: string | null;
  readonly archivedAt: string;
}

interface Paginated {
  readonly data: ArchivedItem[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * Identifiant de SELECTION, prefixe par l'entite.
 *
 * Deux entites peuvent porter le meme UUID — rien ne l'interdit — et la
 * selection doit pouvoir les distinguer. Le prefixe ne quitte jamais le
 * navigateur : l'API recoit trois tableaux separes, pour qu'aucune faute de
 * decoupage ne puisse viser la mauvaise table.
 */
const selectionId = (item: ArchivedItem) => `${item.kind}:${item.id}`;

export default function ArchivePage() {
  const t = useTranslations('archive');
  const tCommon = useTranslations('common');
  const { can } = useSession();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<'' | ArchivedKind>('');
  const [pendingAction, setPendingAction] = useState<'PURGE' | 'ANONYMIZE' | null>(null);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<BulkArchiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canPurge = can(PERMISSIONS.DATA_PURGE);
  const canAnonymize = can(PERMISSIONS.CUSTOMERS_MANAGE) && can(PERMISSIONS.SETTINGS_MANAGE);

  const { data, isLoading, error: loadError, refetch } = useQuery({
    queryKey: ['archive', { page, kind }],
    queryFn: () =>
      api.get<Paginated>('/archive', {
        query: { page, pageSize: 25, kind: kind || undefined },
      }),
    placeholderData: (previous) => previous,
  });

  const rows = data?.data ?? [];
  const selection = useRowSelection(rows.map(selectionId));

  const selected = rows.filter((row) => selection.isSelected(selectionId(row)));
  const selectedCustomers = selected.filter((row) => row.kind === 'CUSTOMER');

  const mutation = useMutation({
    mutationFn: (action: 'PURGE' | 'ANONYMIZE') => {
      if (action === 'ANONYMIZE') {
        return api.post<BulkArchiveResult>('/customers/bulk-anonymize', {
          ids: selectedCustomers.map((row) => row.id),
          reason: reason.trim(),
        });
      }

      // Trois tableaux separes : le prefixe de selection ne quitte pas le
      // navigateur.
      return api.post<BulkArchiveResult>('/archive/purge', {
        orders: selected.filter((row) => row.kind === 'ORDER').map((row) => row.id),
        products: selected.filter((row) => row.kind === 'PRODUCT').map((row) => row.id),
        customers: selectedCustomers.map((row) => row.id),
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      setReason('');
      selection.clear();
      void queryClient.invalidateQueries({ queryKey: ['archive'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed'));
    },
  });

  const toneOf = (entry: ArchivedKind) =>
    entry === 'ORDER' ? 'info' : entry === 'PRODUCT' ? 'neutral' : 'warning';

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      <Card className="mb-3">
        <Select
          label={t('kindFilter')}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as '' | ArchivedKind);
            setPage(1);
          }}
        >
          <option value="">{tCommon('all')}</option>
          <option value="ORDER">{t('kinds.ORDER')}</option>
          <option value="PRODUCT">{t('kinds.PRODUCT')}</option>
          <option value="CUSTOMER">{t('kinds.CUSTOMER')}</option>
        </Select>
      </Card>

      {result ? (
        <div className="mb-3">
          <Alert
            tone={result.skipped.length > 0 ? 'warning' : 'success'}
            title={t('doneTitle', { count: result.archived })}
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
              t('doneAll')
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

      {selection.count > 0 && (canPurge || canAnonymize) ? (
        <Card className="mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">
              {t('selected', { count: selection.count })}
            </span>
            <div className="flex-1" />

            {canAnonymize ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={selectedCustomers.length === 0 || mutation.isPending}
                onClick={() => setPendingAction('ANONYMIZE')}
              >
                {t('anonymize', { count: selectedCustomers.length })}
              </Button>
            ) : null}

            {canPurge ? (
              <Button
                size="sm"
                variant="danger"
                disabled={mutation.isPending}
                onClick={() => setPendingAction('PURGE')}
              >
                {t('purge')}
              </Button>
            ) : null}
          </div>

          {/* Le refus est annonce AVANT le clic : decouvrir dix motifs dans un
              compte-rendu apres coup n'aide personne a decider. */}
          <p className="mt-2 text-xs text-muted">{t('purgeWarning')}</p>
        </Card>
      ) : null}

      <Card padded={false}>
        {isLoading ? (
          <LoadingState />
        ) : loadError ? (
          <ErrorState
            message={loadError instanceof ApiError ? loadError.userMessage : tCommon('loadFailed')}
            onRetry={() => void refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-8">
                      <SelectAllCheckbox selection={selection} />
                    </th>
                    <th>{t('columns.kind')}</th>
                    <th>{t('columns.item')}</th>
                    <th>{t('columns.archivedAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={selectionId(row)}>
                      <td>
                        <RowCheckbox
                          id={selectionId(row)}
                          selection={selection}
                          label={row.label}
                        />
                      </td>
                      <td>
                        <Badge tone={toneOf(row.kind)}>{t(`kinds.${row.kind}`)}</Badge>
                      </td>
                      <td>
                        <span className="block text-sm text-ink">{row.label}</span>
                        {row.sublabel ? (
                          <span className="font-mono text-xs text-muted">{row.sublabel}</span>
                        ) : null}
                      </td>
                      <td className="text-xs text-muted">{formatDateTime(row.archivedAt)}</td>
                    </tr>
                  ))}
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
        danger
        loading={mutation.isPending}
        title={
          pendingAction === 'PURGE'
            ? t('confirmPurge', { count: selection.count })
            : t('confirmAnonymize', { count: selectedCustomers.length })
        }
        message={pendingAction === 'PURGE' ? t('confirmPurgeBody') : t('confirmAnonymizeBody')}
        confirmLabel={pendingAction === 'PURGE' ? t('purge') : t('anonymizeConfirm')}
        onCancel={() => {
          setPendingAction(null);
          setReason('');
        }}
        onConfirm={() => {
          if (!pendingAction) return;
          if (pendingAction === 'ANONYMIZE' && !reason.trim()) return;
          const action = pendingAction;
          setPendingAction(null);
          mutation.mutate(action);
        }}
      >
        {pendingAction === 'ANONYMIZE' ? (
          <Textarea
            label={tCommon('reason')}
            required
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('anonymizeReasonPlaceholder')}
          />
        ) : null}
      </ConfirmDialog>
    </>
  );
}
