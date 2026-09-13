'use client';

/**
 * File de livraison — le corps commun de « En livraison » et « Livre ».
 *
 * DEUX ECRANS, UN SEUL COMPOSANT
 *   Les deux repondent a la meme question — « ou en est ce qui est parti ? » —
 *   a deux moments du trajet. Meme table, memes filtres, meme export. Les
 *   ecrire deux fois ferait diverger les details qui comptent : le compte des
 *   tentatives, la lecture de l'encaissement, la borne de selection.
 *
 *   Ce qui differe tient en trois choses, passees en parametre : l'etape, la
 *   date de reference affichee, et l'affichage ou non de l'encaissement.
 *
 * POURQUOI CE N'EST PAS UN FILTRE DE `/expeditions`
 *   `/expeditions` repond a « qu'est-ce qui est parti ? » — une question de
 *   COLIS, tournee vers le transporteur, et qui expose le suivi brut. Ces deux
 *   ecrans-ci repondent a « ou en est ma commande ? » et « ai-je ete paye ? » :
 *   deux questions de COMMANDE, tournees vers le client et vers la caisse.
 *
 * L'ENCAISSEMENT SE LIT EN QUATRE ETATS, JAMAIS EN DEUX
 *   Un montant absent ne veut pas dire « impaye ». Il peut vouloir dire « ce
 *   transporteur ne publie pas cette donnee » — et confondre les deux ferait
 *   lire une creance la ou il n'y a qu'une ignorance. Les quatre etats ont donc
 *   quatre traitements visuels distincts, et celui qui compte le plus est
 *   `UNSUPPORTED` : il doit se lire comme un silence du transporteur, jamais
 *   comme une dette.
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { WILAYAS, getWilayaByCode } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import { GroupTabs } from '@/components/group-tabs';
import { RowCheckbox, SelectAllCheckbox, useRowSelection } from '@/components/bulk-selection';
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
  Select,
  formatDate,
  useRelativeTime,
} from '@/components/ui';

/**
 * Etat d'encaissement, tel que le serveur le resout en croisant le colis et la
 * matrice de capacites du transporteur (D-049).
 */
export type CollectionState =
  | { readonly kind: 'COLLECTED'; readonly amountCentimes: number; readonly collectedAt: string; readonly reference: string | null }
  | { readonly kind: 'PENDING' }
  | { readonly kind: 'UNSUPPORTED' }
  | { readonly kind: 'UNKNOWN' };

interface DeliveryRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly totalCentimes: number;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
  readonly providerStatus: string | null;
  readonly failedAttempts: number;
  readonly lastAttemptAt: string | null;
  readonly collection: CollectionState;
}

interface Paginated {
  readonly data: DeliveryRow[];
  readonly meta: { page: number; pageSize: number; total: number; totalPages: number };
}

interface CarrierAccountOption {
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

export type DeliveryStage = 'IN_DELIVERY' | 'DELIVERED';

/**
 * Au-dela de ce nombre de tentatives, la ligne est signalee : ce n'est plus un
 * alea de tournee, c'est un dossier a reprendre au telephone.
 */
const ATTEMPTS_ALERT_THRESHOLD = 2;

export function DeliveryQueue({ stage }: { stage: DeliveryStage }) {
  const t = useTranslations('delivery');
  const tCommon = useTranslations('common');
  const relativeTime = useRelativeTime();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [wilayaCode, setWilayaCode] = useState('');
  const [carrierAccountId, setCarrierAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['delivery-queue', { stage, page, debounced, wilayaCode, carrierAccountId, from, to }],
    queryFn: () =>
      api.get<Paginated>('/delivery-queue', {
        query: {
          stage,
          page,
          pageSize: 25,
          search: debounced || undefined,
          wilayaCode: wilayaCode || undefined,
          carrierAccountId: carrierAccountId || undefined,
          from: from || undefined,
          // Borne HAUTE incluse : une date de fin saisie « 30 septembre » doit
          // comprendre le 30 septembre entier, pas s'arreter a son premier
          // instant. Sans cela, le dernier jour d'un mois disparait du filtre.
          to: to ? `${to}T23:59:59.999` : undefined,
        },
      }),
    placeholderData: (previous) => previous,
  });

  const carriersQuery = useQuery({
    queryKey: ['carrier-accounts'],
    queryFn: () => api.get<CarrierAccountOption[]>('/carrier-accounts'),
  });

  const rows = useMemo(() => data?.data ?? [], [data]);
  const selection = useRowSelection(rows.map((row) => row.id));

  const hasFilters = Boolean(debounced || wilayaCode || carrierAccountId || from || to);

  /**
   * L'export REUTILISE le pipeline des commandes.
   *
   * Ces lignes SONT des commandes : leur donner un second generateur de
   * classeur ferait deux fichiers aux colonnes divergentes pour la meme
   * entite, et l'exploitant qui rapproche deux exports ne saurait plus lequel
   * fait foi.
   */
  async function exportSelection() {
    setExportError(null);
    setIsExporting(true);
    try {
      await api.download(
        '/orders/export.xlsx',
        stage === 'DELIVERED' ? 'ecomflow-livrees.xlsx' : 'ecomflow-en-livraison.xlsx',
        { ids: [...selection.selected] },
      );
    } catch (caught) {
      setExportError(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed'));
    } finally {
      setIsExporting(false);
    }
  }

  const carriers = (carriersQuery.data ?? []).filter(
    (account) => account.status === 'CONNECTED' || account.status === 'DEGRADED',
  );

  return (
    <>
      <PageHeader title={t(`${stage}.title`)} description={t(`${stage}.subtitle`)} />

      <GroupTabs />

      {/* --- Filtres ------------------------------------------------------- */}
      <Card className="mb-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            label={tCommon('search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('searchPlaceholder')}
          />
          <Select
            label={tCommon('wilaya')}
            value={wilayaCode}
            onChange={(event) => {
              setWilayaCode(event.target.value);
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
            value={carrierAccountId}
            onChange={(event) => {
              setCarrierAccountId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{tCommon('all')}</option>
            {carriers.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </Select>
          {/* La periode porte sur la date de l'ETAPE — depart du colis ici,
              livraison la-bas — et le libelle le dit, sans quoi « du / au »
              laisserait deviner de quelle date il s'agit. */}
          <Input
            type="date"
            label={t(`${stage}.fromLabel`)}
            value={from}
            max={to || undefined}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
          <Input
            type="date"
            label={t(`${stage}.toLabel`)}
            value={to}
            min={from || undefined}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </Card>

      {exportError ? (
        <div className="mb-3">
          <Alert tone="danger">{exportError}</Alert>
        </div>
      ) : null}

      {/* --- Barre d'action -------------------------------------------------
          Visible en permanence, bouton desactive tant que rien n'est coche :
          une barre qui apparait au premier clic fait sauter la table sous le
          curseur. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <span className="text-sm text-ink-2">
          {selection.count === 0 ? t('noSelection') : t('selected', { count: selection.count })}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={selection.count === 0 || isExporting}
          onClick={() => void exportSelection()}
        >
          {t('export')}
        </Button>
      </div>

      <Card padded={false}>
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState
            message={error instanceof ApiError ? error.userMessage : tCommon('loadFailed')}
            onRetry={() => void refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t(`${stage}.emptyTitle`)}
            description={hasFilters ? t('emptyFiltered') : t(`${stage}.empty`)}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-8">
                      <SelectAllCheckbox selection={selection} />
                    </th>
                    <th>{tCommon('reference')}</th>
                    <th>{tCommon('customer')}</th>
                    <th>{tCommon('wilaya')}</th>
                    <th>{t('carrierColumn')}</th>
                    <th>{t('columns.attempts')}</th>
                    <th>{t(`${stage}.dateColumn`)}</th>
                    <th className="text-end">{tCommon('total')}</th>
                    {/* L'encaissement n'a de sens qu'une fois le colis remis :
                        l'afficher sur « en livraison » ferait lire une creance
                        sur une somme qui n'est meme pas encore due. */}
                    {stage === 'DELIVERED' ? <th>{t('columns.collection')}</th> : null}
                  </tr>
                </thead>
                <tbody className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
                  {rows.map((row) => {
                    const wilaya = row.wilayaCode ? getWilayaByCode(row.wilayaCode) : null;
                    const stageDate = stage === 'DELIVERED' ? row.deliveredAt : row.shippedAt;
                    const manyAttempts = row.failedAttempts >= ATTEMPTS_ALERT_THRESHOLD;

                    return (
                      <tr key={row.id}>
                        <td>
                          <RowCheckbox id={row.id} selection={selection} label={row.reference} />
                        </td>
                        <td>
                          <Link
                            href={`/commandes/${row.id}`}
                            className="font-mono text-xs font-medium text-brand-700 hover:underline"
                          >
                            {row.reference}
                          </Link>
                          {row.trackingNumber ? (
                            <span className="block font-mono text-xs text-muted">
                              {row.trackingNumber}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <span className="block text-sm text-ink">{row.customerName}</span>
                          <span className="tabular text-xs text-muted">{row.phone}</span>
                        </td>
                        <td className="text-sm text-ink-2">
                          {wilaya ? `${wilaya.code2} ${wilaya.name}` : tCommon('none')}
                          {row.commune ? (
                            <span className="block text-xs text-muted">{row.commune}</span>
                          ) : null}
                        </td>
                        <td className="text-sm text-ink-2">
                          {row.carrierName ?? tCommon('none')}
                          {/* Le libelle BRUT du transporteur, tel qu'il l'ecrit :
                              c'est celui qu'il faudra citer en appelant
                              l'agence. Le statut normalise, lui, est deja porte
                              par l'ecran ou l'on se trouve. */}
                          {row.providerStatus ? (
                            <span className="block text-xs text-muted">{row.providerStatus}</span>
                          ) : null}
                        </td>
                        {/* TROIS FAITS DISTINCTS, ET CELUI-CI N'EST PAS LE
                            DERNIER STATUT. Une commande livree apres trois
                            passages reste une commande a trois tentatives : le
                            compteur ne s'efface pas a la livraison. */}
                        <td>
                          {row.failedAttempts === 0 ? (
                            <span className="text-xs text-muted">{tCommon('none')}</span>
                          ) : (
                            <>
                              <Badge tone={manyAttempts ? 'danger' : 'warning'}>
                                {t('attempts', { count: row.failedAttempts })}
                              </Badge>
                              {row.lastAttemptAt ? (
                                <span className="block text-xs text-muted">
                                  {relativeTime(row.lastAttemptAt)}
                                </span>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-sm text-ink-2">
                          {stageDate ? (
                            <>
                              {formatDate(stageDate)}
                              <span className="block text-xs text-muted">
                                {relativeTime(stageDate)}
                              </span>
                            </>
                          ) : (
                            tCommon('none')
                          )}
                        </td>
                        <td className="text-end">
                          <Money centimes={row.totalCentimes} />
                        </td>
                        {stage === 'DELIVERED' ? (
                          <td>
                            <CollectionCell state={row.collection} />
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              page={data!.meta.page}
              totalPages={data!.meta.totalPages}
              total={data!.meta.total}
              onChange={setPage}
            />
          </>
        )}
      </Card>
    </>
  );
}

/**
 * L'encaissement, en QUATRE lectures distinctes.
 *
 * Le piege a eviter tient en une ligne : ne jamais rendre `UNSUPPORTED` comme
 * `PENDING`. Le premier dit « ce transporteur ne nous envoie pas cette
 * information » — il n'y a rien a reclamer, rien a relancer, et la somme peut
 * parfaitement etre deja encaissee sans que nous le sachions. Le second dit
 * « le transporteur nous le dira, et ne l'a pas encore fait » — c'est une
 * creance, et elle vieillit.
 *
 * Les rendre identiques (un tiret, une case vide) transformerait toute une
 * colonne en fausse liste d'impayes.
 */
function CollectionCell({ state }: { state: CollectionState }) {
  const t = useTranslations('delivery.collection');

  switch (state.kind) {
    case 'COLLECTED':
      return (
        <>
          <Badge tone="success">
            <Money centimes={state.amountCentimes} />
          </Badge>
          <span className="block text-xs text-muted">{formatDate(state.collectedAt)}</span>
          {state.reference ? (
            <span className="block font-mono text-xs text-muted">{state.reference}</span>
          ) : null}
        </>
      );

    case 'PENDING':
      return (
        <>
          <Badge tone="warning">{t('pending')}</Badge>
          <span className="block text-xs text-muted">{t('pendingHint')}</span>
        </>
      );

    case 'UNSUPPORTED':
      return (
        <>
          {/* Ton NEUTRE, jamais d'alerte : il n'y a rien d'anormal ici, juste
              une information que ce transporteur ne transmet pas. */}
          <span className="text-xs text-muted" title={t('unsupportedHint')}>
            {t('unsupported')}
          </span>
        </>
      );

    default:
      return <span className="text-xs text-muted">{t('unknown')}</span>;
  }
}
