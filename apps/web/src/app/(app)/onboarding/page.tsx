'use client';

/**
 * Assistant de mise en route — Addendum §34.
 *
 * OBJECTIF DECLARE PAR LE CAHIER DES CHARGES : a la fin de ce parcours, la
 * boutique doit pouvoir recevoir sa premiere commande reelle sans aucun
 * support technique.
 *
 * L'ETAT AFFICHE EST VERIFIE, PAS DECLARE.
 *   Le serveur ne lit pas une case cochee : il verifie reellement en base que
 *   le jeton Google existe, que le mapping est complet, qu'un import de test a
 *   abouti. Si un jeton est revoque, l'etape redevient « a faire ». Un
 *   assistant qui affiche « fait » alors que rien ne fonctionne est pire que
 *   pas d'assistant du tout.
 *
 * LES ETAPES FACULTATIVES SONT MONTREES COMME TELLES.
 *   Transporteur et WhatsApp ameliorent l'exploitation mais n'empechent pas de
 *   recevoir une commande. Les presenter comme obligatoires ferait abandonner
 *   des commercants qui pouvaient deja demarrer.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/app-shell';
import { Alert, Badge, Button, Card, ErrorState, LoadingState } from '@/components/ui';

interface StepState {
  readonly step: string;
  readonly label: string;
  readonly done: boolean;
  readonly required: boolean;
  readonly hint: string | null;
}

interface OnboardingState {
  readonly currentStep: string;
  readonly completed: boolean;
  readonly progressPercent: number;
  readonly steps: readonly StepState[];
  readonly readyForFirstOrder: boolean;
}

/** Ou envoyer le commercant pour franchir chaque etape. Le libelle du bouton
 *  vient du catalogue (`onboarding.actions.<etape>`). */
const STEP_HREFS: Record<string, string | undefined> = {
  ORDER_SOURCE_CONNECTED: '/integrations',
  COLUMN_MAPPING_CONFIGURED: '/integrations',
  TEST_IMPORT_PASSED: '/integrations',
  CARRIER_CONFIGURED: '/expeditions',
  WHATSAPP_CONFIGURED: '/parametres',
};

export default function OnboardingPage() {
  const t = useTranslations('onboarding');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['onboarding', 'state'],
    queryFn: () => api.get<OnboardingState>('/onboarding/state'),
  });

  const completeMutation = useMutation({
    mutationFn: () => api.post('/onboarding/complete', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      router.push('/');
    },
    onError: (caught) => {
      setFeedback(
        caught instanceof ApiError
          ? caught.userMessage
          : t('activateFailed'),
      );
    },
  });

  if (isLoading) return <LoadingState label={t('checking')} />;

  if (error) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.userMessage : tCommon('loadFailed')}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!data) return null;

  const required = data.steps.filter((step) => step.required);
  const optional = data.steps.filter((step) => !step.required);
  const missing = required.filter((step) => !step.done);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <Link href="/">
            <span className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700">
              {t('skip')}
            </span>
          </Link>
        }
      />

      {feedback ? (
        <div className="mb-3">
          <Alert tone="danger">{feedback}</Alert>
        </div>
      ) : null}

      {data.completed ? (
        <div className="mb-4">
          <Alert tone="success" title={t('completeTitle')}>
            {t('complete')}
          </Alert>
        </div>
      ) : null}

      {/* --- Progression --------------------------------------------------- */}
      <Card className="mb-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-slate-800">
            {t('progress', {
              done: required.filter((step) => step.done).length,
              total: required.length,
            })}
          </p>
          <span className="tabular text-sm font-semibold text-brand-700">
            {data.progressPercent} %
          </span>
        </div>
        <div className="mt-2 h-2 w-full rounded-full bg-slate-100">
          <div
            className="h-2 rounded-full bg-brand-600 transition-all"
            style={{ width: `${data.progressPercent}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-slate-500">{t('progressNote')}</p>
      </Card>

      {/* --- Etapes obligatoires -------------------------------------------- */}
      <Card title={t('requiredTitle')} className="mb-4" padded={false}>
        <ol className="divide-y divide-slate-100">
          {required.map((step, index) => (
            <StepRow key={step.step} step={step} index={index + 1} />
          ))}
        </ol>
      </Card>

      {/* --- Etapes facultatives -------------------------------------------- */}
      <Card
        title={t('optionalTitle')}
        className="mb-4"
        padded={false}
        footer={
          <p className="text-xs text-slate-500">{t('optionalNote')}</p>
        }
      >
        <ol className="divide-y divide-slate-100">
          {optional.map((step, index) => (
            <StepRow key={step.step} step={step} index={required.length + index + 1} />
          ))}
        </ol>
      </Card>

      {/* --- Activation ------------------------------------------------------ */}
      {!data.completed ? (
        <Card title={t('activateTitle')}>
          {data.readyForFirstOrder ? (
            <>
              <p className="text-sm text-slate-700">{t('ready')}</p>
              <Button
                className="mt-3"
                loading={completeMutation.isPending}
                onClick={() => completeMutation.mutate()}
              >
                {t('activate')}
              </Button>
            </>
          ) : (
            <Alert tone="warning" title={t('missingTitle')}>
              <p className="text-sm">{t('missing')}</p>
              <ul className="mt-1.5 list-disc ps-5 text-sm">
                {missing.map((step) => (
                  <li key={step.step}>
                    {t(`steps.${step.step}`)}
                    {step.hint ? (
                      <span className="block text-xs opacity-80">{step.hint}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
        </Card>
      ) : null}
    </>
  );
}

function StepRow({ step, index }: { step: StepState; index: number }) {
  const t = useTranslations('onboarding');
  const href = STEP_HREFS[step.step];

  return (
    <li className="flex items-start gap-3 p-3">
      <span
        className={
          step.done
            ? 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-xs font-semibold text-white'
            : 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600'
        }
      >
        {step.done ? '✓' : index}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-800">
          {t(`steps.${step.step}`)}
          {step.required ? null : (
            <Badge tone="neutral" className="ms-1.5">
              {t('optional')}
            </Badge>
          )}
        </p>
        {!step.done && step.hint ? (
          <p className="mt-0.5 text-xs text-slate-600">{step.hint}</p>
        ) : null}
      </div>

      {!step.done && href ? (
        <Link href={href}>
          <span className="inline-flex h-8 shrink-0 items-center rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            {t(`actions.${step.step}`)}
          </span>
        </Link>
      ) : null}
    </li>
  );
}
