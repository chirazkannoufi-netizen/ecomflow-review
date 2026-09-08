/**
 * Configuration applicative typee, derivee de l'environnement valide.
 *
 * Les modules NestJS n'accedent JAMAIS a `process.env` directement : ils
 * injectent `AppConfigService`. Cela garantit qu'une variable non declaree
 * dans `env.validation.ts` ne peut pas se glisser dans le code.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env, NodeEnv } from './env.validation';

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly apiPrefix: string;
  readonly apiVersion: string;
  readonly appUrl: string;
  readonly apiUrl: string;
  readonly corsOrigins: readonly string[];
  readonly logLevel: string;
  readonly swaggerEnabled: boolean;
}

export interface AuthConfig {
  readonly accessSecret: string;
  readonly accessTtl: string;
  readonly refreshSecret: string;
  readonly refreshTtl: string;
  readonly maxFailedLogins: number;
  readonly lockDurationMinutes: number;
}

export interface GoogleConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly redirectUri?: string;
  readonly maxRowsPerRun: number;
  readonly rateLimitPerMinute: number;
  readonly configured: boolean;
}

export interface WhatsappConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly phoneNumberId?: string;
  readonly accessToken?: string;
  readonly appSecret?: string;
  readonly webhookVerifyToken?: string;
}

export interface ChargilyConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly secretKey?: string;
  readonly webhookSecret?: string;
}

export interface MailConfig {
  readonly driver: 'smtp' | 'console';
  readonly from: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly secure: boolean;
}

export interface StorageConfig {
  readonly driver: 'local' | 's3';
  readonly localPath: string;
  readonly endpoint?: string;
  readonly region?: string;
  readonly bucket?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
}

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get app(): AppConfig {
    return {
      nodeEnv: this.get('NODE_ENV'),
      port: this.get('PORT'),
      apiPrefix: this.get('API_PREFIX'),
      apiVersion: this.get('API_VERSION'),
      appUrl: this.get('APP_URL'),
      apiUrl: this.get('API_URL'),
      corsOrigins: this.get('CORS_ORIGINS')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      logLevel: this.get('LOG_LEVEL'),
      swaggerEnabled: this.get('SWAGGER_ENABLED'),
    };
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  get isDevelopment(): boolean {
    return this.get('NODE_ENV') === 'development';
  }

  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  get redisUrl(): string | undefined {
    return this.get('REDIS_URL');
  }

  /**
   * Les files d'attente ne sont montees que si Redis est configure ET que le
   * processus est autorise a executer des workers. En developpement sans
   * Redis, l'application demarre et les traitements asynchrones basculent en
   * execution synchrone documentee (voir QueueModule).
   */
  get queuesEnabled(): boolean {
    return Boolean(this.get('REDIS_URL')) && this.get('QUEUE_WORKERS_ENABLED');
  }

  get auth(): AuthConfig {
    return {
      accessSecret: this.get('JWT_ACCESS_SECRET'),
      accessTtl: this.get('JWT_ACCESS_TTL'),
      refreshSecret: this.get('JWT_REFRESH_SECRET'),
      refreshTtl: this.get('JWT_REFRESH_TTL'),
      maxFailedLogins: this.get('AUTH_MAX_FAILED_LOGINS'),
      lockDurationMinutes: this.get('AUTH_LOCK_DURATION_MINUTES'),
    };
  }

  get encryptionKey(): Buffer {
    return Buffer.from(this.get('ENCRYPTION_KEY'), 'base64');
  }

  get hashPepper(): string {
    return this.get('HASH_PEPPER');
  }

  get throttle(): {
    enabled: boolean;
    ttlSeconds: number;
    limit: number;
    authLimit: number;
  } {
    return {
      enabled: this.get('THROTTLE_ENABLED'),
      ttlSeconds: this.get('THROTTLE_TTL_SECONDS'),
      limit: this.get('THROTTLE_LIMIT'),
      authLimit: this.get('THROTTLE_AUTH_LIMIT'),
    };
  }

  get google(): GoogleConfig {
    const clientId = this.get('GOOGLE_CLIENT_ID');
    const clientSecret = this.get('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.get('GOOGLE_REDIRECT_URI');
    return {
      clientId,
      clientSecret,
      redirectUri,
      maxRowsPerRun: this.get('GOOGLE_SHEETS_MAX_ROWS_PER_RUN'),
      rateLimitPerMinute: this.get('GOOGLE_SHEETS_RATE_LIMIT_PER_MINUTE'),
      configured: Boolean(clientId && clientSecret && redirectUri),
    };
  }

  get whatsapp(): WhatsappConfig {
    return {
      enabled: this.get('WHATSAPP_ENABLED'),
      baseUrl: this.get('WHATSAPP_API_BASE_URL'),
      phoneNumberId: this.get('WHATSAPP_PHONE_NUMBER_ID'),
      accessToken: this.get('WHATSAPP_ACCESS_TOKEN'),
      appSecret: this.get('WHATSAPP_APP_SECRET'),
      webhookVerifyToken: this.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    };
  }

  get chargily(): ChargilyConfig {
    return {
      enabled: this.get('CHARGILY_ENABLED'),
      baseUrl: this.get('CHARGILY_BASE_URL'),
      secretKey: this.get('CHARGILY_SECRET_KEY'),
      webhookSecret: this.get('CHARGILY_WEBHOOK_SECRET'),
    };
  }

  get mail(): MailConfig {
    return {
      driver: this.get('MAIL_DRIVER'),
      from: this.get('MAIL_FROM'),
      host: this.get('SMTP_HOST'),
      port: this.get('SMTP_PORT'),
      user: this.get('SMTP_USER'),
      password: this.get('SMTP_PASSWORD'),
      secure: this.get('SMTP_SECURE'),
    };
  }

  get otp(): { driver: 'console' | 'whatsapp' | 'sms'; ttlMinutes: number } {
    return { driver: this.get('OTP_DRIVER'), ttlMinutes: this.get('OTP_TTL_MINUTES') };
  }

  get storage(): StorageConfig {
    return {
      driver: this.get('STORAGE_DRIVER'),
      localPath: this.get('STORAGE_LOCAL_PATH'),
      endpoint: this.get('S3_ENDPOINT'),
      region: this.get('S3_REGION'),
      bucket: this.get('S3_BUCKET'),
      accessKeyId: this.get('S3_ACCESS_KEY_ID'),
      secretAccessKey: this.get('S3_SECRET_ACCESS_KEY'),
    };
  }

  get superAdmin(): { email?: string; password?: string } {
    return {
      email: this.get('SUPER_ADMIN_EMAIL'),
      password: this.get('SUPER_ADMIN_PASSWORD'),
    };
  }

  get retention(): { dataRetentionDays: number; auditRetentionDays: number } {
    return {
      dataRetentionDays: this.get('DATA_RETENTION_DAYS_AFTER_EXPIRY'),
      auditRetentionDays: this.get('AUDIT_RETENTION_DAYS'),
    };
  }
}
