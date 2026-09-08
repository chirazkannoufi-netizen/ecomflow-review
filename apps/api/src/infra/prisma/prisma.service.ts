/**
 * Acces a PostgreSQL via Prisma.
 *
 * Deux objets distincts sont exposes :
 *
 *  - `PrismaBaseClient` : le client brut, porteur du cycle de vie
 *    (connexion / deconnexion) et de la journalisation des requetes. Il n'est
 *    JAMAIS injecte dans un service metier.
 *
 *  - le jeton `PRISMA` : le client ETENDU par le garde d'isolation
 *    multi-tenant. C'est le seul point d'acces autorise depuis les modules
 *    metier ; il est impossible d'oublier un filtre `tenantId` en l'utilisant.
 *
 * Cette separation est volontaire : elle rend le contournement du garde
 * visible en revue de code (il faudrait injecter `PrismaBaseClient`
 * explicitement, ce qu'aucun service metier ne fait).
 */

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { ITXClientDenyList } from '@prisma/client/runtime/library';
import { AppConfigService } from '../../config/configuration';
import { createTenantGuardExtension, type TenantGuardHooks } from './tenant-guard.extension';

/** Seuil au-dela duquel une requete est signalee comme lente. */
const SLOW_QUERY_THRESHOLD_MS = 500;

@Injectable()
export class PrismaBaseClient extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaBaseClient.name);

  constructor(config: AppConfigService) {
    super({
      datasources: { db: { url: config.databaseUrl } },
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      // Les erreurs courtes evitent de deverser le schema complet dans les
      // journaux de production, ou il pourrait etre expose par une alerte.
      errorFormat: config.isProduction ? 'minimal' : 'pretty',
    });

    this.registerLogging(config);
  }

  private registerLogging(config: AppConfigService): void {
    // Prisma type les evenements de log de facon dynamique selon la
    // configuration ; le cast documente ici est necessaire et sans risque.
    const client = this as unknown as {
      $on: (event: string, callback: (payload: never) => void) => void;
    };

    client.$on('query', (event: never) => {
      const query = event as unknown as Prisma.QueryEvent;
      if (query.duration >= SLOW_QUERY_THRESHOLD_MS) {
        this.logger.warn(
          `Requete lente (${query.duration} ms) : ${truncate(query.query, 500)}`,
        );
      } else if (!config.isProduction && config.app.logLevel === 'debug') {
        this.logger.debug(`${query.duration} ms — ${truncate(query.query, 300)}`);
      }
    });

    client.$on('warn', (event: never) => {
      const payload = event as unknown as Prisma.LogEvent;
      this.logger.warn(payload.message);
    });

    client.$on('error', (event: never) => {
      const payload = event as unknown as Prisma.LogEvent;
      this.logger.error(payload.message);
    });
  }

  async onModuleInit(): Promise<void> {
    // OUTILLAGE HORS LIGNE — l'export de la specification OpenAPI
    // (`scripts/export-openapi.ts`) doit pouvoir tourner en CI sans base de
    // donnees : il ne lit que les metadonnees des decorateurs et n'execute
    // aucune requete. Ce drapeau differe UNIQUEMENT la connexion initiale ;
    // il ne simule rien. Toute requete reelle echouerait normalement, ce qui
    // est le comportement voulu : rien n'est masque.
    if (process.env.ECOMFLOW_SKIP_DB_CONNECT === 'true') {
      this.logger.warn(
        'Connexion PostgreSQL differee (ECOMFLOW_SKIP_DB_CONNECT). ' +
          'Mode outillage uniquement : aucune requete ne fonctionnera.',
      );
      return;
    }

    await this.$connect();
    this.logger.log('Connexion PostgreSQL etablie.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Connexion PostgreSQL fermee.');
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Applique le garde d'isolation au client brut. */
export function extendPrismaClient(base: PrismaClient, hooks: TenantGuardHooks = {}) {
  return base.$extends(createTenantGuardExtension(hooks));
}

/** Type du client etendu, injecte partout dans les modules metier. */
export type PrismaClientExtended = ReturnType<typeof extendPrismaClient>;

/**
 * Client disponible a l'interieur d'une transaction interactive.
 * Les methodes de gestion de connexion y sont volontairement absentes.
 */
export type PrismaTransactionClient = Omit<PrismaClientExtended, ITXClientDenyList>;

/** Jeton d'injection du client etendu. */
export const PRISMA = Symbol('ECOMFLOW_PRISMA_CLIENT');

/** Sucre d'injection : `@InjectPrisma() private readonly prisma: PrismaClientExtended`. */
export const InjectPrisma = (): ParameterDecorator => Inject(PRISMA);

/**
 * Codes d'erreur Prisma exploites par la couche metier.
 * Documentes ici pour eviter les chaines magiques disseminees.
 */
export const PRISMA_ERROR_CODES = {
  UNIQUE_CONSTRAINT: 'P2002',
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  CONSTRAINT_FAILED: 'P2004',
  RECORD_NOT_FOUND: 'P2025',
  VALUE_TOO_LONG: 'P2000',
  TRANSACTION_CONFLICT: 'P2034',
} as const;

export function isPrismaKnownError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

export function isUniqueConstraintError(error: unknown, target?: string): boolean {
  if (!isPrismaKnownError(error) || error.code !== PRISMA_ERROR_CODES.UNIQUE_CONSTRAINT) {
    return false;
  }
  if (!target) return true;
  const meta = error.meta as { target?: string[] | string } | undefined;
  const fields = Array.isArray(meta?.target) ? meta.target : [meta?.target ?? ''];
  return fields.some((field) => field.includes(target));
}

export function isRecordNotFoundError(error: unknown): boolean {
  return isPrismaKnownError(error) && error.code === PRISMA_ERROR_CODES.RECORD_NOT_FOUND;
}
