'use client';

/**
 * Aligne la langue affichee sur la preference enregistree du compte.
 *
 * POURQUOI UN COMPOSANT SEPARE PLUTOT QU'UN APPEL DANS `SessionProvider`
 *   Le fournisseur de langue enveloppe le fournisseur de session — il le faut,
 *   pour que les ecrans de connexion soient traduits avant toute session. Le
 *   fournisseur de session ne peut donc pas appeler `useLocalePreference()` :
 *   il est a l'INTERIEUR, et l'inverse creerait une dependance circulaire.
 *
 *   Ce petit composant, monte dans l'application authentifiee, fait le pont
 *   dans le seul sens qui a du sens : session -> langue.
 *
 * QUI GAGNE, ET QUAND
 *   Le serveur fait autorite, mais UNE SEULE FOIS par session : a la premiere
 *   lecture du profil. Ensuite, un changement fait depuis le selecteur reste
 *   souverain — sans cette regle, un rechargement de session ecraserait le
 *   choix que l'utilisateur vient tout juste de faire.
 */

import { useEffect, useRef } from 'react';
import { isLocale } from '@ecomflow/shared';
import { useSession } from '@/lib/session';
import { useLocalePreference } from './provider';

export function SessionLocaleSync() {
  const { user } = useSession();
  const { locale, setLocale } = useLocalePreference();
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;

    const preferred = user?.locale;
    if (!isLocale(preferred)) return;

    applied.current = true;
    if (preferred !== locale) setLocale(preferred);
  }, [user, locale, setLocale]);

  return null;
}
