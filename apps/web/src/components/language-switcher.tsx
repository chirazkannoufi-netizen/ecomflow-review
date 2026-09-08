'use client';

/**
 * Selecteur de langue.
 *
 * COMPORTEMENT DELIBERE : LE CHANGEMENT EST IMMEDIAT.
 *   L'interface bascule des le clic, sans attendre la reponse du serveur. La
 *   persistance suit en arriere-plan. Faire patienter l'utilisateur devant un
 *   aller-retour reseau pour changer de langue serait disproportionne, d'autant
 *   que l'affichage n'a aucun effet metier.
 *
 *   Si l'enregistrement echoue, on le DIT — sans revenir en arriere. La langue
 *   affichee reste celle demandee (le cookie l'a memorisee) ; seule sa
 *   propagation aux autres postes a echoue, et c'est exactement ce que le
 *   message indique.
 *
 * DISPONIBLE AVANT LA CONNEXION
 *   Le composant fonctionne sans session : un utilisateur arabophone doit
 *   pouvoir lire l'ecran de connexion dans sa langue. Sans session, seul le
 *   cookie est ecrit — il n'y a pas encore de compte ou enregistrer la
 *   preference.
 */

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABELS, type Locale } from '@ecomflow/shared';
import { api } from '@/lib/api-client';
import { useLocalePreference } from '@/i18n/provider';

export function LanguageSwitcher({
  /** Sans session, la preference n'est pas persistee cote serveur. */
  persist = true,
  className,
}: {
  persist?: boolean;
  className?: string;
}) {
  const t = useTranslations('language');
  const { locale, setLocale } = useLocalePreference();
  const [failed, setFailed] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (next: Locale) =>
      api.patch<{ locale: string }>('/auth/me/preferences', { locale: next }),
    onSuccess: () => setFailed(false),
    onError: () => setFailed(true),
  });

  function choose(next: Locale) {
    if (next === locale) return;

    // Bascule immediate : l'affichage ne depend pas du serveur.
    setLocale(next);
    setFailed(false);
    if (persist) saveMutation.mutate(next);
  }

  return (
    <div className={className}>
      <div
        role="group"
        aria-label={t('change')}
        className="flex rounded-md border border-line bg-white p-0.5"
      >
        {LOCALES.map((entry) => (
          <button
            key={entry}
            type="button"
            lang={entry}
            aria-pressed={locale === entry}
            onClick={() => choose(entry)}
            className={
              locale === entry
                ? 'flex-1 rounded px-2.5 py-1 text-xs font-bold bg-ink text-white'
                : 'flex-1 rounded px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-canvas'
            }
          >
            {LOCALE_LABELS[entry]}
          </button>
        ))}
      </div>

      {failed ? (
        <p className="mt-1 text-xs text-warning">{t('changeFailed')}</p>
      ) : null}
    </div>
  );
}
