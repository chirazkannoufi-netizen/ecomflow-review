'use client';

/**
 * Centre de confirmation telephonique — V1 §9, V2 §11.
 *
 * ECRAN LE PLUS UTILISE DU PRODUIT.
 *   Un agent y passe sa journee. Trois choix en decoulent :
 *
 *   1. UNE SEULE VUE. La fiche de la commande en cours et la file sont
 *      cote a cote : aucun aller-retour entre deux ecrans.
 *   2. RACCOURCIS CLAVIER. Les cinq actions rapides sont accessibles au
 *      clavier ; sur cinquante appels par jour, cela represente plusieurs
 *      minutes gagnees et beaucoup moins de fatigue.
 *   3. LE CLIENT AVANT LA COMMANDE. Score de fiabilite, historique et notes
 *      sont visibles immediatement : l'agent sait a qui il parle avant de
 *      composer le numero.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatCentimes, getWilayaByCode } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
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
  ReliabilityBadge,
  StatusBadge,
  Textarea,
  formatRelative,
} from '@/components/ui';

interface QueueItem {
  readonly orderId: string;
  readonly reference: string;
  readonly status: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly address: string | null;
  readonly totalCentimes: number;
  readonly deliveryFeeCentimes: number;
  readonly items: readonly {
    sku: string;
    productName: string;
    quantity: number;
    unitPriceCentimes: number;
  }[];
  readonly notes: string | null;
  readonly callAttemptsCount: number;
  readonly nextCallbackAt: string | null;
  readonly assigneeName: string | null;
  readonly createdAt: string;
  readonly reliabilityScore: number | null;
  readonly reliabilityTier: string;
  readonly confirmationChannel: string;
  readonly whatsappState: string;
  readonly pendingDuplicateFlags: number;
}

interface QueueStats {
  readonly total: number;
  readonly dueNow: number;
  readonly scheduled: number;
  readonly unassigned: number;
  readonly byStatus: Record<string, number>;
}

type Action = 'CONFIRM' | 'CALL_BACK' | 'POSTPONE' | 'NO_ANSWER' | 'CANCEL' | 'WRONG_NUMBER';

/** Actions rapides, avec leur raccourci clavier. */
const ACTIONS: readonly {
  action: Action;
  shortcut: string;
  variant: 'success' | 'secondary' | 'danger' | 'ghost';
  needsReason?: boolean;
  needsCallback?: boolean;
}[] = [
  { action: 'CONFIRM', shortcut: 'C', variant: 'success' },
  { action: 'CALL_BACK', shortcut: 'R', variant: 'secondary', needsCallback: true },
  { action: 'POSTPONE', shortcut: 'P', variant: 'secondary', needsCallback: true },
  { action: 'NO_ANSWER', shortcut: 'S', variant: 'ghost' },
  { action: 'WRONG_NUMBER', shortcut: 'N', variant: 'ghost' },
  { action: 'CANCEL', shortcut: 'A', variant: 'danger', needsReason: true },
];

export default function ConfirmationPage() {
  const t = useTranslations('confirmation');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('orderStatus');
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null,
  );

  const queueQuery = useQuery({
    queryKey: ['confirmation', 'queue'],
    queryFn: () =>
      api.get<{ data: QueueItem[]; meta: { total: number } }>('/confirmation/queue', {
        query: { pageSize: 50, dueOnly: true },
      }),
    // La file bouge en permanence : les imports arrivent, les collegues
    // traitent. Un rafraichissement regulier evite de travailler sur une
    // commande deja prise en charge.
    refetchInterval: 30_000,
  });

  const statsQuery = useQuery({
    queryKey: ['confirmation', 'stats'],
    queryFn: () => api.get<QueueStats>('/confirmation/queue/stats'),
    refetchInterval: 30_000,
  });

  const queue = queueQuery.data?.data ?? [];
  const selected = queue.find((entry) => entry.orderId === selectedId) ?? queue[0] ?? null;

  // Selectionne automatiquement la premiere commande de la file.
  useEffect(() => {
    if (!selectedId && queue.length > 0) setSelectedId(queue[0]?.orderId ?? null);
  }, [queue, selectedId]);

  const actionMutation = useMutation({
    mutationFn: (payload: { orderId: string; action: Action }) =>
      api.post<{ to: string; attemptNumber: number; maxAttemptsReached: boolean }>(
        `/confirmation/orders/${payload.orderId}/action`,
        {
          action: payload.action,
          note: note.trim() || undefined,
          reason: reason.trim() || undefined,
          callbackAt: callbackAt ? new Date(callbackAt).toISOString() : undefined,
        },
      ),
    onSuccess: (result, variables) => {
      setFeedback({
        tone: 'success',
        message: t('actionDone', {
          status: tStatus(result.to),
          attempt: result.attemptNumber,
        }),
      });
      setNote('');
      setReason('');
      setCallbackAt('');

      // On avance vers la commande suivante : l'agent enchaine sans clic
      // supplementaire.
      const index = queue.findIndex((entry) => entry.orderId === variables.orderId);
      setSelectedId(queue[index + 1]?.orderId ?? null);

      void queryClient.invalidateQueries({ queryKey: ['confirmation'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => {
      setFeedback({
        tone: 'danger',
        message: error instanceof ApiError ? error.userMessage : tCommon('actionFailed'),
      });
    },
  });

  const runAction = useCallback(
    (action: Action) => {
      if (!selected) return;

      const config = ACTIONS.find((entry) => entry.action === action);
      if (config?.needsReason && !reason.trim()) {
        setFeedback({
          tone: 'danger',
          message: t('cancelReasonRequired'),
        });
        return;
      }

      actionMutation.mutate({ orderId: selected.orderId, action });
    },
    [selected, reason, actionMutation],
  );

  // Raccourcis clavier — desactives des qu'un champ de saisie a le focus,
  // sinon taper « c » dans une note declencherait une confirmation.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const config = ACTIONS.find(
        (entry) => entry.shortcut.toLowerCase() === event.key.toLowerCase(),
      );
      if (config) {
        event.preventDefault();
        runAction(config.action);
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [runAction]);

  if (queueQuery.isLoading) return <LoadingState label={t('loadingQueue')} />;

  if (queueQuery.error) {
    return (
      <ErrorState
        message={
          queueQuery.error instanceof ApiError
            ? queueQuery.error.userMessage
            : tCommon('loadFailed')
        }
        onRetry={() => void queueQuery.refetch()}
      />
    );
  }

  const stats = statsQuery.data;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          stats ? (
            <div className="flex gap-2">
              <Badge tone="warning">{stats.dueNow} a traiter</Badge>
              {stats.scheduled > 0 ? (
                <Badge tone="neutral">{stats.scheduled} rappel(s) programme(s)</Badge>
              ) : null}
            </div>
          ) : null
        }
      />

      {feedback ? (
        <div className="mb-3">
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>
            {feedback.message}
          </Alert>
        </div>
      ) : null}

      {queue.length === 0 ? (
        <Card>
          <EmptyState
            title={t('queueEmpty')}
            description={t('queueEmptyHint')}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          {/* --- Fiche de la commande en cours ---------------------------- */}
          {selected ? (
            <div className="space-y-3">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-mono text-base font-semibold text-slate-900">
                        {selected.reference}
                      </h2>
                      <StatusBadge status={selected.status} />
                      {selected.confirmationChannel === 'WHATSAPP_AUTO' ? (
                        <Badge tone="info">WhatsApp</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {t('receivedAgo', { when: formatRelative(selected.createdAt) })}
                      {selected.callAttemptsCount > 0
                        ? ` — ${t('attempts', { count: selected.callAttemptsCount })}`
                        : ''}
                    </p>
                  </div>
                  <Money centimes={selected.totalCentimes} bold className="text-lg" />
                </div>

                {selected.pendingDuplicateFlags > 0 ? (
                  <div className="mt-3">
                    <Alert tone="warning" title={t('duplicateTitle')}>
                      {t('duplicateBody', { count: selected.pendingDuplicateFlags })}
                    </Alert>
                  </div>
                ) : null}

                {selected.whatsappState === 'HANDED_OVER' ||
                selected.whatsappState === 'NO_RESPONSE' ? (
                  <div className="mt-3">
                    <Alert tone="info">
                      {t('whatsappHandover')}
                    </Alert>
                  </div>
                ) : null}

                {/* --- Client --- */}
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {tCommon('customer')}
                    </p>
                    <p className="mt-1 text-base font-medium text-slate-900">
                      {selected.customerName}
                    </p>
                    <a
                      href={`tel:${selected.phone}`}
                      className="tabular mt-0.5 block text-lg font-semibold text-brand-700 hover:underline"
                    >
                      {selected.phone}
                    </a>
                    <div className="mt-2">
                      <ReliabilityBadge
                        tier={selected.reliabilityTier}
                        score={selected.reliabilityScore}
                      />
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {t('deliverySection')}
                    </p>
                    <p className="mt-1 text-sm text-slate-900">
                      {selected.wilayaCode
                        ? `${selected.wilayaCode} — ${getWilayaByCode(selected.wilayaCode)?.name ?? ''}`
                        : tCommon('none')}
                    </p>
                    <p className="text-sm text-slate-700">
                      {selected.commune ?? tCommon('none')}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-600">
                      {selected.address ?? tCommon('none')}
                    </p>
                  </div>
                </div>

                {/* --- Articles --- */}
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t('orderItems')}
                  </p>
                  <ul className="mt-1 divide-y divide-slate-100 rounded-md border border-slate-200">
                    {selected.items.map((item) => (
                      <li
                        key={item.sku}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-800">{item.productName}</p>
                          <p className="font-mono text-xs text-slate-500">{item.sku}</p>
                        </div>
                        <div className="shrink-0 text-end">
                          <p className="tabular text-slate-700">
                            {item.quantity} × {formatCentimes(item.unitPriceCentimes)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex justify-between text-sm">
                    <span className="text-slate-600">{t('deliveryFee')}</span>
                    <Money centimes={selected.deliveryFeeCentimes} />
                  </div>
                  <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 text-sm font-semibold">
                    <span>{t('totalDue')}</span>
                    <Money centimes={selected.totalCentimes} bold />
                  </div>
                </div>

                {selected.notes ? (
                  <div className="mt-4 rounded-md bg-slate-50 px-3 py-2">
                    <p className="text-xs font-semibold text-slate-500">{t('orderNote')}</p>
                    <p className="mt-0.5 text-sm text-slate-700">{selected.notes}</p>
                  </div>
                ) : null}
              </Card>

              {/* --- Actions rapides --- */}
              <Card title={t('callResult')}>
                <div className="space-y-3">
                  <Textarea
                    label={t('noteLabel')}
                    placeholder={t('notePlaceholder')}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    rows={2}
                  />

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      label={t('callbackAt')}
                      type="datetime-local"
                      value={callbackAt}
                      onChange={(event) => setCallbackAt(event.target.value)}
                      hint={t('callbackHint')}
                    />
                    <Input
                      label={t('reasonLabel')}
                      placeholder={t('reasonPlaceholder')}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {ACTIONS.map((entry) => (
                      <Button
                        key={entry.action}
                        variant={entry.variant}
                        loading={
                          actionMutation.isPending &&
                          actionMutation.variables?.action === entry.action
                        }
                        disabled={actionMutation.isPending}
                        onClick={() => runAction(entry.action)}
                      >
                        {t(`actions.${entry.action}`)}
                        <kbd className="ms-1 rounded border border-current/30 px-1 text-[10px] opacity-70">
                          {entry.shortcut}
                        </kbd>
                      </Button>
                    ))}
                  </div>

                  <p className="text-xs text-slate-500">
                    {t('shortcutsHint')}
                  </p>
                </div>
              </Card>
            </div>
          ) : null}

          {/* --- File d'attente ------------------------------------------- */}
          <Card title={t('queueTitle', { count: queue.length })} padded={false} className="h-fit">
            <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
              {queue.map((entry) => (
                <li key={entry.orderId}>
                  <button
                    onClick={() => setSelectedId(entry.orderId)}
                    className={
                      entry.orderId === selected?.orderId
                        ? 'w-full bg-brand-50 px-3 py-2.5 text-start'
                        : 'w-full px-3 py-2.5 text-start hover:bg-slate-50'
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-slate-500">{entry.reference}</span>
                      <StatusBadge status={entry.status} />
                    </div>
                    <p className="mt-0.5 truncate text-sm font-medium text-slate-800">
                      {entry.customerName}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <ReliabilityBadge
                        tier={entry.reliabilityTier}
                        score={entry.reliabilityScore}
                      />
                      <Money centimes={entry.totalCentimes} className="text-xs text-slate-600" />
                    </div>
                    {entry.nextCallbackAt ? (
                      <p className="mt-1 text-xs text-warning">
                        {t('callbackAtWhen', { when: formatRelative(entry.nextCallbackAt) })}
                      </p>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
