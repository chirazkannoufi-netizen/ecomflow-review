/**
 * Preparation unique de l'environnement de test (Jest `globalSetup`).
 *
 * Demarre PostgreSQL, applique les migrations, amorce les referentiels, puis
 * publie l'URL de connexion via `process.env` pour les workers de test.
 *
 * S'execute une seule fois par invocation de Jest, dans le processus parent :
 * le cout de demarrage de PostgreSQL (quelques secondes) n'est donc paye
 * qu'une fois pour toute la suite.
 */

import { applyMigrations, applySeed, startEmbeddedPostgres, type EmbeddedHandle } from './database';

declare global {
   
  var __ECOMFLOW_PG__: EmbeddedHandle | undefined;
}

export default async function globalSetup(): Promise<void> {
  const provided = process.env.TEST_DATABASE_URL;

  let url: string;
  if (provided) {
    url = provided;
    process.stdout.write('\n[tests] Base PostgreSQL fournie via TEST_DATABASE_URL.\n');
  } else {
    process.stdout.write('\n[tests] Demarrage d une instance PostgreSQL embarquee...\n');
    const handle = await startEmbeddedPostgres();
    globalThis.__ECOMFLOW_PG__ = handle;
    url = handle.url;
  }

  process.env.DATABASE_URL = url;
  // Transmis aux workers de test, qui ne partagent pas `process.env` du parent
  // apres coup : Jest recopie l'environnement au moment du fork.
  process.env.TEST_DATABASE_URL = url;

  process.stdout.write('[tests] Application des migrations...\n');
  applyMigrations(url);

  process.stdout.write('[tests] Amorcage des referentiels...\n');
  await applySeed(url);

  process.stdout.write('[tests] Base prete.\n\n');
}
