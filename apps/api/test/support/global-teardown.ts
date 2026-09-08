/**
 * Arret de l'environnement de test (Jest `globalTeardown`).
 *
 * Sans cela, le processus PostgreSQL survivrait a la suite de tests et
 * occuperait le port pour les executions suivantes.
 */

import type { EmbeddedHandle } from './database';

declare global {
   
  var __ECOMFLOW_PG__: EmbeddedHandle | undefined;
}

export default async function globalTeardown(): Promise<void> {
  const handle = globalThis.__ECOMFLOW_PG__;
  if (!handle) return;
  process.stdout.write('\n[tests] Arret de PostgreSQL...\n');
  await handle.stop();
  globalThis.__ECOMFLOW_PG__ = undefined;
}
