'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { CircleUserRound, Store, Zap } from 'lucide-react';
import { maskPhone, parseAlgerianPhone } from '@ecomflow/shared';
import { ApiError, api } from '@/lib/api-client';
import { useSession, type AuthSession } from '@/lib/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Button, Input } from '@/components/ui';

const HERO_ICONS = [CircleUserRound, Store, Zap];

/**
 * Inscription en deux etapes.
 *
 * POURQUOI DEUX ETAPES
 *   Le numero de telephone doit etre VERIFIE avant la creation du compte :
 *   c'est l'identifiant fort qui lie l'essai gratuit a une personne reelle et
 *   empeche la reouverture indefinie d'essais (Addendum §38).
 *
 *   Etape 1 : saisie du numero, envoi du code.
 *   Etape 2 : code + informations du compte et de la boutique.
 *
 *   Le numero est valide localement AVANT l'appel : inutile de solliciter le
 *   serveur pour une saisie manifestement incorrecte.
 */
export default function RegisterPage() {
  const t = useTranslations('auth.register');
  const router = useRouter();
  const { applySession } = useSession();

  const [step, setStep] = useState<'phone' | 'account'>('phone');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [phone, setPhone] = useState('');
  const [phoneMasked, setPhoneMasked] = useState('');
  /** Code affiche en developpement (pilote OTP « console »). */
  const [devCode, setDevCode] = useState<string | null>(null);

  const [form, setForm] = useState({
    otpCode: '',
    email: '',
    password: '',
    fullName: '',
    storeName: '',
    acceptTerms: false,
  });

  const parsedPhone = parseAlgerianPhone(phone);
  const phoneValid = parsedPhone.ok;
  /** Apercu du numero tel qu'il sera enregistre, masque pour l'affichage. */
  const phonePreview = parsedPhone.ok ? maskPhone(parsedPhone.value.e164) : null;

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!phoneValid) {
      setError(t('phoneInvalidLong'));
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.post<{
        phoneMasked: string;
        expiresAt: string;
        devCode?: string;
      }>('/auth/otp/request', { phone }, { anonymous: true });

      setPhoneMasked(result.phoneMasked);
      setDevCode(result.devCode ?? null);
      setStep('account');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.userMessage : t('sendFailed'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function submitAccount(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!form.acceptTerms) {
      setError(t('termsRequired'));
      return;
    }

    setSubmitting(true);
    try {
      const session = await api.post<AuthSession & { trialUnderReview: boolean }>(
        '/auth/register',
        {
          email: form.email,
          password: form.password,
          fullName: form.fullName,
          storeName: form.storeName,
          phone,
          otpCode: form.otpCode,
          acceptTerms: true,
        },
        { anonymous: true },
      );

      applySession(session);
      // Le nouvel inscrit est envoye vers l'assistant de configuration : sans
      // source de commandes, sa boutique reste vide.
      router.push('/onboarding');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.userMessage : t('failed'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const heroSteps = Object.values(
    t.raw('hero.steps') as Record<string, { title: string; description: string; badge?: string }>,
  ).map((item, index) => ({ ...item, icon: HERO_ICONS[index] ?? CircleUserRound }));

  return (
    <AuthLayout
      eyebrow={t('hero.eyebrow')}
      headline={t('hero.headline')}
      subtitle={t('hero.subtitle')}
      steps={heroSteps}
      topRight={
        <p className="hidden text-sm text-ink-2 sm:block">
          {t('alreadyMember')}{' '}
          <Link href="/connexion" className="font-bold text-ink hover:underline">
            {t('login')}
          </Link>
        </p>
      }
    >
      <h1 className="text-display text-ink">{t('title')}</h1>
      <p className="mt-1.5 text-sm text-ink-2">{t('subtitle')}</p>

      {/* Indicateur d'etape */}
      <ol className="mt-5 flex items-center gap-2 text-xs">
        {(['phone', 'account'] as const).map((entry, index) => (
          <li key={entry} className="flex flex-1 items-center gap-2">
            <span
              className={
                step === entry || (entry === 'phone' && step === 'account')
                  ? 'flex h-5 w-5 items-center justify-center rounded-full bg-ink text-white'
                  : 'flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-muted'
              }
            >
              {index + 1}
            </span>
            <span className="font-semibold text-ink-2">
              {entry === 'phone' ? t('stepPhone') : t('stepAccount')}
            </span>
            {index === 0 ? <span className="h-px flex-1 bg-line" /> : null}
          </li>
        ))}
      </ol>

      <div className="mt-5">
        {step === 'phone' ? (
          <form onSubmit={(event) => void requestCode(event)} className="space-y-4">
            {error ? <Alert tone="danger">{error}</Alert> : null}

            <Input
              label={t('phone')}
              type="tel"
              required
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="0555 12 34 56"
              hint={
                phonePreview ? t('phonePreview', { masked: phonePreview }) : t('phoneHint')
              }
              error={phone.length > 0 && !phoneValid ? t('phoneInvalid') : null}
            />

            <Button type="submit" className="w-full" loading={submitting} disabled={!phoneValid}>
              {t('requestCode')}
            </Button>

            <p className="text-center text-xs text-muted sm:hidden">
              {t('alreadyMember')}{' '}
              <Link href="/connexion" className="font-semibold text-ink hover:underline">
                {t('login')}
              </Link>
            </p>
          </form>
        ) : (
          <form onSubmit={(event) => void submitAccount(event)} className="space-y-4">
            {error ? <Alert tone="danger">{error}</Alert> : null}

            {devCode ? (
              <Alert tone="info" title={t('devMode')}>
                {/*
                  Le code est rendu SEPAREMENT du message, et non interpole
                  dedans. Deux raisons :

                  1. C'est une valeur a RECOPIER. Sur sa propre ligne, en
                     chasse fixe et en grand, elle se lit et se saisit sans
                     effort — comme le mot de passe provisoire d'une invitation.
                  2. Un code interpole dans une phrase traduite depend du bon
                     appariement entre le placeholder du catalogue et
                     l'argument passe. C'est exactement ce qui avait echoue
                     ici : `t.rich` recevait une FONCTION pour `{code}`, qui
                     est un placeholder de VALEUR — next-intl ne rendait alors
                     rien, et la phrase s'affichait amputee de son code.
                     Sortir la valeur du message rend ce defaut impossible.
                */}
                <p className="text-sm">{t('devCode')}</p>
                <p className="tabular mt-1 font-mono text-xl font-bold tracking-widest">
                  {devCode}
                </p>
              </Alert>
            ) : (
              <Alert tone="info">
                {t('codeSent', { masked: phoneMasked })}
              </Alert>
            )}

            <Input
              label={t('code')}
              inputMode="numeric"
              maxLength={6}
              required
              value={form.otpCode}
              onChange={(event) => setForm({ ...form, otpCode: event.target.value })}
              placeholder="123456"
              className="tabular tracking-widest"
            />

            <Input
              label={t('storeName')}
              required
              value={form.storeName}
              onChange={(event) => setForm({ ...form, storeName: event.target.value })}
              placeholder={t('storeNamePlaceholder')}
            />

            <Input
              label={t('fullName')}
              required
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
              placeholder={t('fullNamePlaceholder')}
            />

            <Input
              label={t('email')}
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="sara@boutique.dz"
            />

            <Input
              label={t('password')}
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              hint={t('passwordHint')}
            />

            <label className="flex items-start gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-ink"
                checked={form.acceptTerms}
                onChange={(event) => setForm({ ...form, acceptTerms: event.target.checked })}
              />
              <span>{t('terms')}</span>
            </label>

            <Button type="submit" className="w-full" size="lg" loading={submitting}>
              {t('submit')}
            </Button>

            <button
              type="button"
              className="w-full text-center text-xs font-semibold text-muted hover:text-ink hover:underline"
              onClick={() => {
                setStep('phone');
                setError(null);
              }}
            >
              {t('changePhone')}
            </button>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
