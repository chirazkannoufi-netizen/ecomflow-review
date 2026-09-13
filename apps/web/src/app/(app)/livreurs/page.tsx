'use client';

/**
 * Livreurs — les comptes transporteur de la boutique (V1 §12, V2 §16).
 *
 * CE QU'UN « LIVREUR » EST ICI
 *   Un COMPTE chez un transporteur catalogue : les identifiants avec lesquels
 *   cette boutique parle a Yalidine. Ni une personne, ni un utilisateur du
 *   produit — aucun login, aucun mot de passe, aucun telephone de connexion.
 *   Stocker de quoi authentifier quelqu un qui n a nulle part ou se connecter
 *   creerait un secret orphelin.
 *
 * POURQUOI UNE LISTE PLATE, ET NON UNE SOUS-VUE DE `/transporteurs`
 *   Les deux ecrans repondent a deux questions differentes. `/transporteurs`
 *   repond a « que sait faire ce transporteur, et jusqu ou livre-t-il ? » —
 *   une propriete du RESEAU, identique pour toutes les boutiques. Celui-ci
 *   repond a « avec qui je travaille, et est-ce que ca repond ? » — un
 *   arrangement entre CETTE boutique et lui.
 *
 *   La seconde question se lit en balayant une liste : « lequel de mes comptes
 *   est en erreur ? ». Imbriquee sous quatre entrees de catalogue a deplier,
 *   elle demanderait quatre clics pour une reponse qui doit tenir en un
 *   coup d oeil. C est aussi le niveau auquel travaille le reste du produit :
 *   `Order.carrierAccountId` designe un COMPTE, pas un transporteur, et c est
 *   la liste des comptes que le Dispatcher propose.
 *
 * LES IDENTIFIANTS NE REDESCENDENT JAMAIS
 *   L ecran sait quels champs sont renseignes — jamais leur valeur. Un champ
 *   secret laisse vide signifie donc « je n y touche pas », et non « efface-le ».
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CARRIER_ACCOUNT_KINDS,
  PERMISSIONS,
  type CarrierAccountKind,
} from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import { useSession } from '@/lib/session';
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
  Select,
  formatDateTime,
} from '@/components/ui';

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

const STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  CONNECTED: 'success',
  DEGRADED: 'warning',
  ERROR: 'danger',
  PENDING_SETUP: 'info',
  DISCONNECTED: 'neutral',
  DISABLED: 'neutral',
};

export default function CouriersPage() {
  const t = useTranslations('couriers');
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

  const connectorsQuery = useQuery({
    queryKey: ['carrier-connectors'],
    queryFn: () => api.get<Connector[]>('/carrier-connectors'),
    enabled: canManage,
  });

  const accounts = accountsQuery.data ?? [];
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

      {/* CE QUE CET ECRAN NE DEMANDE PAS, ET POURQUOI ------------------------
          Le formulaire d'Ecomanager porte un telephone et un mot de passe : ce
          sont les identifiants de connexion du livreur a LEUR application
          mobile. Nous n'avons pas d'interface livreur, donc rien a quoi ces
          identifiants donneraient acces. */}
      <div className="mb-3">
        <Alert tone="info">{t('scopeNotice')}</Alert>
      </div>

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

      <Card padded={false}>
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
          <ul className="divide-y divide-line">
            {accounts.map((account) => (
              <li key={account.id}>
                <button
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-start hover:bg-slate-50"
                  onClick={() => setExpanded(expanded === account.id ? null : account.id)}
                >
                  <span className="min-w-[160px] flex-1">
                    <span className="block text-sm font-medium text-ink">{account.label}</span>
                    <span className="text-xs text-muted">
                      {account.carrier.name} · {t(`kinds.${account.kind}`)}
                    </span>
                  </span>

                  <Badge tone={STATUS_TONES[account.status] ?? 'neutral'}>
                    {t(`statuses.${account.status}`)}
                  </Badge>

                  {account.isDefault ? <Badge tone="info">{t('isDefault')}</Badge> : null}
                  {account.stockHeldByCourier ? (
                    <Badge tone="neutral">{t('holdsStock')}</Badge>
                  ) : null}

                  <span className="text-xs text-muted">
                    {t('shipmentCount', { count: account.shipmentCount })}
                  </span>

                  <span className="text-muted">{expanded === account.id ? '−' : '+'}</span>
                </button>

                {expanded === account.id ? (
                  <div className="border-t border-line bg-slate-50/60 px-3 py-3">
                    <AccountPanel
                      account={account}
                      connector={connectors.find((entry) => entry.id === account.carrier.id)}
                      canManage={canManage}
                      onChanged={refresh}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Creation d'un compte.
 *
 * DEUX CHOSES QU'ECOMANAGER N'A PAS A DEMANDER
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
  const t = useTranslations('couriers');
  const tCommon = useTranslations('common');

  const [carrierId, setCarrierId] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<CarrierAccountKind>('DELIVERY_COMPANY');
  const [stockHeldByCourier, setStockHeldByCourier] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const selected = connectors.find((entry) => entry.id === carrierId) ?? null;

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string; status: string }>('/carrier-accounts', {
        carrierId,
        label,
        kind,
        stockHeldByCourier,
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
    <Card className="mb-3">
      <h2 className="mb-2 text-sm font-medium text-ink">{t('add')}</h2>

      {error ? (
        <div className="mb-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('carrier')}
          hint={t('carrierHint')}
          value={carrierId}
          onChange={(event) => {
            setCarrierId(event.target.value);
            // Les champs d'identifiants changent avec le transporteur : garder
            // les valeurs precedentes enverrait des cles que le nouveau
            // connecteur ne reconnait pas, et l'API les refuserait.
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

        <Input
          label={t('label')}
          hint={t('labelHint')}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t('labelPlaceholder')}
        />

        <Select
          label={t('kind')}
          hint={t('kindHint')}
          value={kind}
          onChange={(event) => setKind(event.target.value as CarrierAccountKind)}
        >
          {CARRIER_ACCOUNT_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {t(`kinds.${entry}`)}
            </option>
          ))}
        </Select>

        <label className="flex items-start gap-2 self-end pb-1 text-xs text-ink-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={stockHeldByCourier}
            onChange={(event) => setStockHeldByCourier(event.target.checked)}
          />
          <span>
            <span className="block font-medium text-ink">{t('holdsStock')}</span>
            <span className="text-muted">{t('holdsStockHint')}</span>
          </span>
        </label>
      </div>

      {/* D-066 : un transporteur PREVU reste LISTE mais non selectionnable, et
          la raison est dite ici plutot que derriere une option grisee muette. */}
      {selected && !selected.selectable ? (
        <div className="mt-3">
          <Alert tone="warning">{t('notConnectedHint', { name: selected.name })}</Alert>
        </div>
      ) : null}

      {selected?.selectable ? (
        <CredentialFields
          fields={selected.credentialFields}
          values={credentials}
          onChange={setCredentials}
          configured={[]}
        />
      ) : null}

      <div className="mt-3 flex gap-2">
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

// ---------------------------------------------------------------------------

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
  const t = useTranslations('couriers');

  if (fields.length === 0) return null;

  return (
    <section className="mt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
        {t('credentials')}
      </h3>
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

function AccountPanel({
  account,
  connector,
  canManage,
  onChanged,
}: {
  account: Account;
  connector: Connector | undefined;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('couriers');
  const tCommon = useTranslations('common');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState(account.label);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  const disabled = account.status === 'DISABLED';

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {account.lastErrorMessage && !error ? (
        <Alert tone="warning">{account.lastErrorMessage}</Alert>
      ) : null}

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

        <Select
          label={t('kind')}
          hint={t('kindHint')}
          value={account.kind}
          disabled={!canManage || busy}
          onChange={(event) => settings.mutate({ kind: event.target.value })}
        >
          {CARRIER_ACCOUNT_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {t(`kinds.${entry}`)}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1.5">
        <Toggle
          checked={account.stockHeldByCourier}
          disabled={!canManage || busy}
          title={t('holdsStock')}
          hint={t('holdsStockHint')}
          onChange={(checked) => settings.mutate({ stockHeldByCourier: checked })}
        />
        <Toggle
          checked={account.sendOrderNumberInsteadOfReference}
          disabled={!canManage || busy}
          title={t('sendOrderNumber')}
          hint={t('sendOrderNumberHint')}
          onChange={(checked) => settings.mutate({ sendOrderNumberInsteadOfReference: checked })}
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

      {/* --- Identifiants --------------------------------------------------- */}
      {connector?.selectable ? (
        <>
          <CredentialFields
            fields={connector.credentialFields}
            values={credentials}
            onChange={setCredentials}
            configured={account.credentialKeys}
          />
          <Button
            size="sm"
            disabled={!canManage || busy || Object.keys(credentials).length === 0}
            onClick={() => credentialsMutation.mutate()}
          >
            {t('saveCredentials')}
          </Button>
        </>
      ) : null}

      {/* --- Etat et actions ------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => health.mutate()}>
          {t('runCheck')}
        </Button>

        <Button
          size="sm"
          variant="ghost"
          disabled={!canManage || busy}
          onClick={() => settings.mutate({ enabled: disabled })}
        >
          {disabled ? t('enable') : t('disable')}
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
