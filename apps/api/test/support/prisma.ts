/**
 * Client Prisma partage par les tests d'un meme fichier.
 *
 * Deux clients sont exposes, et la distinction est importante :
 *
 *  - `rawPrisma()` : client BRUT, sans le garde d'isolation. Il sert a mettre
 *    en place les donnees d'un scenario (creer deux boutiques concurrentes,
 *    par exemple) et a verifier l'etat reel de la base APRES l'action testee.
 *    Un test qui verifie l'isolation doit pouvoir regarder « de l'autre cote
 *    du mur » : c'est precisement ce qu'un client scope lui interdirait.
 *
 *  - `guardedPrisma()` : client ETENDU, identique a celui qu'utilise
 *    l'application. Il sert a tester le garde lui-meme.
 */

import { PrismaClient } from '@prisma/client';
import { extendPrismaClient, type PrismaClientExtended } from '../../src/infra/prisma/prisma.service';
import { truncateBusinessTables } from './database';

let raw: PrismaClient | null = null;
let guarded: PrismaClientExtended | null = null;

function databaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Aucune base de test disponible. Le globalSetup de Jest doit renseigner ' +
        'TEST_DATABASE_URL.',
    );
  }
  return url;
}

export function rawPrisma(): PrismaClient {
  raw ??= new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  return raw;
}

export function guardedPrisma(): PrismaClientExtended {
  guarded ??= extendPrismaClient(rawPrisma());
  return guarded;
}

/** Remet la base a l'etat « referentiels seuls ». A appeler en `beforeEach`. */
export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(rawPrisma());
}

/** Ferme les connexions. A appeler en `afterAll`. */
export async function closePrisma(): Promise<void> {
  if (raw) {
    await raw.$disconnect();
    raw = null;
    guarded = null;
  }
}
