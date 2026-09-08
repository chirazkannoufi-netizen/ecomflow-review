'use client';

/**
 * Definition d'un nouveau mot de passe a partir du lien recu.
 *
 * Le jeton arrive dans l'URL. Il n'est jamais affiche ni conserve : il sert a
 * un seul appel, puis le serveur l'invalide. Les regles de robustesse sont
 * rappelees et verifiees localement pour eviter un aller-retour inutile, mais
 * c'est le serveur qui tranche.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ApiError, api } from '@/lib/api-client';
import { Alert, Button, Input, LoadingState } from '@/components/ui';

/** Doit rester aligne sur PASSWORD_PATTERN cote serveur. */
const RULES: readonly { key: string; test: (value: string) => boolean }[] = [
  { key: 'length', test: (value) => value.length >= 12 },
  { key: 'upper', test: (value) => /[A-Z]/.test(value) },
  { key: 'lower', test: (value) => /[a-z]/.test(value) },
  { key: 'digit', test: (value) => /\d/.test(value) },
];

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const t = useTranslations('auth.reset');
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const satisfied = RULES.filter((rule) => rule.test(password)).length;
  const strong = satisfied === RULES.length;
  const matches = password.length > 0 && password === confirmation;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!strong) {
      setError(t('weak'));
      return;
    }
    if (!matches) {
      setError(t('mismatchLong'));
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/auth/reset-password', { token, password }, { anonymous: true });
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.userMessage
          : t('failed'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white">
            E
          </div>
          <h1 className="text-xl font-semibold text-slate-900">{t('title')}</h1>
        </div>

        {!token ? (
          <div className="card space-y-3 p-5">
            <Alert tone="danger" title={t('missingTokenTitle')}>
              {t('missingToken')}
            </Alert>
            <Link href="/mot-de-passe-oublie">
              <span className="block text-center text-sm text-brand-700 hover:underline">
                {t('requestNew')}
              </span>
            </Link>
          </div>
        ) : done ? (
          <div className="card space-y-3 p-5">
            <Alert tone="success" title={t('doneTitle')}>
              {t('done')}
            </Alert>
            <Button className="w-full" onClick={() => router.push('/connexion')}>
              {t('goToLogin')}
            </Button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="card space-y-4 p-5">
            {error ? <Alert tone="danger">{error}</Alert> : null}

            <Input
              label={t('newPassword')}
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            <ul className="space-y-0.5">
              {RULES.map((rule) => {
                const ok = rule.test(password);
                return (
                  <li
                    key={rule.key}
                    className={ok ? 'text-xs text-success' : 'text-xs text-slate-500'}
                  >
                    {ok ? '✓' : '○'} {t(`rules.${rule.key}`)}
                  </li>
                );
              })}
            </ul>

            <Input
              label={t('confirmPassword')}
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              error={
                confirmation.length > 0 && !matches ? t('mismatch') : null
              }
            />

            <Button
              type="submit"
              className="w-full"
              loading={submitting}
              disabled={!strong || !matches}
            >
              {t('submit')}
            </Button>

            <p className="text-center text-xs text-slate-500">{t('sessionsWarning')}</p>
          </form>
        )}
      </div>
    </main>
  );
}
