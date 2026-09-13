'use client';

/**
 * Transporteurs — V1 §12, V2 §16.
 *
 * CE QUE CET ECRAN REPOND
 *   « Qu'est-ce que mon transporteur sait faire, et jusqu'ou va-t-il ? »
 *   Jusqu'ici le produit traitait tous les transporteurs comme identiques, et
 *   proposait donc partout les memes actions. Le prix s'en payait plus tard :
 *   un bouton clique qui echoue, un agent qui croit avoir annule un colis, un
 *   client jamais prevenu.
 *
 * TROIS NIVEAUX DE DIVULGATION
 *   1. La liste : le nom, l'etat d'integration, le nombre de wilayas couvertes.
 *      C'est ce qu'on regarde en passant.
 *   2. L'ouverture d'une ligne : la matrice des capacites, en clair.
 *   3. Deux replis internes : la couverture wilaya par wilaya (58 lignes, qu'on
 *      ne consulte qu'en cas de doute) et les reglages du compte de la
 *      boutique.
 *
 * « NON RENSEIGNE » N'EST PAS « NON SUPPORTE »
 *   Un transporteur sans matrice affiche un avertissement, jamais dix-huit
 *   croix. La difference compte : la seconde forme ferait croire a une
 *   incapacite constatee la ou il n'y a qu'une saisie manquante.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, WILAYAS, type CarrierAccountKind } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/ui';

/**
 * Ordre d'affichage de la matrice, aligne sur `CARRIER_CAPABILITY_KEYS`.
 *
 * Les deux familles de synchronisation sont separees a l'ecran comme elles le
 * sont dans l'audit : la meme information — tentatives, livrees, echouees —
 * n'a pas la meme valeur selon qu'elle est RELEVEE toutes les heures ou POUSSEE
 * a l'instant. Les fondre en une seule colonne masquerait exactement ce qui
 * distingue deux transporteurs.
 */
const CAPABILITY_GROUPS = [
  { key: 'orders', items: ['addOrder', 'addOrderBulk', 'deleteOrder', 'printableLabel'] },
  { key: 'sync', items: ['syncAttempted', 'syncDelivered', 'syncFailed'] },
  {
    key: 'realtime',
    items: [
      'realtimeUndeliverableWilayas',
      'realtimeAttempted',
      'realtimeDelivered',
      'realtimeFailed',
      'realtimeCollectionVouchers',
      'realtimeAddressChange',
      'realtimePriceChange',
    ],
  },
  { key: 'delivery', items: ['stopDesk', 'afterSalesExchange', 'afterSalesPickup'] },
  { key: 'logistics', items: ['stockAtCarrier'] },
] as const;

interface CarrierEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly implementationStatus: string;
  readonly capabilities: Record<string, boolean> | null;
  readonly coveredWilayas: number;
}

interface CoverageEntry {
  readonly wilayaCode: number;
  readonly wilayaName: string;
  readonly homeDelivery: boolean;
  readonly pickupPoint: boolean;
  readonly leadTimeDays: number | null;
}

interface CarrierAccount {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly isDefault: boolean;
  readonly kind: CarrierAccountKind;
  readonly sendOrderNumberInsteadOfReference: boolean;
  readonly stockHeldByCourier: boolean;
  readonly lastHealthCheckAt: string | null;
  readonly lastHealthCheckOk: boolean | null;
  readonly carrier: { id: string; code: string; name: string };
}

export default function CarriersPage() {
  const t = useTranslations('carriers');
  const tCommon = useTranslations('common');
  const { can } = useSession();

  const [expanded, setExpanded] = useState<string | null>(null);

  const canManage = can(PERMISSIONS.SETTINGS_MANAGE);

  const catalogueQuery = useQuery({
    queryKey: ['carrier-catalogue'],
    queryFn: () => api.get<CarrierEntry[]>('/carrier-catalogue'),
  });

  const accountsQuery = useQuery({
    queryKey: ['carrier-accounts'],
    queryFn: () => api.get<CarrierAccount[]>('/carrier-accounts'),
  });

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      <Card padded={false}>
        {catalogueQuery.isLoading ? (
          <LoadingState />
        ) : catalogueQuery.error ? (
          <ErrorState
            message={
              catalogueQuery.error instanceof ApiError
                ? catalogueQuery.error.userMessage
                : tCommon('loadFailed')
            }
            onRetry={() => void catalogueQuery.refetch()}
          />
        ) : (catalogueQuery.data?.length ?? 0) === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <ul className="divide-y divide-line">
            {catalogueQuery.data?.map((carrier) => {
              const accounts = (accountsQuery.data ?? []).filter(
                (account) => account.carrier.id === carrier.id,
              );

              return (
                <li key={carrier.id}>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-start hover:bg-slate-50"
                    onClick={() => setExpanded(expanded === carrier.id ? null : carrier.id)}
                  >
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-slate-800">
                        {carrier.name}
                      </span>
                      <span className="font-mono text-xs text-slate-500">{carrier.code}</span>
                    </span>

                    {carrier.implementationStatus === 'AVAILABLE' ? (
                      <Badge tone="success">{t('statusAvailable')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('statusPlanned')}</Badge>
                    )}

                    {accounts.length > 0 ? (
                      <Badge tone="info">{t('accountCount', { count: accounts.length })}</Badge>
                    ) : null}

                    <span className="text-xs text-slate-500">
                      {carrier.coveredWilayas > 0
                        ? t('wilayaCovered', { count: carrier.coveredWilayas })
                        : t('wilayaUnknown')}
                    </span>

                    <span className="text-slate-400">{expanded === carrier.id ? '−' : '+'}</span>
                  </button>

                  {expanded === carrier.id ? (
                    <div className="space-y-3 border-t border-line bg-slate-50/60 px-3 py-3">
                      <CapabilityMatrix
                        capabilities={carrier.capabilities}
                        implemented={carrier.implementationStatus === 'AVAILABLE'}
                      />
                      <CoveragePanel carrierId={carrier.id} canManage={canManage} />

                      {/* LES COMPTES NE S'EDITENT PLUS ICI.
                          Ils avaient leur panneau replie sous chaque
                          transporteur, avant que « Livreurs » n'existe. Deux
                          endroits pour le meme reglage finissent par diverger,
                          et le second reste celui que personne ne pense a
                          mettre a jour. Cet ecran garde ce qui est une
                          propriete du RESEAU — capacites, couverture — et
                          renvoie vers l'ecran des comptes pour le reste. */}
                      <p className="text-xs text-slate-500">
                        {accounts.length > 0
                          ? t('accountsElsewhere', { count: accounts.length })
                          : t('noAccountYet')}{' '}
                        <Link href="/livreurs" className="text-brand-700 underline">
                          {t('manageAccounts')}
                        </Link>
                      </p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * La matrice de capacites — et ce qu'elle vaut selon le transporteur.
 *
 * DECLARE N'EST PAS MESURE
 *   Pour un transporteur PREVU, aucun connecteur n'existe : sa matrice reprend
 *   ce que sa documentation annonce, sans qu'une seule ligne ait ete confrontee
 *   a son API. Ecotrack declare ainsi douze capacites, dont la poussee temps
 *   reel des tentatives — davantage que Yalidine, qui est le seul transporteur
 *   reellement implemente.
 *
 *   Les rendre avec la meme pastille verte reviendrait a promettre une parite
 *   qui n'a jamais ete verifiee. La difference n'est donc pas releguee au seul
 *   badge « Prevu » du bandeau : elle est portee par la matrice elle-meme, ou
 *   la question se pose vraiment.
 */
function CapabilityMatrix({
  capabilities,
  implemented,
}: {
  capabilities: Record<string, boolean> | null;
  implemented: boolean;
}) {
  const t = useTranslations('carriers');

  if (!capabilities) {
    return <Alert tone="warning">{t('capabilitiesUnknown')}</Alert>;
  }

  return (
    <section>
      <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {t('capabilities')}
      </h4>
      <p className="mb-1.5 text-xs text-slate-500">
        {implemented ? t('capabilityHint') : t('capabilityDeclaredHint')}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITY_GROUPS.map((group) => (
          <div key={group.key} className="rounded-md border border-line bg-white p-2">
            <p className="mb-1 text-xs font-medium text-slate-600">
              {t(`capabilityGroups.${group.key}`)}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const supported = capabilities[item] ?? false;
                // Trois rendus, pas deux : supporte et verifie, supporte mais
                // seulement DECLARE, non supporte. Le deuxieme prend une
                // pastille creuse — visible, mais jamais lue comme un acquis.
                const dot = !supported
                  ? 'bg-slate-300'
                  : implemented
                    ? 'bg-success'
                    : 'border border-slate-400 bg-transparent';
                return (
                  <li key={item} className="flex items-center gap-1.5 text-xs">
                    <span
                      aria-hidden
                      className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`}
                    />
                    <span
                      className={supported && implemented ? 'text-slate-800' : 'text-slate-400'}
                      title={supported && !implemented ? t('capabilityDeclaredOnly') : undefined}
                    >
                      {t(`capabilityNames.${item}`)}
                      {supported && !implemented ? (
                        <span className="ms-1 text-slate-400">{t('declaredMark')}</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function CoveragePanel({ carrierId, canManage }: { carrierId: string; canManage: boolean }) {
  const t = useTranslations('carriers');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['carrier-coverage', carrierId],
    queryFn: () => api.get<CoverageEntry[]>(`/carriers/${carrierId}/coverage`),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (input: { wilayaCode: number; homeDelivery: boolean; pickupPoint: boolean }) =>
      api.put(`/carriers/${carrierId}/coverage`, input),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['carrier-coverage', carrierId] });
      void queryClient.invalidateQueries({ queryKey: ['carrier-catalogue'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed')),
  });

  const byCode = new Map((data ?? []).map((entry) => [entry.wilayaCode, entry]));

  if (!open) {
    return (
      <button
        className="text-xs text-slate-500 underline-offset-2 hover:text-brand-700 hover:underline"
        onClick={() => setOpen(true)}
      >
        {t('coverageOpen')}
      </button>
    );
  }

  return (
    <section className="rounded-md border border-line bg-white p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {t('coverage')}
        </h4>
        <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setOpen(false)}>
          {tCommon('close')}
        </button>
      </div>

      <p className="mb-2 text-xs text-slate-500">{t('coverageHint')}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="max-h-72 overflow-y-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>{tCommon('wilaya')}</th>
              <th className="text-center">{t('home')}</th>
              <th className="text-center">{t('pickupPoint')}</th>
            </tr>
          </thead>
          <tbody>
            {WILAYAS.map((wilaya) => {
              const entry = byCode.get(wilaya.code);
              const home = entry?.homeDelivery ?? false;
              const pickup = entry?.pickupPoint ?? false;

              return (
                <tr key={wilaya.code}>
                  <td className="text-sm text-slate-700">
                    <span className="font-mono text-xs text-slate-400">{wilaya.code2}</span>{' '}
                    {wilaya.name}
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      checked={home}
                      disabled={!canManage || mutation.isPending}
                      onChange={(event) =>
                        mutation.mutate({
                          wilayaCode: wilaya.code,
                          homeDelivery: event.target.checked,
                          pickupPoint: pickup,
                        })
                      }
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      checked={pickup}
                      disabled={!canManage || mutation.isPending}
                      onChange={(event) =>
                        mutation.mutate({
                          wilayaCode: wilaya.code,
                          homeDelivery: home,
                          pickupPoint: event.target.checked,
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

