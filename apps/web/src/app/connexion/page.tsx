'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { CircleUserRound, PhoneCall, Truck } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Button, Input } from '@/components/ui';

const HERO_ICONS = [CircleUserRound, PhoneCall, Truck];

/**
 * Ecran de connexion.
 *
 * MESSAGES D'ERREUR VOLONTAIREMENT UNIFORMES.
 *   Le serveur renvoie le meme message pour « adresse inconnue » et « mot de
 *   passe incorrect ». L'interface le relaie tel quel : afficher « cet e-mail
 *   n'existe pas » transformerait l'ecran en verificateur d'existence de
 *   comptes. Le verrouillage temporaire, lui, est explicite — l'utilisateur
 *   doit comprendre pourquoi il ne peut plus essayer.
 */
export default function LoginPage() {
  const t = useTranslations('auth.login');
  const router = useRouter();
  const { login, user, loading: sessionLoading } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Un utilisateur deja connecte n'a rien a faire ici.
  useEffect(() => {
    if (!sessionLoading && user) router.replace('/');
  }, [sessionLoading, user, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email, password);
      router.push('/');
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

  const heroSteps = Object.values(
    t.raw('hero.steps') as Record<string, { title: string; description: string }>,
  ).map((step, index) => ({ ...step, icon: HERO_ICONS[index] ?? CircleUserRound }));

  return (
    <AuthLayout
      eyebrow={t('hero.eyebrow')}
      headline={t('hero.headline')}
      subtitle={t('hero.subtitle')}
      steps={heroSteps}
      topRight={
        <p className="hidden text-sm text-ink-2 sm:block">
          {t('noAccount')}{' '}
          <Link href="/inscription" className="font-bold text-ink hover:underline">
            {t('register')}
          </Link>
        </p>
      }
    >
      <h1 className="text-display text-ink">{t('title')}</h1>
      <p className="mt-1.5 text-sm text-ink-2">{t('subtitle')}</p>

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 space-y-4">
        <Input
          label={t('email')}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="vous@boutique.dz"
        />

        <Input
          label={t('password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <Button type="submit" className="w-full" size="lg" loading={submitting}>
          {t('submit')}
        </Button>

        <div className="flex items-center justify-between text-xs">
          <Link href="/mot-de-passe-oublie" className="font-semibold text-ink-2 hover:text-ink hover:underline">
            {t('forgot')}
          </Link>
          <Link href="/inscription" className="font-semibold text-ink-2 hover:text-ink hover:underline sm:hidden">
            {t('register')}
          </Link>
        </div>
      </form>

      <p className="mt-6 text-center text-xs text-muted">{t('trialNote')}</p>
    </AuthLayout>
  );
}
