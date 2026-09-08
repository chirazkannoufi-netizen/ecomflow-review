'use client';

/**
 * Fournisseurs applicatifs : cache de donnees et session.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { Locale } from '@ecomflow/shared';
import { ApiError } from '@/lib/api-client';
import { LocaleProvider } from '@/i18n/provider';
import { SessionProvider } from '@/lib/session';

export function Providers({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  // Le client est cree dans un etat React : une instance unique par onglet,
  // jamais partagee entre requetes serveur.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Les donnees operationnelles changent vite : 30 s de fraicheur
            // evitent de rappeler l'API a chaque navigation sans risquer
            // d'afficher une file de confirmation perimee.
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) => {
              // Ne JAMAIS reessayer une erreur metier : une commande refusee
              // pour stock insuffisant le restera, et reessayer trois fois ne
              // ferait qu'ajouter du bruit et de la latence.
              if (error instanceof ApiError) {
                if (error.status >= 400 && error.status < 500) return false;
              }
              return failureCount < 2;
            },
          },
          mutations: {
            // Une mutation echouee n'est jamais rejouee automatiquement :
            // elle peut avoir eu un effet partiel cote serveur.
            retry: false,
          },
        },
      }),
  );

  // La langue enveloppe la session : les ecrans d'authentification, qui
  // s'affichent AVANT toute session, doivent eux aussi etre traduits.
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider initialLocale={initialLocale}>
        <SessionProvider>{children}</SessionProvider>
      </LocaleProvider>
    </QueryClientProvider>
  );
}
