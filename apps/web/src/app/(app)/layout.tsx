import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { SessionLocaleSync } from '@/i18n/session-locale-sync';

/**
 * Disposition des ecrans authentifies.
 *
 * Le groupe de routes `(app)` n'apparait pas dans l'URL : il sert uniquement a
 * partager cette coque entre tous les ecrans internes, sans l'imposer aux
 * pages de connexion et d'inscription.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Applique la langue enregistree du compte des que la session est lue. */}
      <SessionLocaleSync />
      <AppShell>{children}</AppShell>
    </>
  );
}
