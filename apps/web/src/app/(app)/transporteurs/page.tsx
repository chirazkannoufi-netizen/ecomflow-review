'use client';

/**
 * Transporteurs — V1 §12, V2 §16, D-069.
 *
 * UN SEUL ECRAN, DEUX QUESTIONS QUI N'ONT PAS LE MEME POIDS
 *   « Avec qui je travaille, et est-ce que ca repond ? » se pose tous les
 *   jours. « Que sait faire ce reseau, et jusqu'ou livre-t-il ? » se pose une
 *   fois, au moment de choisir. Les deux vivaient sur deux ecrans — l'un
 *   catalogue, l'autre comptes — ce qui obligeait a savoir lequel ouvrir avant
 *   de savoir ce qu'on cherchait.
 *
 *   Ils n'en font plus qu'un, et la hierarchie tranche : la LISTE DES COMPTES
 *   est l'ecran. Le catalogue ne disparait pas, il redescend — rattache a
 *   chaque ligne par sa plateforme, consultable au clic.
 *
 * CE QU'UN COMPTE EST ICI
 *   Les identifiants avec lesquels cette boutique parle a Yalidine. Ni une
 *   personne, ni un utilisateur du produit — aucun login, aucun mot de passe,
 *   aucun telephone de connexion (D-067). Stocker de quoi authentifier
 *   quelqu'un qui n'a nulle part ou se connecter creerait un secret orphelin.
 *
 * LES IDENTIFIANTS NE REDESCENDENT JAMAIS
 *   L'ecran sait quels champs sont renseignes — jamais leur valeur. Un champ
 *   secret laisse vide signifie donc « je n'y touche pas », et non
 *   « efface-le ».
 */

import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CARRIER_ACCOUNT_KINDS,
  PERMISSIONS,
  WILAYAS,
  type CarrierAccountKind,
} from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  formatDateTime,
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

/**
 * L'etat d'integration d'une plateforme, en un mot — D-066, D-070.
 *
 * TROIS ETATS, ET LA NUANCE EST TOUT L'INTERET
 *   « Disponible » dit qu'un adaptateur a tourne contre un compte marchand
 *   reel. « Non verifie » dit qu'il existe et qu'on peut s'en servir, mais que
 *   rien n'a encore ete confronte a la realite. « Prevu » dit qu'il n'y a pas
 *   d'adaptateur du tout.
 *
 *   Seul le premier est ecrit en gris neutre : les deux autres portent la
 *   couleur d'un avertissement, parce que les confondre avec le premier est
 *   exactement l'erreur qui coute un colis.
 */
function platformStatusKey(status: string): 'AVAILABLE' | 'UNVERIFIED' | 'PLANNED' {
  if (status === 'AVAILABLE') return 'AVAILABLE';
  if (status === 'UNVERIFIED') return 'UNVERIFIED';
  return 'PLANNED';
}

const STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  CONNECTED: 'success',
  DEGRADED: 'warning',
  ERROR: 'danger',
  PENDING_SETUP: 'info',
  DISCONNECTED: 'neutral',
  DISABLED: 'neutral',
};

interface CredentialField {
  readonly key: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly helpText?: string;
}

interface Connector {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly implementationStatus: string;
  readonly selectable: boolean;
  readonly credentialFields: readonly CredentialField[];
}

interface CarrierEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly implementationStatus: string;
  readonly sourceNote: string | null;
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

interface Account {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly kind: CarrierAccountKind;
  readonly isDefault: boolean;
  readonly stockHeldByCourier: boolean;
  readonly sendOrderNumberInsteadOfReference: boolean;
  readonly lastHealthCheckAt: string | null;
  readonly lastHealthCheckOk: boolean | null;
  readonly lastErrorMessage: string | null;
  readonly shipmentCount: number;
  readonly deletable: boolean;
  readonly credentialKeys: readonly string[];
  readonly carrier: { id: string; code: string; name: string; implementationStatus: string };
}

export default function CarriersPage() {
  const t = useTranslations('carriers');
  const tCommon = useTranslations('common');
  const { can } = useSession();
  const queryClient = useQueryClient();

  const canManage = can(PERMISSIONS.SETTINGS_MANAGE);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['carrier-accounts'],
    queryFn: () => api.get<Account[]>('/carrier-accounts'),
  });

  // Le catalogue n'est plus interroge pour lui-meme : il RENSEIGNE les lignes
  // de comptes — ce que la plateforme sait faire, jusqu'ou elle livre — et
  // nourrit la note de bas de tableau pour les plateformes sans compte.
  const catalogueQuery = useQuery({
    queryKey: ['carrier-catalogue'],
    queryFn: () => api.get<CarrierEntry[]>('/carrier-catalogue'),
  });

  const connectorsQuery = useQuery({
    queryKey: ['carrier-connectors'],
    queryFn: () => api.get<Connector[]>('/carrier-connectors'),
    enabled: canManage,
  });

  const accounts = accountsQuery.data ?? [];
  const catalogue = useMemo(() => catalogueQuery.data ?? [], [catalogueQuery.data]);
  const connectors = useMemo(() => connectorsQuery.data ?? [], [connectorsQuery.data]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['carrier-accounts'] });
    // La liste du Dispatcher et celle de la preparation lisent la meme cle :
    // un compte ajoute ici doit y apparaitre sans rechargement.
    void queryClient.invalidateQueries({ queryKey: ['preparation'] });
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          canManage ? (
            <Button onClick={() => setCreating((value) => !value)}>
              {creating ? tCommon('cancel') : t('add')}
            </Button>
          ) : null
        }
      />

      {creating && canManage ? (
        <CreateAccountForm
          connectors={connectors}
          loading={connectorsQuery.isLoading}
          onDone={() => {
            setCreating(false);
            refresh();
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      <Card
        padded={false}
        footer={
          catalogue.length > 0 ? (
            <CatalogueFootnote carriers={catalogue} canManage={canManage} />
          ) : undefined
        }
      >
        {accountsQuery.isLoading ? (
          <LoadingState />
        ) : accountsQuery.error ? (
          <ErrorState
            message={
              accountsQuery.error instanceof ApiError
                ? accountsQuery.error.userMessage
                : tCommon('loadFailed')
            }
            onRetry={() => void accountsQuery.refetch()}
          />
        ) : accounts.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('empty')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('columns.name')}</th>
                  <th>{t('columns.platform')}</th>
                  <th>{t('columns.status')}</th>
                  <th className="text-end">{t('columns.action')}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const open = expanded === account.id;
                  const platform = catalogue.find((entry) => entry.id === account.carrier.id);

                  return (
                    <Fragment key={account.id}>
                      <tr data-selected={open || undefined}>
                        <td>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-ink">{account.label}</span>
                            {account.isDefault ? (
                              <Badge tone="info" title={t('isDefaultHint')}>
                                {t('isDefault')}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-xs text-muted">
                            {t(`kinds.${account.kind}`)}
                            {account.stockHeldByCourier ? ` · ${t('holdsStock')}` : ''} ·{' '}
                            {t('shipmentCount', { count: account.shipmentCount })}
                          </p>
                        </td>

                        {/* LA PLATEFORME PORTE LE CATALOGUE.
                            « Disponible / Prevu » et la couverture tiennent en
                            une ligne grise sous le nom du reseau ; la matrice
                            de capacites, elle, est au clic. Une seconde
                            pastille coloree sur la ligne entrerait en
                            concurrence avec le STATUT du compte — le seul
                            qu'on balaie vraiment. */}
                        <td>
                          <span className="text-sm text-ink-2">{account.carrier.name}</span>
                          <p
                            className={clsx(
                              'text-xs',
                              account.carrier.implementationStatus === 'AVAILABLE'
                                ? 'text-muted'
                                : 'text-warning',
                            )}
                          >
                            {t(
                              `platformStatus.${platformStatusKey(
                                account.carrier.implementationStatus,
                              )}`,
                            )}
                            {platform
                              ? ` · ${
                                  platform.coveredWilayas > 0
                                    ? t('wilayaCovered', { count: platform.coveredWilayas })
                                    : t('wilayaUnknown')
                                }`
                              : ''}
                          </p>
                        </td>

                        <td>
                          <Badge tone={STATUS_TONES[account.status] ?? 'neutral'}>
                            {t(`statuses.${account.status}`)}
                          </Badge>
                        </td>

                        <td className="text-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setExpanded(open ? null : account.id)}
                          >
                            {open ? tCommon('close') : t('configure')}
                          </Button>
                        </td>
                      </tr>

                      {open ? (
                        <tr>
                          <td colSpan={4} className="bg-canvas/60 p-0">
                            <div className="px-3 py-3">
                              <AccountPanel
                                account={account}
                                connector={connectors.find(
                                  (entry) => entry.id === account.carrier.id,
                                )}
                                platform={platform}
                                canManage={canManage}
                                onChanged={refresh}
                              />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Le formulaire d'ajout, sur le modele d'Ecomanager — moins ce qui n'a pas
 * d'objet chez nous.
 *
 * DEUX ONGLETS, PARCE QUE LES CLES NE SONT PAS UN REGLAGE
 *   « Essentiel » se remplit une fois et se relit ; les cles d'API se
 *   remplacent, se testent, et ne se relisent JAMAIS — l'ecran ne les recoit
 *   pas. Les melanger ferait cohabiter des champs qu'on modifie et des champs
 *   qu'on ne peut que reecrire.
 *
 * CE QUE CE FORMULAIRE NE DEMANDE PAS, ET POURQUOI (D-067)
 *   Telephone et mot de passe : ce sont les identifiants de connexion du
 *   livreur a LEUR application mobile. Nous n'en avons pas, donc rien a quoi
 *   ils donneraient acces. QR Code : meme raison. Boutiques : un
 *   `CarrierAccount` est scope par tenant (D-004) — la question est deja
 *   repondue par la structure.
 *
 * CE QU'ECOMANAGER N'A PAS A DEMANDER, ET NOUS SI
 *   Leur formulaire ne connait qu'une plateforme : la leur. Le notre doit
 *   d'abord faire choisir LEQUEL transporteur du catalogue ce compte concerne,
 *   puis recueillir les identifiants d'API — sans lesquels le compte ne peut
 *   rien authentifier, et n'a donc aucune raison d'exister.
 */
function CreateAccountForm({
  connectors,
  loading,
  onDone,
  onCancel,
}: {
  connectors: readonly Connector[];
  loading: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('carriers');
  const tCommon = useTranslations('common');

  const [tab, setTab] = useState<'essentials' | 'credentials'>('essentials');
  const [kind, setKind] = useState<CarrierAccountKind>('DELIVERY_COMPANY');
  const [carrierId, setCarrierId] = useState('');
  const [label, setLabel] = useState('');
  const [sendOrderNumberInsteadOfReference, setSendOrderNumber] = useState(false);
  const [stockHeldByCourier, setStockHeldByCourier] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const selected = connectors.find((entry) => entry.id === carrierId) ?? null;

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string; status: string }>('/carrier-accounts', {
        carrierId,
        label,
        kind,
        sendOrderNumberInsteadOfReference,
        stockHeldByCourier,
        enabled,
        credentials,
      }),
    onSuccess: () => onDone(),
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed')),
  });

  if (loading) {
    return (
      <Card className="mb-3">
        <LoadingState />
      </Card>
    );
  }

  return (
    <Card className="mb-3" title={t('formTitle')}>
      <div className="mb-3 flex gap-1.5 border-b border-line">
        <FormTab active={tab === 'essentials'} onClick={() => setTab('essentials')}>
          {t('tabEssentials')}
        </FormTab>
        <FormTab active={tab === 'credentials'} onClick={() => setTab('credentials')}>
          {t('tabCredentials')}
        </FormTab>
      </div>

      {/* L'erreur reste visible depuis LES DEUX onglets : une cle d'API refusee
          se lit alors que le champ fautif est peut-etre sur l'autre. */}
      {error ? (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      {tab === 'essentials' ? (
        <div className="space-y-3">
          <KindChoice value={kind} onChange={setKind} disabled={mutation.isPending} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t('label')}
              hint={t('labelHint')}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('labelPlaceholder')}
            />

            <Select
              label={t('carrier')}
              hint={t('carrierHint')}
              value={carrierId}
              onChange={(event) => {
                setCarrierId(event.target.value);
                // Les champs d'identifiants changent avec le transporteur :
                // garder les valeurs precedentes enverrait des cles que le
                // nouveau connecteur ne reconnait pas, et l'API les refuserait.
                setCredentials({});
                setError(null);
              }}
            >
              <option value="">{tCommon('select')}</option>
              {connectors.map((connector) => (
                <option key={connector.id} value={connector.id} disabled={!connector.selectable}>
                  {connector.name}
                  {connector.selectable ? '' : ` — ${t('notConnected')}`}
                </option>
              ))}
            </Select>
          </div>

          {/* D-066 : un transporteur PREVU reste LISTE mais non selectionnable,
              et la raison est dite ici plutot que derriere une option grisee
              muette. */}
          {selected && !selected.selectable ? (
            <Alert tone="warning">{t('notConnectedHint', { name: selected.name })}</Alert>
          ) : null}

          <div className="space-y-1.5">
            <Toggle
              checked={sendOrderNumberInsteadOfReference}
              disabled={mutation.isPending}
              title={t('sendOrderNumber')}
              hint={t('sendOrderNumberHint')}
              onChange={setSendOrderNumber}
            />
            <Toggle
              checked={stockHeldByCourier}
              disabled={mutation.isPending}
              title={t('holdsStock')}
              hint={t('holdsStockHint')}
              onChange={setStockHeldByCourier}
            />
          </div>

          <ActiveChoice value={enabled} onChange={setEnabled} disabled={mutation.isPending} />

          <Alert tone="info">{t('scopeNotice')}</Alert>
        </div>
      ) : selected?.selectable ? (
        <CredentialFields
          fields={selected.credentialFields}
          values={credentials}
          onChange={setCredentials}
          configured={[]}
        />
      ) : (
        <Alert tone="info">{t('credentialsPending')}</Alert>
      )}

      <div className="mt-3 flex gap-2 border-t border-line pt-3">
        <Button
          disabled={!carrierId || !label.trim() || !selected?.selectable || mutation.isPending}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {t('createAndTest')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={mutation.isPending}>
          {tCommon('cancel')}
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-muted">{t('createAndTestHint')}</p>
    </Card>
  );
}

function FormTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={clsx(
        '-mb-px border-b-2 px-2.5 pb-2 text-sm font-semibold transition-colors',
        active ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink-2',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Agent de livraison / Societe de livraison.
 *
 * L'AGENT EST VISIBLE, ET DESACTIVE
 *   Un agent de livraison n'est pas une variante de compte : c'est une
 *   PERSONNE, avec un role, des permissions et une interface a elle — un
 *   chantier entier, pas un champ. Le masquer laisserait croire que la
 *   distinction nous a echappe ; l'ouvrir promettrait un ecran qui n'est pas
 *   construit. Il est donc montre « bientot », comme les autres ecrans en
 *   attente de la navigation.
 *
 *   `allowAgent` n'existe que pour un compte DEJA enregistre comme agent : un
 *   choix qu'on ne peut pas reprendre ne doit pas s'afficher desactive sur sa
 *   propre valeur.
 */
function KindChoice({
  value,
  onChange,
  disabled,
  allowAgent = false,
}: {
  value: CarrierAccountKind;
  onChange: (kind: CarrierAccountKind) => void;
  disabled: boolean;
  allowAgent?: boolean;
}) {
  const t = useTranslations('carriers');
  const tNav = useTranslations('nav');
  const name = useId();

  return (
    <Field label={t('kind')} hint={t('kindHint')}>
      <div className="flex flex-wrap items-center gap-4 py-1">
        {CARRIER_ACCOUNT_KINDS.map((entry) => {
          const soon = entry === 'DELIVERY_AGENT' && !allowAgent;

          return (
            <label
              key={entry}
              title={soon ? t('kindAgentSoon') : undefined}
              className={clsx(
                'flex items-center gap-1.5 text-sm',
                soon ? 'cursor-default text-muted opacity-60' : 'text-ink',
              )}
            >
              <input
                type="radio"
                name={name}
                value={entry}
                checked={value === entry}
                disabled={disabled || soon}
                onChange={() => onChange(entry)}
              />
              <span>{t(`kinds.${entry}`)}</span>
              {soon ? (
                <span className="rounded-full bg-canvas px-1.5 text-[10px] font-bold text-muted">
                  {tNav('soon')}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </Field>
  );
}

/**
 * Actif / Inactif — une INTENTION, jamais un diagnostic (D-068).
 *
 * Un compte cree inactif est tout de meme interroge : on saura qu'il
 * repondrait. Mais le controle n'ecrase pas la decision du commercant.
 */
function ActiveChoice({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (enabled: boolean) => void;
  disabled: boolean;
}) {
  const t = useTranslations('carriers');
  const name = useId();

  return (
    <Field label={t('activeLabel')} hint={t('activeHint')}>
      <div className="flex flex-wrap items-center gap-4 py-1">
        {[true, false].map((entry) => (
          <label key={String(entry)} className="flex items-center gap-1.5 text-sm text-ink">
            <input
              type="radio"
              name={name}
              checked={value === entry}
              disabled={disabled}
              onChange={() => onChange(entry)}
            />
            <span>{entry ? t('active') : t('inactive')}</span>
          </label>
        ))}
      </div>
    </Field>
  );
}

/** Les champs d'identifiants, tels que le connecteur les declare. */
function CredentialFields({
  fields,
  values,
  onChange,
  configured,
}: {
  fields: readonly CredentialField[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  configured: readonly string[];
}) {
  const t = useTranslations('carriers');

  if (fields.length === 0) return null;

  return (
    <section>
      <p className="mb-1.5 text-xs text-muted">{t('credentialsHint')}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const isSet = configured.includes(field.key);
          return (
            <Input
              key={field.key}
              label={field.label}
              // Un secret DEJA renseigne ne se reaffiche pas : le champ dit
              // qu'il est rempli, et reste vide tant qu'on ne le remplace pas.
              type={field.secret ? 'password' : 'text'}
              required={field.required && !isSet}
              hint={isSet ? t('credentialSet') : field.helpText}
              placeholder={isSet ? '••••••••' : undefined}
              autoComplete="off"
              value={values[field.key] ?? ''}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
            />
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panneau d'un compte
// ---------------------------------------------------------------------------

function AccountPanel({
  account,
  connector,
  platform,
  canManage,
  onChanged,
}: {
  account: Account;
  connector: Connector | undefined;
  platform: CarrierEntry | undefined;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('carriers');
  const tCommon = useTranslations('common');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState(account.label);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [detail, setDetail] = useState(false);

  function fail(caught: unknown) {
    setNotice(null);
    setError(caught instanceof ApiError ? caught.userMessage : tCommon('actionFailed'));
  }

  const settings = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api.patch(`/carrier-accounts/${account.id}/settings`, changes),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: fail,
  });

  const credentialsMutation = useMutation({
    mutationFn: () =>
      api.put<{ status: string; health: { ok: boolean; message?: string } }>(
        `/carrier-accounts/${account.id}/credentials`,
        { credentials },
      ),
    onSuccess: (result) => {
      setError(null);
      setCredentials({});
      setNotice(result.health.ok ? t('checkOk') : (result.health.message ?? t('checkFailed')));
      onChanged();
    },
    onError: fail,
  });

  const health = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string }>(
        `/carrier-accounts/${account.id}/health-check`,
        {},
      ),
    onSuccess: (result) => {
      setError(null);
      setNotice(result.ok ? t('checkOk') : (result.message ?? t('checkFailed')));
      onChanged();
    },
    onError: fail,
  });

  const removal = useMutation({
    mutationFn: () => api.delete(`/carrier-accounts/${account.id}`),
    onSuccess: () => {
      setConfirmDelete(false);
      onChanged();
    },
    onError: (caught) => {
      setConfirmDelete(false);
      fail(caught);
    },
  });

  const busy =
    settings.isPending || credentialsMutation.isPending || health.isPending || removal.isPending;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {account.lastErrorMessage && !error ? (
        <Alert tone="warning">{account.lastErrorMessage}</Alert>
      ) : null}

      <KindChoice
        value={account.kind}
        disabled={!canManage || busy}
        allowAgent={account.kind === 'DELIVERY_AGENT'}
        onChange={(kind) => settings.mutate({ kind })}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label={t('label')}
          value={label}
          disabled={!canManage || busy}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => {
            const trimmed = label.trim();
            if (trimmed && trimmed !== account.label) settings.mutate({ label: trimmed });
          }}
        />
      </div>

      <div className="space-y-1.5">
        <Toggle
          checked={account.sendOrderNumberInsteadOfReference}
          disabled={!canManage || busy}
          title={t('sendOrderNumber')}
          hint={t('sendOrderNumberHint')}
          onChange={(checked) => settings.mutate({ sendOrderNumberInsteadOfReference: checked })}
        />
        <Toggle
          checked={account.stockHeldByCourier}
          disabled={!canManage || busy}
          title={t('holdsStock')}
          hint={t('holdsStockHint')}
          onChange={(checked) => settings.mutate({ stockHeldByCourier: checked })}
        />
        <Toggle
          checked={account.isDefault}
          // On ne DECOCHE pas un compte par defaut : il faut bien qu'un compte
          // le soit. On en designe un autre, ce qui libere celui-ci.
          disabled={!canManage || busy || account.isDefault}
          title={t('isDefault')}
          hint={t('isDefaultHint')}
          onChange={(checked) => settings.mutate({ isDefault: checked })}
        />
      </div>

      <ActiveChoice
        value={account.status !== 'DISABLED'}
        disabled={!canManage || busy}
        onChange={(enabled) => settings.mutate({ enabled })}
      />

      {/* --- Cles d'API ------------------------------------------------------ */}
      {connector?.selectable ? (
        <section className="border-t border-line pt-3">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
            {t('credentials')}
          </h4>
          <CredentialFields
            fields={connector.credentialFields}
            values={credentials}
            onChange={setCredentials}
            configured={account.credentialKeys}
          />
          <div className="mt-2">
            <Button
              size="sm"
              disabled={!canManage || busy || Object.keys(credentials).length === 0}
              onClick={() => credentialsMutation.mutate()}
            >
              {t('saveCredentials')}
            </Button>
          </div>
        </section>
      ) : null}

      {/* --- Ce que la plateforme sait faire ---------------------------------
          Le catalogue REDESCEND ici : c'est une propriete du reseau, identique
          pour toutes les boutiques, et on ne la consulte qu'en cas de doute —
          « ce transporteur sait-il annuler un colis ? ». La mettre au premier
          plan reviendrait a faire lire une fiche technique a quelqu'un qui
          venait verifier si son compte repond. */}
      {platform ? (
        <section className="border-t border-line pt-3">
          <button
            className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
            onClick={() => setDetail((value) => !value)}
          >
            {detail ? tCommon('close') : t('platformDetail', { name: account.carrier.name })}
          </button>
          {detail ? (
            <div className="mt-2">
              <PlatformDetail carrier={platform} canManage={canManage} />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* --- Etat et actions ------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => health.mutate()}>
          {t('runCheck')}
        </Button>

        {/* TROIS ETATS, PAS DEUX : supprimable, non supprimable avec sa
            raison, ou sans droit. Un bouton qui echouerait apres le clic
            couterait un aller-retour pour une reponse connue d'avance. */}
        {account.deletable ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!canManage || busy}
            onClick={() => setConfirmDelete(true)}
          >
            {tCommon('remove')}
          </Button>
        ) : (
          <span className="text-xs text-muted" title={t('notDeletableHint')}>
            {t('notDeletable', { count: account.shipmentCount })}
          </span>
        )}

        <span className="ms-auto text-xs text-muted">
          {account.lastHealthCheckAt
            ? t('lastCheck', { date: formatDateTime(account.lastHealthCheckAt) })
            : t('neverChecked')}
        </span>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title={t('confirmDeleteTitle', { label: account.label })}
        message={t('confirmDeleteBody')}
        confirmLabel={tCommon('remove')}
        loading={removal.isPending}
        onConfirm={() => removal.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  title,
  hint,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  title: string;
  hint: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-ink-2">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="text-muted">{hint}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Catalogue — l'information secondaire
// ---------------------------------------------------------------------------

/**
 * Les plateformes du catalogue, en note de bas de tableau.
 *
 * POURQUOI ELLES NE DISPARAISSENT PAS AVEC L'ANCIEN ECRAN
 *   Un compte n'existe que chez un transporteur DISPONIBLE (D-066) : rattachee
 *   aux seules lignes de comptes, la distinction « disponible / prevu »
 *   n'aurait plus jamais eu l'occasion de se montrer, et un commercant qui
 *   cherche ZR Express aurait conclu a une omission. Une ligne grise sous le
 *   tableau suffit a la porter — et c'est aussi le seul chemin vers la
 *   couverture d'une plateforme qu'on n'utilise pas encore.
 */
function CatalogueFootnote({
  carriers,
  canManage,
}: {
  carriers: readonly CarrierEntry[];
  canManage: boolean;
}) {
  const t = useTranslations('carriers');
  const [open, setOpen] = useState<string | null>(null);

  const current = carriers.find((carrier) => carrier.id === open) ?? null;

  return (
    <div>
      <p className="text-xs text-muted">
        <span className="font-medium text-ink-2">{t('catalogue')}</span>{' '}
        {carriers.map((carrier, index) => (
          <Fragment key={carrier.id}>
            {index > 0 ? ' · ' : ''}
            <button
              className={clsx(
                'underline-offset-2 hover:text-ink hover:underline',
                open === carrier.id ? 'font-medium text-ink' : 'text-ink-2',
              )}
              onClick={() => setOpen(open === carrier.id ? null : carrier.id)}
            >
              {carrier.name}
            </button>
            <span
              className={
                carrier.implementationStatus === 'AVAILABLE' ? 'text-muted' : 'text-warning'
              }
            >
              {' ('}
              {t(`platformStatus.${platformStatusKey(carrier.implementationStatus)}`)}
              {')'}
            </span>
          </Fragment>
        ))}
      </p>

      {current ? (
        <div className="mt-2">
          <p className="mb-2 text-xs text-muted">{t('catalogueHint')}</p>
          <PlatformDetail carrier={current} canManage={canManage} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ce qu'une plateforme sait faire, jusqu'ou elle livre — et sur quoi on se base.
 *
 * LA PROVENANCE VIENT AVANT LA MATRICE
 *   Une matrice se lit comme un fait. Celle d'un transporteur non verifie n'en
 *   est pas un : elle vient de SDK communautaires que personne n'a confrontes a
 *   un compte reel. Le dire APRES les dix-huit pastilles serait le dire trop
 *   tard — l'oeil a deja conclu.
 */
function PlatformDetail({ carrier, canManage }: { carrier: CarrierEntry; canManage: boolean }) {
  const t = useTranslations('carriers');
  const verified = carrier.implementationStatus === 'AVAILABLE';

  return (
    <div className="space-y-3">
      {carrier.sourceNote ? (
        <Alert tone={verified ? 'info' : 'warning'}>
          {t(`sourceNotes.${carrier.sourceNote}`)}
        </Alert>
      ) : null}
      <CapabilityMatrix capabilities={carrier.capabilities} status={carrier.implementationStatus} />
      <CoveragePanel carrierId={carrier.id} canManage={canManage} />
    </div>
  );
}

/**
 * La matrice de capacites — et ce qu'elle vaut selon le transporteur.
 *
 * DECLARE N'EST PAS MESURE
 *   Deux cas rendent une matrice DECLAREE, et non mesuree. Un transporteur
 *   PREVU n'a aucun connecteur : sa matrice reprend ce que sa documentation
 *   annonce. Un transporteur NON VERIFIE en a un, mais ecrit d'apres des
 *   sources tierces et jamais confronte a un vrai compte (D-070).
 *
 *   Dans les deux cas la question est la meme : qu'est-ce qui a ete CONSTATE ?
 *   ZR Express v3 declare ainsi quatorze capacites — davantage que Yalidine,
 *   seul transporteur verifie du catalogue.
 *
 *   Les rendre avec la meme pastille verte reviendrait a promettre une parite
 *   qui n'a jamais ete verifiee. La difference n'est donc pas releguee au seul
 *   mot « Prevu » de la ligne : elle est portee par la matrice elle-meme, ou
 *   la question se pose vraiment.
 */
function CapabilityMatrix({
  capabilities,
  status,
}: {
  capabilities: Record<string, boolean> | null;
  /**
   * L'etat d'integration de la plateforme.
   *
   * Ce n'est plus « le code existe-t-il ? » : depuis D-070 un connecteur peut
   * exister sans avoir ete confronte a quoi que ce soit. C'est la VERIFICATION
   * qui decide si une capacite se lit comme un acquis — et la phrase qui
   * l'explique n'est pas la meme selon qu'il manque un connecteur ou un essai.
   */
  status: string;
}) {
  const t = useTranslations('carriers');
  const state = platformStatusKey(status);
  const verified = state === 'AVAILABLE';

  if (!capabilities) {
    return <Alert tone="warning">{t('capabilitiesUnknown')}</Alert>;
  }

  return (
    <section>
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
        {t('capabilities')}
      </h4>
      <p className="mb-1.5 text-xs text-muted">
        {t(`capabilityHints.${state}`)}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITY_GROUPS.map((group) => (
          <div key={group.key} className="rounded-md border border-line bg-white p-2">
            <p className="mb-1 text-xs font-medium text-ink-2">
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
                  : verified
                    ? 'bg-success'
                    : 'border border-slate-400 bg-transparent';
                return (
                  <li key={item} className="flex items-center gap-1.5 text-xs">
                    <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
                    <span
                      className={supported && verified ? 'text-ink' : 'text-muted'}
                      title={supported && !verified ? t('capabilityDeclaredOnly') : undefined}
                    >
                      {t(`capabilityNames.${item}`)}
                      {supported && !verified ? (
                        <span className="ms-1 text-muted">{t('declaredMark')}</span>
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
        className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
        onClick={() => setOpen(true)}
      >
        {t('coverageOpen')}
      </button>
    );
  }

  return (
    <section className="rounded-md border border-line bg-white p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">{t('coverage')}</h4>
        <button className="text-xs text-muted hover:text-ink" onClick={() => setOpen(false)}>
          {tCommon('close')}
        </button>
      </div>

      <p className="mb-2 text-xs text-muted">{t('coverageHint')}</p>
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
                  <td className="text-sm text-ink-2">
                    <span className="font-mono text-xs text-muted">{wilaya.code2}</span>{' '}
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
