/**
 * Harnais de base de donnees pour les tests d'integration et de bout en bout.
 *
 * POURQUOI UNE VRAIE BASE POSTGRESQL
 *   L'essentiel des garanties d'EcomFlow vit dans PostgreSQL : cles etrangeres
 *   composites d'isolation multi-tenant, contraintes CHECK sur le stock, index
 *   uniques partiels d'idempotence. Un double en memoire ne les executerait
 *   pas — les tests seraient verts alors que la production casserait.
 *
 * DEUX MODES, choisis automatiquement :
 *   1. `TEST_DATABASE_URL` definie -> la base fournie est utilisee (CI avec un
 *      service PostgreSQL, ou docker-compose local).
 *   2. sinon -> une instance PostgreSQL 17 reelle est demarree dans un dossier
 *      temporaire via `embedded-postgres`. Aucune installation prealable,
 *      aucun conteneur : les tests tournent sur un poste nu.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/** Port de depart pour la recherche d'un port libre. */
const BASE_PORT = 54_320;

/** Racine du paquet API, quel que soit le repertoire d'execution de Jest. */
const API_ROOT = join(__dirname, '..', '..');

export interface EmbeddedHandle {
  readonly url: string;
  readonly dataDir: string;
  stop(): Promise<void>;
}

/**
 * Demarre une instance PostgreSQL reelle et isolee.
 * Retourne l'URL de connexion et de quoi l'arreter proprement.
 */
export async function startEmbeddedPostgres(): Promise<EmbeddedHandle> {
  // Import dynamique : dependance de test, jamais chargee par l'applicatif.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const dataDir = mkdtempSync(join(tmpdir(), 'ecomflow-pg-'));
  const port = BASE_PORT + (process.pid % 1_000);
  const user = 'ecomflow_test';
  const password = 'ecomflow_test';
  const database = 'ecomflow_test';

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: false,
    // PostgreSQL est bavard au demarrage ; on ne relaie que sur demande.
    onLog: (message: string) => {
      if (process.env.DEBUG_TEST_DB) process.stdout.write(`[pg] ${message}`);
    },
    onError: (message: string) => {
      if (process.env.DEBUG_TEST_DB) process.stderr.write(`[pg] ${message}`);
    },
  });

  await instance.initialise();
  await instance.start();
  await instance.createDatabase(database);

  // `pg_trgm` alimente la recherche floue sur les noms de clients et produits.
  const client = instance.getPgClient(database);
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await client.end();

  const url = `postgresql://${user}:${password}@localhost:${port}/${database}?schema=public`;

  return {
    url,
    dataDir,
    stop: async () => {
      // Sous Windows, le processus PostgreSQL libere ses verrous de fichiers
      // avec un leger decalage apres l'arret. Supprimer le dossier de donnees
      // dans la foulee echoue alors en EBUSY. Ce n'est PAS un echec de test :
      // le dossier est temporaire et sera nettoye par le systeme. On absorbe
      // donc l'erreur apres une courte attente, plutot que de faire echouer
      // une suite pourtant verte.
      try {
        await instance.stop();
      } catch (error) {
        const message = (error as Error).message;
        if (!message.includes('EBUSY') && !message.includes('ENOTEMPTY')) throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));

      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // Idem : sans consequence, le dossier vit dans le repertoire temporaire.
      }
    },
  };
}

/**
 * Chemin du script CLI de Prisma.
 *
 * On invoque `node <cli>` plutot que `npx prisma` : depuis Node 20, lancer un
 * `.cmd` sous Windows via `execFile` echoue en EINVAL (durcissement lie a
 * CVE-2024-27980). Resoudre le script JavaScript reel evite tout passage par
 * le shell, ce qui est aussi plus rapide et plus sur.
 */
function prismaCliPath(): string {
  const require_ = createRequire(join(API_ROOT, 'package.json'));
  const packageJsonPath = require_.resolve('prisma/package.json');
  return join(dirname(packageJsonPath), 'build', 'index.js');
}

/**
 * Applique les migrations avec `prisma migrate deploy`.
 *
 * On emprunte le MEME chemin qu'en production plutot que `db push` : les tests
 * valident ainsi les migrations elles-memes, y compris les contraintes SQL
 * ecrites a la main (cles etrangeres composites, index partiels, CHECK).
 */
export function applyMigrations(databaseUrl: string): void {
  execFileSync(process.execPath, [prismaCliPath(), 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: process.env.DEBUG_TEST_DB ? 'inherit' : 'pipe',
  });
}

/**
 * Amorce les referentiels (permissions, plans, transporteurs).
 *
 * Execute EN PROCESSUS plutot que par un sous-processus `ts-node` : le seed
 * est deja du TypeScript compile a la volee par Jest, et un fork couterait
 * plusieurs secondes a chaque lancement de suite.
 */
export async function applySeed(databaseUrl: string): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const { runSeed } = await import('../../prisma/seed');

  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await runSeed(client, {
      // Pas de compte Super Admin par defaut : chaque test cree les identites
      // dont il a besoin, ce qui rend les suites independantes.
      superAdmin: null,
      withDemo: false,
      silent: !process.env.DEBUG_TEST_DB,
    });
  } finally {
    await client.$disconnect();
  }
}

/**
 * Tables de REFERENTIEL, seedees une seule fois et preservees entre les tests.
 * Les vider obligerait a rejouer le seed avant chaque cas, pour rien.
 *
 * `carrier_capabilities` EN FAIT PARTIE, et son absence etait un piege : la
 * matrice de capacites (D-049) est seedee en meme temps que les transporteurs
 * et n'a de sens qu'avec eux. En preservant `carriers` sans elle, chaque
 * `resetDatabase()` laissait le catalogue debout mais MUET — et tout code qui
 * lit une capacite retombait sur son defaut le plus restrictif. Un test aurait
 * alors verifie l'absence de matrice, pas le comportement reel.
 */
const PRESERVED_TABLES = [
  '_prisma_migrations',
  'permissions',
  'carriers',
  'carrier_capabilities',
  'plans',
];

/**
 * Vide toutes les tables metier.
 *
 * `TRUNCATE ... CASCADE` en une seule instruction laisse PostgreSQL resoudre
 * l'ordre des dependances : plus robuste qu'une liste ordonnee a la main, qui
 * se perime des qu'une relation est ajoutee au schema.
 */
export async function truncateBusinessTables(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const targets = tables
    .map((row) => row.tablename)
    .filter((name) => !PRESERVED_TABLES.includes(name))
    .map((name) => `"public"."${name}"`);

  if (targets.length === 0) return;

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`,
  );
}
