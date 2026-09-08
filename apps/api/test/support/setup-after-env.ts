/**
 * Configuration appliquee dans CHAQUE worker de test.
 *
 * Les variables d'environnement necessaires au demarrage de l'application
 * NestJS sont posees ici : la validation de `env.validation.ts` est stricte et
 * refuserait de demarrer sans elles. On fournit des valeurs de test explicites
 * plutot que de relacher la validation — c'est elle qu'on veut voir a l'oeuvre.
 */

import { randomBytes } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.JWT_ACCESS_SECRET ??= randomBytes(32).toString('hex');
process.env.JWT_REFRESH_SECRET ??= randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.HASH_PEPPER ??= randomBytes(32).toString('hex');

// Aucun envoi reel pendant les tests.
process.env.MAIL_DRIVER = 'console';
process.env.OTP_DRIVER = 'console';
process.env.WHATSAPP_ENABLED = 'false';
process.env.CHARGILY_ENABLED = 'false';

// Files d'attente desactivees : les traitements asynchrones sont declenches
// explicitement par les tests, ce qui les rend deterministes.
process.env.REDIS_URL = '';
process.env.QUEUE_WORKERS_ENABLED = 'false';

// Limitation de debit relachee : on ne veut pas qu'un test fonctionnel echoue
// parce qu'il enchaine dix connexions. Les regles de limitation ont leurs
// propres tests dedies, qui la reactivent.
process.env.THROTTLE_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '10000';
process.env.THROTTLE_AUTH_LIMIT = '10000';

process.env.LOG_LEVEL = process.env.DEBUG_TEST_DB ? 'debug' : 'error';

jest.setTimeout(60_000);
