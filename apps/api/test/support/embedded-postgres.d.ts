/**
 * Declaration locale de `embedded-postgres`.
 *
 * Le paquet publie ses types via un champ `exports` que ne resout pas
 * `moduleResolution: "node"`. Basculer tout le projet sur `node16` pour une
 * dependance de TEST casserait la resolution CommonJS attendue par NestJS et
 * Prisma. On declare donc ici la surface reellement utilisee par le harnais
 * de tests — quatre methodes — plutot que de degrader la configuration de
 * compilation de tout l'applicatif.
 *
 * Voir apps/api/test/support/database.ts.
 */
declare module 'embedded-postgres' {
  interface PgClientLike {
    connect(): Promise<void>;
    query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  }

  export interface EmbeddedPostgresOptions {
    databaseDir: string;
    user: string;
    password: string;
    port: number;
    persistent?: boolean;
    initdbFlags?: string[];
    postgresFlags?: string[];
    onLog?: (message: string) => void;
    onError?: (message: string) => void;
  }

  export default class EmbeddedPostgres {
    constructor(options: EmbeddedPostgresOptions);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
    dropDatabase(name: string): Promise<void>;
    getPgClient(database?: string): PgClientLike;
  }
}
