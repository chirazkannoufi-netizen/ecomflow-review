'use client';

/**
 * Integrations — V1 §6, V2 §12, Addendum §34.
 *
 * L'ASSISTANT EST L'ECRAN LE PLUS RISQUE DU PRODUIT.
 *   C'est ici qu'un commercant sans competence technique branche sa feuille de
 *   commandes. Si ce parcours echoue, le produit entier ne sert a rien. D'ou
 *   trois choix :
 *
 *   1. L'APERCU AVANT L'IMPORT. On montre ce qu'EcomFlow COMPREND de la
 *      feuille — « 0555 12 34 56 » devient « +213555123456 », « Alger » devient
 *      la wilaya 16 — avant qu'une seule commande soit creee.
 *   2. LE TEST D'IMPORT NE CREE RIEN. L'etape de simulation valide chaque ligne
 *      sans ecrire en base : se tromper n'a aucune consequence.
 *   3. LES ERREURS SONT NOMMEES ET REJOUABLES. Une ligne rejetee est listee
 *      avec son numero et une explication ; la corriger puis rejouer ne
 *      reconsomme aucun quota Google.
 *
 * HONNETETE SUR L'ETAT REEL
 *   Si l'installation n'a pas d'identifiants OAuth Google, l'ecran le dit au
 *   lieu d'afficher un bouton qui echouerait.
 */

import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PERMISSIONS } from '@ecomflow/shared';
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
  Select,
  formatDateTime,
  formatRelative,
} from '@/components/ui';

interface GoogleStatus {
  readonly installationConfigured: boolean;
  readonly connected: boolean;
  readonly status: string;
  readonly accountLabel: string | null;
  readonly connectedAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

interface SheetConfig {
  readonly id: string;
  readonly spreadsheetId: string;
  readonly spreadsheetName: string | null;
  readonly sheetName: string;
  readonly columnMapping: Record<string, string>;
  readonly isActive: boolean;
  readonly syncIntervalMinutes: number;
  readonly lastSyncAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastProcessedRow: number | null;
  readonly consecutiveFailures: number;
  readonly backoffUntil: string | null;
  readonly _count: { rowImports: number };
}

interface SyncRun {
  readonly id: string;
  readonly trigger: string;
  readonly status: string;
  readonly rowsScanned: number;
  readonly rowsImported: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryAfter: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

interface RowError {
  readonly id: string;
  readonly sourceRowNumber: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly rawValues: readonly string[];
  readonly updatedAt: string;
}

interface Spreadsheet {
  readonly id: string;
  readonly name: string;
}

interface SheetTab {
  readonly title: string;
  readonly sheetId: string | number;
}

interface Preview {
  readonly headers: readonly string[];
  readonly suggestedMapping: Record<string, string | number>;
  readonly missingRequiredFields: readonly string[];
  readonly sampleRows: readonly {
    rowNumber: number;
    raw: readonly string[];
    parsed: Record<string, unknown> | null;
    error: { code: string; message: string } | null;
  }[];
}

/** Champs EcomFlow que le mapping peut renseigner, avec leur caractere requis. */
const MAPPING_FIELDS: readonly { key: string; required: boolean }[] = [
  { key: 'customerName', required: true },
  { key: 'phone', required: true },
  { key: 'wilaya', required: true },
  { key: 'commune', required: false },
  { key: 'address', required: false },
  { key: 'sku', required: false },
  { key: 'productName', required: false },
  { key: 'quantity', required: false },
  { key: 'unitPrice', required: false },
  { key: 'deliveryFee', required: false },
  { key: 'sourceStatus', required: false },
  { key: 'externalId', required: false },
  { key: 'orderedAt', required: false },
  { key: 'notes', required: false },
];

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <IntegrationsContent />
    </Suspense>
  );
}

function IntegrationsContent() {
  const t = useTranslations('integrations');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const { can } = useSession();
  const queryClient = useQueryClient();

  const canManage = can(PERMISSIONS.INTEGRATIONS_MANAGE);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  const [errorsForConfig, setErrorsForConfig] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['integrations', 'google', 'status'],
    queryFn: () => api.get<GoogleStatus>('/integrations/google/status'),
  });

  const configsQuery = useQuery({
    queryKey: ['integrations', 'google', 'sheets'],
    queryFn: () => api.get<SheetConfig[]>('/integrations/google/sheets'),
    enabled: statusQuery.data?.connected === true,
  });

  const runsQuery = useQuery({
    queryKey: ['integrations', 'google', 'runs'],
    queryFn: () => api.get<SyncRun[]>('/integrations/google/sync-runs'),
    enabled: statusQuery.data?.connected === true,
  });

  const errorsQuery = useQuery({
    queryKey: ['integrations', 'google', 'errors', errorsForConfig],
    queryFn: () => api.get<RowError[]>(`/integrations/google/sheets/${errorsForConfig}/errors`),
    enabled: Boolean(errorsForConfig),
  });

  const connectMutation = useMutation({
    mutationFn: () => api.get<{ url: string }>('/integrations/google/authorize'),
    onSuccess: (result) => {
      // Le consentement se fait chez Google : on quitte l'application, et le
      // callback nous ramene sur cette page avec un parametre explicite.
      window.location.href = result.url;
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('connectFailed'),
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.post('/integrations/google/disconnect', {}),
    onSuccess: () => {
      setFeedback({
        tone: 'success',
        text: t('disconnected'),
      });
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: (configId: string) =>
      api.post<{ rowsImported: number; rowsSkipped: number; rowsFailed: number; status: string }>(
        `/integrations/google/sheets/${configId}/sync`,
        {},
      ),
    onSuccess: (result) => {
      setFeedback({
        tone: 'success',
        text: t('synced', {
          imported: result.rowsImported,
          skipped: result.rowsSkipped,
          failed: result.rowsFailed,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('syncFailed'),
      });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (configId: string) =>
      api.post<{ retried: number; imported: number; stillFailed: number }>(
        `/integrations/google/sheets/${configId}/retry-failed`,
        {},
      ),
    onSuccess: (result) => {
      setFeedback({
        tone: 'success',
        text: t('retried', {
          imported: result.imported,
          retried: result.retried,
          stillFailed: result.stillFailed,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('retryImpossible'),
      });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (payload: { configId: string; isActive: boolean }) =>
      api.patch(`/integrations/google/sheets/${payload.configId}`, {
        isActive: payload.isActive,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['integrations'] }),
  });

  const callbackResult = searchParams.get('google');

  if (statusQuery.isLoading) return <LoadingState />;

  const status = statusQuery.data;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
      />

      {callbackResult === 'connecte' ? (
        <div className="mb-3">
          <Alert tone="success" title={t('connectedTitle')}>
            {t('connected')}
          </Alert>
        </div>
      ) : callbackResult === 'refuse' ? (
        <div className="mb-3">
          <Alert tone="warning" title={t('refusedTitle')}>
            {t('refused')}
          </Alert>
        </div>
      ) : callbackResult === 'erreur' ? (
        <div className="mb-3">
          <Alert tone="danger" title={t('errorTitle')}>
            {t('error')}
          </Alert>
        </div>
      ) : null}

      {feedback ? (
        <div className="mb-3">
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.text}</Alert>
        </div>
      ) : null}

      {/* --- Etat de la connexion ------------------------------------------ */}
      <Card
        title={t('googleTitle')}
        className="mb-4"
        action={
          status?.connected ? (
            <Badge tone="success">{t('badgeConnected')}</Badge>
          ) : status?.installationConfigured ? (
            <Badge tone="neutral">{t('badgeDisconnected')}</Badge>
          ) : (
            <Badge tone="warning">{t('badgeUnavailable')}</Badge>
          )
        }
      >
        {!status?.installationConfigured ? (
          <Alert tone="warning" title={t('notConfiguredTitle')}>
            {t('notConfigured')}
          </Alert>
        ) : status.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-slate-800">
                {t('connectedAccount', { account: status.accountLabel ?? tCommon('none') })}
              </p>
              <p className="text-xs text-slate-500">
                {t('authorizedOn', { date: formatDateTime(status.connectedAt) })}
                {status.lastCheckedAt
                  ? t('lastCheck', { when: formatRelative(status.lastCheckedAt) })
                  : ''}
              </p>
              {status.lastErrorMessage ? (
                <p className="mt-1 text-xs text-danger">
                  {t('lastError', { message: status.lastErrorMessage })}
                </p>
              ) : null}
            </div>
            {canManage ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setWizardOpen((value) => !value)}>
                  {wizardOpen ? t('closeWizard') : t('addSheet')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={disconnectMutation.isPending}
                  onClick={() => disconnectMutation.mutate()}
                >
                  {t('disconnect')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-slate-700">
                {t('readOnlyNote')}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {t('revokeNote')}
              </p>
            </div>
            {canManage ? (
              <Button loading={connectMutation.isPending} onClick={() => connectMutation.mutate()}>
                {t('connect')}
              </Button>
            ) : null}
          </div>
        )}
      </Card>

      {/* --- Assistant de configuration ------------------------------------ */}
      {wizardOpen && status?.connected && canManage ? (
        <SheetWizard
          onDone={() => {
            setWizardOpen(false);
            setFeedback({
              tone: 'success',
              text: t('wizard.done'),
            });
            void queryClient.invalidateQueries({ queryKey: ['integrations'] });
          }}
          onError={(text) => setFeedback({ tone: 'danger', text })}
        />
      ) : null}

      {/* --- Feuilles configurees ------------------------------------------ */}
      {status?.connected ? (
        <Card title={t('sheetsTitle')} className="mb-4" padded={false}>
          {configsQuery.isLoading ? (
            <LoadingState />
          ) : (configsQuery.data?.length ?? 0) === 0 ? (
            <EmptyState
              title={t('noSheetTitle')}
              description={t('noSheet')}
              action={
                canManage ? (
                  <Button onClick={() => setWizardOpen(true)}>{t('configureSheet')}</Button>
                ) : null
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {configsQuery.data?.map((config) => (
                <li key={config.id} className="p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-800">
                        {config.spreadsheetName ?? config.spreadsheetId}
                        <span className="ms-1.5 text-sm text-slate-500">
                          {t('sheetTab', { tab: config.sheetName })}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {t('syncEvery', { minutes: config.syncIntervalMinutes })}
                        {config.lastSuccessAt
                          ? t('lastSuccess', { when: formatRelative(config.lastSuccessAt) })
                          : t('neverSynced')}
                        {config.lastProcessedRow
                          ? t('resumeRow', { row: config.lastProcessedRow })
                          : ''}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {config.isActive ? (
                        <Badge tone="success">{t('active')}</Badge>
                      ) : (
                        <Badge tone="neutral">{t('paused')}</Badge>
                      )}
                      {config._count.rowImports > 0 ? (
                        <button
                          className="text-xs text-danger underline"
                          onClick={() =>
                            setErrorsForConfig(
                              errorsForConfig === config.id ? null : config.id,
                            )
                          }
                        >
                          {t('rowErrors', { count: config._count.rowImports })}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {config.consecutiveFailures > 0 ? (
                    <div className="mt-2">
                      <Alert tone="warning">
                        {t('consecutiveFailures', { count: config.consecutiveFailures })}
                        {config.backoffUntil
                          ? t('nextAttempt', { when: formatRelative(config.backoffUntil) })
                          : ''}
                      </Alert>
                    </div>
                  ) : null}

                  {canManage ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={syncMutation.isPending}
                        onClick={() => syncMutation.mutate(config.id)}
                      >
                        {t('syncNow')}
                      </Button>
                      {config._count.rowImports > 0 ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={retryMutation.isPending}
                          onClick={() => retryMutation.mutate(config.id)}
                        >
                          {t('retryFailed')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          toggleMutation.mutate({
                            configId: config.id,
                            isActive: !config.isActive,
                          })
                        }
                      >
                        {config.isActive ? t('pause') : t('resume')}
                      </Button>
                    </div>
                  ) : null}

                  {/* --- Journal des lignes en erreur --------------------- */}
                  {errorsForConfig === config.id ? (
                    <div className="mt-3 rounded-md border border-danger/25 bg-danger/60 p-2.5">
                      {errorsQuery.isLoading ? (
                        <LoadingState />
                      ) : (errorsQuery.data?.length ?? 0) === 0 ? (
                        <p className="text-sm text-slate-600">{t('noRowError')}</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {errorsQuery.data?.map((row) => (
                            <li key={row.id} className="text-xs">
                              <span className="tabular font-semibold text-slate-800">
                                {t('rowErrorLine', { row: row.sourceRowNumber })}
                              </span>
                              <span className="ms-1.5 text-danger">
                                {row.errorMessage ?? row.errorCode ?? t('unknownError')}
                              </span>
                              {row.retryCount > 0 ? (
                                <span className="ms-1.5 text-slate-500">
                                  {t('attempts', { count: row.retryCount })}
                                </span>
                              ) : null}
                              <p className="truncate font-mono text-slate-500">
                                {row.rawValues.join(' | ')}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-xs text-slate-500">
                        {t('retryHelp')}
                      </p>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {/* --- Historique des synchronisations -------------------------------- */}
      {status?.connected ? (
        <Card title={t('runsTitle')} padded={false}>
          {runsQuery.isLoading ? (
            <LoadingState />
          ) : (runsQuery.data?.length ?? 0) === 0 ? (
            <p className="px-3 py-4 text-sm text-slate-500">{t('noRun')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('runColumns.trigger')}</th>
                    <th>{t('runColumns.status')}</th>
                    <th className="text-end">{t('runColumns.scanned')}</th>
                    <th className="text-end">{t('runColumns.imported')}</th>
                    <th className="text-end">{t('runColumns.skipped')}</th>
                    <th className="text-end">{t('runColumns.failed')}</th>
                    <th>{t('runColumns.duration')}</th>
                    <th>{t('runColumns.when')}</th>
                  </tr>
                </thead>
                <tbody>
                  {runsQuery.data?.map((run) => (
                    <tr key={run.id}>
                      <td className="text-xs text-slate-600">{run.trigger}</td>
                      <td>
                        <Badge
                          tone={
                            run.status === 'SUCCESS'
                              ? 'success'
                              : run.status === 'PARTIAL'
                                ? 'warning'
                                : run.status === 'RUNNING'
                                  ? 'info'
                                  : 'danger'
                          }
                        >
                          {run.status}
                        </Badge>
                        {run.errorMessage ? (
                          <p
                            className="mt-0.5 max-w-[220px] truncate text-xs text-danger"
                            title={run.errorMessage}
                          >
                            {run.errorMessage}
                          </p>
                        ) : null}
                        {run.retryAfter ? (
                          <p className="text-xs text-warning">
                            {t('resumeAt', { when: formatRelative(run.retryAfter) })}
                          </p>
                        ) : null}
                      </td>
                      <td className="tabular text-end">{run.rowsScanned}</td>
                      <td className="tabular text-end text-success">{run.rowsImported}</td>
                      <td className="tabular text-end text-slate-500">{run.rowsSkipped}</td>
                      <td className="tabular text-end text-danger">{run.rowsFailed}</td>
                      <td className="tabular text-xs text-slate-500">
                        {run.durationMs === null
                          ? tCommon('none')
                          : `${Math.round(run.durationMs / 100) / 10} s`}
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatRelative(run.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}

/**
 * Assistant en quatre etapes : classeur → onglet → mapping verifie → test.
 *
 * Aucune commande n'est creee avant que le commercant ait vu l'apercu ET lance
 * un test d'import explicite.
 */
function SheetWizard({
  onDone,
  onError,
}: {
  onDone: () => void;
  onError: (text: string) => void;
}) {
  const t = useTranslations('integrations.wizard');
  const [spreadsheetId, setSpreadsheetId] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [sheetGid, setSheetGid] = useState('');
  const [headerRow, setHeaderRow] = useState('1');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [createdConfigId, setCreatedConfigId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    rowsScanned: number;
    rowsImported: number;
    rowsFailed: number;
  } | null>(null);

  const spreadsheetsQuery = useQuery({
    queryKey: ['integrations', 'google', 'spreadsheets'],
    queryFn: () => api.get<Spreadsheet[]>('/integrations/google/spreadsheets'),
  });

  const sheetsQuery = useQuery({
    queryKey: ['integrations', 'google', 'tabs', spreadsheetId],
    queryFn: () =>
      api.get<{ title: string; sheets: SheetTab[] }>(
        `/integrations/google/spreadsheets/${spreadsheetId}/sheets`,
      ),
    enabled: Boolean(spreadsheetId),
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<Preview>('/integrations/google/preview', {
        spreadsheetId,
        sheetName,
        headerRow: Number(headerRow) || 1,
        mapping: Object.keys(mapping).length > 0 ? mapping : undefined,
      }),
    onSuccess: (result) => {
      setPreview(result);
      if (Object.keys(mapping).length === 0) {
        setMapping(
          Object.fromEntries(
            Object.entries(result.suggestedMapping).map(([key, value]) => [key, String(value)]),
          ),
        );
      }
    },
    onError: (caught) => {
      onError(caught instanceof ApiError ? caught.userMessage : t('previewFailed'));
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/integrations/google/sheets', {
        spreadsheetId,
        sheetName,
        sheetGid: sheetGid || '0',
        columnMapping: mapping,
        headerRow: Number(headerRow) || 1,
      }),
    onSuccess: (result) => setCreatedConfigId(result.id),
    onError: (caught) => {
      onError(caught instanceof ApiError ? caught.userMessage : t('configRejected'));
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      api.post<{ rowsScanned: number; rowsImported: number; rowsFailed: number }>(
        `/integrations/google/sheets/${createdConfigId}/test`,
        {},
      ),
    onSuccess: setTestResult,
    onError: (caught) => {
      onError(caught instanceof ApiError ? caught.userMessage : t('testFailed'));
    },
  });

  const missingRequired = MAPPING_FIELDS.filter(
    (field) => field.required && !mapping[field.key],
  ).map((field) => t(`fields.${field.key}`));

  return (
    <Card title={t('title')} className="mb-4">
      <div className="space-y-4">
        {/* Etape 1 : classeur et onglet */}
        <section>
          <h3 className="text-sm font-semibold text-slate-800">{t('step1')}</h3>
          {spreadsheetsQuery.isLoading ? (
            <LoadingState label={t('loadingSpreadsheets')} />
          ) : spreadsheetsQuery.error ? (
            <ErrorState
              message={
                spreadsheetsQuery.error instanceof ApiError
                  ? spreadsheetsQuery.error.userMessage
                  : t('spreadsheetsFailed')
              }
              onRetry={() => void spreadsheetsQuery.refetch()}
            />
          ) : (
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <Select
                label={t('spreadsheet')}
                value={spreadsheetId}
                onChange={(event) => {
                  setSpreadsheetId(event.target.value);
                  setSheetName('');
                  setPreview(null);
                  setMapping({});
                }}
              >
                <option value="">Selectionner…</option>
                {spreadsheetsQuery.data?.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>

              <Select
                label={t('sheet')}
                value={sheetName}
                disabled={!spreadsheetId || sheetsQuery.isLoading}
                onChange={(event) => {
                  const tab = sheetsQuery.data?.sheets.find(
                    (entry) => entry.title === event.target.value,
                  );
                  setSheetName(event.target.value);
                  setSheetGid(tab ? String(tab.sheetId) : '0');
                  setPreview(null);
                  setMapping({});
                }}
              >
                <option value="">Selectionner…</option>
                {sheetsQuery.data?.sheets.map((entry) => (
                  <option key={String(entry.sheetId)} value={entry.title}>
                    {entry.title}
                  </option>
                ))}
              </Select>

              <Input
                label={t('headerRow')}
                type="number"
                min={1}
                value={headerRow}
                onChange={(event) => setHeaderRow(event.target.value)}
              />
            </div>
          )}

          <Button
            className="mt-3"
            size="sm"
            disabled={!spreadsheetId || !sheetName}
            loading={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {t('preview')}
          </Button>
        </section>

        {/* Etape 2 : mapping et apercu */}
        {preview ? (
          <>
            <section className="border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-800">
                {t('step2')}
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                {t('step2Hint')}
              </p>

              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {MAPPING_FIELDS.map((field) => (
                  <Select
                    key={field.key}
                    label={
                      field.required
                        ? `${t(`fields.${field.key}`)} *`
                        : t(`fields.${field.key}`)
                    }
                    value={mapping[field.key] ?? ''}
                    onChange={(event) =>
                      setMapping({ ...mapping, [field.key]: event.target.value })
                    }
                  >
                    <option value="">{t('noColumn')}</option>
                    {preview.headers.map((header, index) => (
                      <option key={`${header}-${index}`} value={columnLetter(index)}>
                        {columnLetter(index)} — {header || t('untitled')}
                      </option>
                    ))}
                  </Select>
                ))}
              </div>

              {missingRequired.length > 0 ? (
                <div className="mt-2">
                  <Alert tone="warning">
                    {t('missingRequired', { fields: missingRequired.join(', ') })}
                  </Alert>
                </div>
              ) : null}
            </section>

            <section className="border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-800">
                {t('step3')}
              </h3>
              <div className="mt-2 overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('previewColumns.row')}</th>
                      <th>{t('previewColumns.customer')}</th>
                      <th>{t('previewColumns.phone')}</th>
                      <th>{t('previewColumns.wilaya')}</th>
                      <th>{t('previewColumns.product')}</th>
                      <th className="text-end">{t('previewColumns.quantity')}</th>
                      <th>{t('previewColumns.result')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sampleRows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="tabular text-xs text-slate-500">{row.rowNumber}</td>
                        <td className="text-sm">{cell(row.parsed?.client)}</td>
                        <td className="tabular text-sm">{cell(row.parsed?.telephone)}</td>
                        <td className="text-sm">{cell(row.parsed?.wilaya)}</td>
                        <td className="text-sm">
                          {cell(row.parsed?.produit ?? row.parsed?.sku)}
                        </td>
                        <td className="tabular text-end text-sm">
                          {cell(row.parsed?.quantite)}
                        </td>
                        <td>
                          {row.error ? (
                            <span className="text-xs text-danger">{row.error.message}</span>
                          ) : (
                            <Badge tone="success">{t('understood')}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Button
                className="mt-3"
                size="sm"
                disabled={missingRequired.length > 0 || createdConfigId !== null}
                loading={createMutation.isPending}
                onClick={() => createMutation.mutate()}
              >
                {t('saveConfig')}
              </Button>
            </section>
          </>
        ) : null}

        {/* Etape 3 : test d'import */}
        {createdConfigId ? (
          <section className="border-t border-slate-200 pt-4">
            <h3 className="text-sm font-semibold text-slate-800">{t('step4')}</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {t('step4Hint')}
            </p>

            <Button
              className="mt-2"
              size="sm"
              variant="secondary"
              loading={testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              {t('runTest')}
            </Button>

            {testResult ? (
              <div className="mt-2">
                <Alert tone={testResult.rowsFailed > 0 ? 'warning' : 'success'}>
                  {t('testResult', {
                    scanned: testResult.rowsScanned,
                    imported: testResult.rowsImported,
                    failed: testResult.rowsFailed,
                  })}
                </Alert>
              </div>
            ) : null}

            <Button className="mt-3" size="sm" onClick={onDone}>
              {t('finish')}
            </Button>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Affiche une valeur interpretee par le serveur.
 *
 * L'apercu renvoie un objet libre : une valeur inattendue ne doit pas
 * s'afficher « [object Object] » dans un ecran dont l'unique but est de
 * montrer au commercant ce qu'EcomFlow a compris de sa feuille.
 */
function cell(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value.length > 0 ? value : '—';
    case 'number':
      return Number.isFinite(value) ? String(value) : '—';
    case 'boolean':
      return value ? 'oui' : 'non';
    default:
      return '—';
  }
}

/** Convertit un index de colonne 0-base en lettre de tableur (0 → A, 26 → AA). */
function columnLetter(index: number): string {
  let result = '';
  let current = index;
  while (current >= 0) {
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26) - 1;
  }
  return result;
}
