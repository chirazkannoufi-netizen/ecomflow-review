'use client';

/**
 * Parametres de la boutique — V2 §8, Addendum §31/§32/§33.
 *
 * AUCUN SEUIL N'EST CODE EN DUR.
 *   Le nombre de tentatives d'appel, le seuil de stock bas, la fenetre de
 *   detection de doublons, les paliers de fiabilite, le delai du filtre
 *   WhatsApp : tout est ici. Une regle metier figee dans le code obligerait a
 *   redeployer pour un ajustement qui releve du commercant.
 *
 * CHAQUE REGLAGE EST EXPLIQUE PAR SA CONSEQUENCE.
 *   « Autoriser la survente » n'est pas une case a cocher anodine. L'ecran dit
 *   ce que le reglage change concretement, y compris ce qu'il fait perdre.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABELS, RELIABILITY_ACTIONS } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Alert, Button, Card, ErrorState, Input, LoadingState, Select } from '@/components/ui';

interface Settings {
  readonly defaultLocale: string;
  readonly customerMessageLocale: string | null;
  readonly lowStockThreshold: number;
  readonly reserveStockOnConfirm: boolean;
  readonly allowOversell: boolean;
  readonly maxCallAttempts: number;
  readonly defaultCallbackDelayHours: number;
  readonly whatsappFilterEnabled: boolean;
  readonly whatsappTimeoutHours: number;
  readonly whatsappMaxAmountCentimes: number | null;
  readonly reliabilityEnabled: boolean;
  readonly reliabilityMinHistory: number;
  readonly reliabilityReliableThreshold: number;
  readonly reliabilityWatchThreshold: number;
  readonly reliabilityFailureLimit: number;
  readonly reliabilityAtRiskActions: readonly string[];
  readonly duplicateWindowHours: number;
  readonly duplicateAlertScore: number;
  readonly duplicateLikelyScore: number;
  readonly defaultCarrierCostCentimes: number;
  readonly returnRateAlertPercent: number | null;
}

interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly logoUrl: string | null;
}

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const tLang = useTranslations('language');
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<Settings | null>(null);
  const [storeName, setStoreName] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/tenants/settings'),
  });

  const tenantQuery = useQuery({
    queryKey: ['tenants', 'current'],
    queryFn: () => api.get<{ tenant: Tenant | null }>('/tenants/current'),
  });

  useEffect(() => {
    if (settingsQuery.data && draft === null) setDraft(settingsQuery.data);
  }, [settingsQuery.data, draft]);

  const saveMutation = useMutation({
    mutationFn: (payload: Partial<Settings>) => api.patch('/tenants/settings', payload),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: t('saved') });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('saveFailed'),
      });
    },
  });

  const tenantMutation = useMutation({
    mutationFn: (payload: { name: string }) => api.patch('/tenants/current', payload),
    onSuccess: () => {
      setStoreName(null);
      setFeedback({ tone: 'success', text: t('nameUpdated') });
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('nameFailed'),
      });
    },
  });

  if (settingsQuery.isLoading || !draft) {
    if (settingsQuery.error) {
      return (
        <ErrorState
          message={
            settingsQuery.error instanceof ApiError
              ? settingsQuery.error.userMessage
              : tCommon('loadFailed')
          }
          onRetry={() => void settingsQuery.refetch()}
        />
      );
    }
    return <LoadingState />;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settingsQuery.data);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  const tenant = tenantQuery.data?.tenant ?? null;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          dirty ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(settingsQuery.data ?? null)}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                size="sm"
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate(draft)}
              >
                {tCommon('save')}
              </Button>
            </>
          ) : null
        }
      />

      {feedback ? (
        <div className="mb-3">
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.text}</Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Identite --------------------------------------------------- */}
        <Card title={t('storeTitle')}>
          <Input
            label={t('storeName')}
            value={storeName ?? tenant?.name ?? ''}
            onChange={(event) => setStoreName(event.target.value)}
            hint={t('storeNameHint')}
          />
          <p className="mt-1.5 text-xs text-slate-500">
            {t('slugNote', { slug: tenant?.slug ?? tCommon('none') })}
          </p>
          {storeName !== null && storeName !== tenant?.name ? (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                loading={tenantMutation.isPending}
                onClick={() => tenantMutation.mutate({ name: storeName })}
              >
                {t('saveName')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStoreName(null)}>
                {tCommon('cancel')}
              </Button>
            </div>
          ) : null}
        </Card>

        {/* --- Langues ----------------------------------------------------- */}
        <Card title={t('languageTitle')}>
          <div className="space-y-3">
            <Select
              label={t('defaultLocale')}
              hint={t('defaultLocaleHint')}
              value={draft.defaultLocale}
              onChange={(event) => set('defaultLocale', event.target.value)}
            >
              {LOCALES.map((entry) => (
                <option key={entry} value={entry}>
                  {LOCALE_LABELS[entry]}
                </option>
              ))}
            </Select>

            <Select
              label={t('customerLocale')}
              hint={t('customerLocaleHint')}
              value={draft.customerMessageLocale ?? ''}
              onChange={(event) =>
                // Chaine vide = suivre la langue de chaque client. C'est le
                // defaut, et le meilleur : on ecrit a chacun dans sa langue.
                set('customerMessageLocale', event.target.value === '' ? null : event.target.value)
              }
            >
              <option value="">{t('customerLocaleAuto')}</option>
              {LOCALES.map((entry) => (
                <option key={entry} value={entry}>
                  {LOCALE_LABELS[entry]}
                </option>
              ))}
            </Select>

            <div className="border-t border-slate-200 pt-3">
              <p className="text-xs font-medium text-slate-600">{tLang('label')}</p>
              <p className="mb-1.5 text-xs text-slate-500">{t('myLanguageHint')}</p>
              <LanguageSwitcher />
            </div>
          </div>
        </Card>

        {/* --- Stock ------------------------------------------------------ */}
        <Card title={t('stockTitle')}>
          <div className="space-y-3">
            <Input
              label={t('lowStockThreshold')}
              type="number"
              min={0}
              value={draft.lowStockThreshold}
              onChange={(event) => set('lowStockThreshold', Number(event.target.value))}
              hint={t('lowStockHint')}
            />

            <Toggle
              label={t('reserveOnConfirm')}
              checked={draft.reserveStockOnConfirm}
              onChange={(value) => set('reserveStockOnConfirm', value)}
              hint={t('reserveOnConfirmHint')}
            />

            <Toggle
              label={t('allowOversell')}
              checked={draft.allowOversell}
              onChange={(value) => set('allowOversell', value)}
              tone={draft.allowOversell ? 'warning' : 'default'}
              hint={t('allowOversellHint')}
            />
          </div>
        </Card>

        {/* --- Confirmation ----------------------------------------------- */}
        <Card title={t('confirmationTitle')}>
          <div className="space-y-3">
            <Input
              label={t('maxCallAttempts')}
              type="number"
              min={1}
              max={10}
              value={draft.maxCallAttempts}
              onChange={(event) => set('maxCallAttempts', Number(event.target.value))}
              hint={t('maxCallAttemptsHint')}
            />
            <Input
              label={t('callbackDelay')}
              type="number"
              min={1}
              max={168}
              value={draft.defaultCallbackDelayHours}
              onChange={(event) => set('defaultCallbackDelayHours', Number(event.target.value))}
              hint={t('callbackDelayHint')}
            />
          </div>
        </Card>

        {/* --- WhatsApp ---------------------------------------------------- */}
        <Card title={t('whatsappTitle')}>
          <div className="space-y-3">
            <Toggle
              label={t('whatsappEnabled')}
              checked={draft.whatsappFilterEnabled}
              onChange={(value) => set('whatsappFilterEnabled', value)}
              hint={t('whatsappEnabledHint')}
            />
            <Input
              label={t('whatsappTimeout')}
              type="number"
              min={1}
              max={72}
              disabled={!draft.whatsappFilterEnabled}
              value={draft.whatsappTimeoutHours}
              onChange={(event) => set('whatsappTimeoutHours', Number(event.target.value))}
              hint={t('whatsappTimeoutHint')}
            />
            <Input
              label={t('whatsappMaxAmount')}
              type="number"
              min={0}
              disabled={!draft.whatsappFilterEnabled}
              value={
                draft.whatsappMaxAmountCentimes === null
                  ? ''
                  : Math.round(draft.whatsappMaxAmountCentimes / 100)
              }
              onChange={(event) =>
                set(
                  'whatsappMaxAmountCentimes',
                  event.target.value === '' ? null : Number(event.target.value) * 100,
                )
              }
              hint={t('whatsappMaxAmountHint')}
            />
          </div>
        </Card>

        {/* --- Fiabilite --------------------------------------------------- */}
        <Card title={t('reliabilityTitle')}>
          <div className="space-y-3">
            <Toggle
              label={t('reliabilityEnabled')}
              checked={draft.reliabilityEnabled}
              onChange={(value) => set('reliabilityEnabled', value)}
              hint={t('reliabilityEnabledHint')}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={t('minHistory')}
                type="number"
                min={1}
                max={20}
                disabled={!draft.reliabilityEnabled}
                value={draft.reliabilityMinHistory}
                onChange={(event) => set('reliabilityMinHistory', Number(event.target.value))}
                hint={t('minHistoryHint')}
              />
              <Input
                label={t('failureLimit')}
                type="number"
                min={1}
                max={10}
                disabled={!draft.reliabilityEnabled}
                value={draft.reliabilityFailureLimit}
                onChange={(event) => set('reliabilityFailureLimit', Number(event.target.value))}
              />
              <Input
                label={t('reliableThreshold')}
                type="number"
                min={0}
                max={100}
                disabled={!draft.reliabilityEnabled}
                value={draft.reliabilityReliableThreshold}
                onChange={(event) =>
                  set('reliabilityReliableThreshold', Number(event.target.value))
                }
              />
              <Input
                label={t('watchThreshold')}
                type="number"
                min={0}
                max={100}
                disabled={!draft.reliabilityEnabled}
                value={draft.reliabilityWatchThreshold}
                onChange={(event) => set('reliabilityWatchThreshold', Number(event.target.value))}
                error={
                  draft.reliabilityWatchThreshold >= draft.reliabilityReliableThreshold
                    ? t('watchBelowReliable')
                    : null
                }
              />
            </div>

            <fieldset disabled={!draft.reliabilityEnabled}>
              <legend className="text-xs font-medium text-slate-600">
                {t('atRiskActions')}
              </legend>
              <div className="mt-1 space-y-1">
                {RELIABILITY_ACTIONS.map((action) => (
                  <label key={action} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={draft.reliabilityAtRiskActions.includes(action)}
                      onChange={(event) =>
                        set(
                          'reliabilityAtRiskActions',
                          event.target.checked
                            ? [...draft.reliabilityAtRiskActions, action]
                            : draft.reliabilityAtRiskActions.filter((entry) => entry !== action),
                        )
                      }
                    />
                    <span className="text-slate-700">
                      {t(`atRiskActionLabels.${action}`)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {t('atRiskNote')}
              </p>
            </fieldset>
          </div>
        </Card>

        {/* --- Doublons ---------------------------------------------------- */}
        <Card title={t('duplicatesTitle')}>
          <div className="space-y-3">
            <Input
              label={t('duplicateWindow')}
              type="number"
              min={1}
              max={720}
              value={draft.duplicateWindowHours}
              onChange={(event) => set('duplicateWindowHours', Number(event.target.value))}
              hint={t('duplicateWindowHint')}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={t('duplicateAlertScore')}
                type="number"
                min={0}
                max={100}
                value={draft.duplicateAlertScore}
                onChange={(event) => set('duplicateAlertScore', Number(event.target.value))}
                hint={t('duplicateAlertHint')}
              />
              <Input
                label={t('duplicateLikelyScore')}
                type="number"
                min={0}
                max={100}
                value={draft.duplicateLikelyScore}
                onChange={(event) => set('duplicateLikelyScore', Number(event.target.value))}
                error={
                  draft.duplicateLikelyScore <= draft.duplicateAlertScore
                    ? t('likelyAboveAlert')
                    : null
                }
              />
            </div>
            <Alert tone="info">
              {t('duplicateNote')}
            </Alert>
          </div>
        </Card>

        {/* --- Rentabilite -------------------------------------------------- */}
        <Card title={t('profitabilityTitle')}>
          <div className="space-y-3">
            <Input
              label={t('defaultCarrierCost')}
              type="number"
              min={0}
              value={Math.round(draft.defaultCarrierCostCentimes / 100)}
              onChange={(event) =>
                set('defaultCarrierCostCentimes', Number(event.target.value) * 100)
              }
              hint={t('defaultCarrierCostHint')}
            />
            <Input
              label={t('returnRateAlert')}
              type="number"
              min={0}
              max={100}
              value={draft.returnRateAlertPercent ?? ''}
              onChange={(event) =>
                set(
                  'returnRateAlertPercent',
                  event.target.value === '' ? null : Number(event.target.value),
                )
              }
              hint={t('returnRateAlertHint')}
            />
          </div>
        </Card>
      </div>

      {dirty ? (
        <div className="sticky bottom-4 mt-4 flex justify-end">
          <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 shadow-panel">
            <span className="text-sm text-slate-600">{tCommon('unsavedChanges')}</span>
            <Button size="sm" variant="ghost" onClick={() => setDraft(settingsQuery.data ?? null)}>
              {tCommon('cancel')}
            </Button>
            <Button
              size="sm"
              loading={saveMutation.isPending}
              onClick={() => saveMutation.mutate(draft)}
            >
              {tCommon('save')}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
  tone = 'default',
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span
          className={
            tone === 'warning' && checked
              ? 'text-sm font-medium text-warning'
              : 'text-sm font-medium text-slate-800'
          }
        >
          {label}
        </span>
        {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
      </span>
    </label>
  );
}
