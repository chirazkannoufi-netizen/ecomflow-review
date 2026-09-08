/**
 * Validation stricte des variables d'environnement au demarrage.
 *
 * Le processus REFUSE de demarrer si une variable requise est absente ou
 * malformee. C'est volontaire : un secret manquant en production doit se
 * manifester par un echec de boot immediat, jamais par un comportement
 * degrade silencieux (V2 §31, prompt produit §47).
 *
 * Aucune valeur par defaut n'est fournie pour un SECRET. Les valeurs par
 * defaut ne concernent que des reglages operationnels non sensibles.
 */

import { z } from 'zod';

const nodeEnvSchema = z.enum(['development', 'test', 'staging', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/** Chaine « true »/« false » tolerante, telle qu'on la trouve dans un .env. */
const booleanString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

const port = z.coerce.number().int().min(1).max(65_535);

/** Duree type JWT : « 15m », « 7d », « 3600s ». */
const duration = z.string().regex(/^\d+[smhd]$/, 'Duree attendue au format 15m / 24h / 7d');

/**
 * Cle de chiffrement AES-256-GCM : 32 octets encodes en base64 (44 caracteres).
 * Generation : `openssl rand -base64 32`
 */
const encryptionKey = z
  .string()
  .min(44, 'ENCRYPTION_KEY doit encoder 32 octets en base64')
  .refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'ENCRYPTION_KEY doit decoder exactement 32 octets');

const secret = z.string().min(32, 'Un secret doit faire au moins 32 caracteres');

export const envSchema = z
  .object({
    // --- Application ---
    NODE_ENV: nodeEnvSchema.default('development'),
    PORT: port.default(3001),
    API_PREFIX: z.string().default('api'),
    API_VERSION: z.string().default('v1'),
    /** URL publique du frontend, utilisee pour les liens des e-mails. */
    APP_URL: z.string().url().default('http://localhost:3000'),
    /** URL publique de l'API, utilisee pour les callbacks OAuth et webhooks. */
    API_URL: z.string().url().default('http://localhost:3001'),
    /** Origines autorisees par CORS, separees par des virgules. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Expose /api/docs. Doit rester false en production. */
    SWAGGER_ENABLED: booleanString.default(true),

    // --- Base de donnees ---
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

    // --- Redis / files d'attente ---
    REDIS_URL: z.string().url().optional(),
    /**
     * Desactive les workers dans un processus donne. Permet de faire tourner
     * l'API et les workers dans des conteneurs separes.
     */
    QUEUE_WORKERS_ENABLED: booleanString.default(true),

    // --- Authentification ---
    JWT_ACCESS_SECRET: secret,
    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_SECRET: secret,
    JWT_REFRESH_TTL: duration.default('30d'),
    /** Nombre d'echecs de connexion avant verrouillage temporaire du compte. */
    AUTH_MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(20).default(5),
    AUTH_LOCK_DURATION_MINUTES: z.coerce.number().int().min(1).default(15),

    // --- Chiffrement au repos ---
    ENCRYPTION_KEY: encryptionKey,
    /** Poivre applique avant hachage des jetons et OTP. */
    HASH_PEPPER: secret,

    // --- Limitation de debit ---
    /**
     * Permet de deleguer la limitation a une couche amont (passerelle API,
     * Cloudflare) plutot que de la doubler. Obligatoirement active en
     * production si aucune autre couche ne la fournit.
     */
    THROTTLE_ENABLED: booleanString.default(true),
    THROTTLE_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
    THROTTLE_LIMIT: z.coerce.number().int().min(1).default(120),
    /** Limite specifique aux endpoints d'authentification. */
    THROTTLE_AUTH_LIMIT: z.coerce.number().int().min(1).default(10),

    // --- Google Sheets (V2 §12) ---
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    /** Nombre maximal de lignes lues par execution de synchronisation. */
    GOOGLE_SHEETS_MAX_ROWS_PER_RUN: z.coerce.number().int().min(1).default(500),
    /** Requetes par minute autorisees vers l'API Google, par processus. */
    GOOGLE_SHEETS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(50),

    // --- WhatsApp Business Cloud (Addendum §31) ---
    WHATSAPP_ENABLED: booleanString.default(false),
    WHATSAPP_API_BASE_URL: z.string().url().default('https://graph.facebook.com/v21.0'),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

    // --- Chargily Pay (Addendum §35) ---
    CHARGILY_ENABLED: booleanString.default(false),
    CHARGILY_BASE_URL: z.string().url().default('https://pay.chargily.net/api/v2'),
    CHARGILY_SECRET_KEY: z.string().optional(),
    CHARGILY_WEBHOOK_SECRET: z.string().optional(),

    // --- Messagerie ---
    MAIL_DRIVER: z.enum(['smtp', 'console']).default('console'),
    MAIL_FROM: z.string().default('EcomFlow <no-reply@ecomflow.dz>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: port.optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: booleanString.default(false),

    // --- Envoi de SMS / OTP ---
    OTP_DRIVER: z.enum(['console', 'whatsapp', 'sms']).default('console'),
    OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

    // --- Stockage de fichiers ---
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // --- Amorcage ---
    /** Compte Super Admin cree par le seed. */
    SUPER_ADMIN_EMAIL: z.string().email().optional(),
    SUPER_ADMIN_PASSWORD: z.string().optional(),

    // --- Conservation des donnees (Addendum §37) ---
    DATA_RETENTION_DAYS_AFTER_EXPIRY: z.coerce.number().int().min(1).default(90),
    /** Duree de retention du journal d'audit. */
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).default(730),
  })
  .superRefine((env, ctx) => {
    const require = (condition: boolean, path: string, message: string): void => {
      if (!condition) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      }
    };

    if (env.NODE_ENV === 'production') {
      require(env.SWAGGER_ENABLED === false, 'SWAGGER_ENABLED', 'Swagger doit etre desactive en production.');
      require(Boolean(env.REDIS_URL), 'REDIS_URL', 'Redis est requis en production (files d attente).');
      require(
        env.JWT_ACCESS_SECRET !== env.JWT_REFRESH_SECRET,
        'JWT_REFRESH_SECRET',
        'Les secrets d acces et de rafraichissement doivent differer.',
      );
      require(
        !env.API_URL.startsWith('http://'),
        'API_URL',
        'HTTPS est obligatoire en production (V2 §31).',
      );
      require(env.MAIL_DRIVER === 'smtp', 'MAIL_DRIVER', 'Un vrai transport e-mail est requis en production.');
    }

    if (env.WHATSAPP_ENABLED) {
      require(Boolean(env.WHATSAPP_PHONE_NUMBER_ID), 'WHATSAPP_PHONE_NUMBER_ID', 'Requis quand WhatsApp est active.');
      require(Boolean(env.WHATSAPP_ACCESS_TOKEN), 'WHATSAPP_ACCESS_TOKEN', 'Requis quand WhatsApp est active.');
      require(Boolean(env.WHATSAPP_APP_SECRET), 'WHATSAPP_APP_SECRET', 'Requis pour verifier la signature des webhooks.');
      require(
        Boolean(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
        'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
        'Requis pour la validation du webhook Meta.',
      );
    }

    if (env.CHARGILY_ENABLED) {
      require(Boolean(env.CHARGILY_SECRET_KEY), 'CHARGILY_SECRET_KEY', 'Requis quand Chargily est active.');
      require(
        Boolean(env.CHARGILY_WEBHOOK_SECRET),
        'CHARGILY_WEBHOOK_SECRET',
        'Requis pour verifier la signature des webhooks de paiement.',
      );
    }

    if (env.MAIL_DRIVER === 'smtp') {
      require(Boolean(env.SMTP_HOST), 'SMTP_HOST', 'Requis avec MAIL_DRIVER=smtp.');
      require(Boolean(env.SMTP_PORT), 'SMTP_PORT', 'Requis avec MAIL_DRIVER=smtp.');
    }

    if (env.STORAGE_DRIVER === 's3') {
      require(Boolean(env.S3_BUCKET), 'S3_BUCKET', 'Requis avec STORAGE_DRIVER=s3.');
      require(Boolean(env.S3_ACCESS_KEY_ID), 'S3_ACCESS_KEY_ID', 'Requis avec STORAGE_DRIVER=s3.');
      require(Boolean(env.S3_SECRET_ACCESS_KEY), 'S3_SECRET_ACCESS_KEY', 'Requis avec STORAGE_DRIVER=s3.');
    }

    if (env.SUPER_ADMIN_EMAIL) {
      require(
        Boolean(env.SUPER_ADMIN_PASSWORD) && (env.SUPER_ADMIN_PASSWORD?.length ?? 0) >= 12,
        'SUPER_ADMIN_PASSWORD',
        'Un mot de passe d au moins 12 caracteres est requis pour le Super Admin.',
      );
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Traite une variable VIDE comme une variable ABSENTE.
 *
 * Un fichier `.env` ne sait pas exprimer « non defini » : `S3_ENDPOINT=` produit
 * une chaine vide, pas `undefined`. Sans ce pretraitement, une variable
 * optionnelle laissee vide — le cas nominal quand l'integration n'est pas
 * utilisee — ferait echouer la validation d'URL et empecherait le demarrage.
 *
 * Les champs pourvus d'une valeur par defaut la retrouvent naturellement, ce
 * qui est le comportement attendu.
 */
function treatBlankAsMissing(raw: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim().length === 0) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Valide l'environnement et produit un message d'erreur lisible listant
 * TOUTES les variables invalides d'un coup, plutot que la premiere.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(treatBlankAsMissing(raw));

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n');
    throw new Error(
      `Configuration d environnement invalide.\n${details}\n\n` +
        'Copiez .env.example vers .env et renseignez les valeurs manquantes.',
    );
  }

  return result.data;
}
