'use client';

/**
 * Demande de reinitialisation du mot de passe.
 *
 * LA REPONSE EST TOUJOURS LA MEME, que l'adresse existe ou non. Repondre
 * « compte inconnu » permettrait a un attaquant d'enumerer les comptes de la
 * plateforme. Le serveur repond 202 dans tous les cas ; l'interface affiche
 * donc le meme message, sans jamais laisser deviner l'existence d'un compte.
 */

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ApiError, api } from '@/lib/api-client';
import { Alert, Button, Input } from '@/components/ui';

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgot');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await api.post('/auth/forgot-password', { email }, { anonymous: true });
      setSent(true);
    } catch (caught) {
      // Seules les erreurs techniques ou de limitation de debit remontent ici :
      // une adresse inconnue produit malgre tout une reponse positive.
      setError(caught instanceof ApiError ? caught.userMessage : t('failed'));
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
          <p className="mt-1 text-sm text-slate-600">{t('subtitle')}</p>
        </div>

        {sent ? (
          <div className="card space-y-3 p-5">
            <Alert tone="success" title={t('sentTitle')}>
              {t('sent')}
            </Alert>
            <p className="text-xs text-slate-500">
              {t('privacyNote')}
            </p>
            <Link href="/connexion">
              <span className="block text-center text-sm text-brand-700 hover:underline">
                {t('backToLogin')}
              </span>
            </Link>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="card space-y-4 p-5">
            {error ? <Alert tone="danger">{error}</Alert> : null}

            <Input
              label={t('email')}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="sara@boutique.dz"
            />

            <Button type="submit" className="w-full" loading={submitting}>
              {t('submit')}
            </Button>

            <p className="text-center text-xs text-slate-500">
              <Link href="/connexion" className="text-brand-700 hover:underline">
                {t('backToLogin')}
              </Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
