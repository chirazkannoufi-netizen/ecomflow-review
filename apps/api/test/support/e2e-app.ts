/**
 * Montage de l'application COMPLETE pour les tests de bout en bout.
 *
 * Contrairement au harnais d'integration, rien n'est raccourci : middleware,
 * gardes globales, pipe de validation, filtre d'exceptions et serialisation
 * sont tous actifs. Les requetes passent par le vrai routeur HTTP.
 *
 * C'est indispensable pour valider ce qu'un test de service ne peut pas voir :
 * qu'une route est bien protegee, qu'un DTO refuse un champ non declare, qu'une
 * erreur metier sort avec le bon code HTTP et le bon code d'erreur.
 *
 * Seules deux choses sont substituees :
 *   - l'HORLOGE, pour tester les regles temporelles (essai de 7 jours) ;
 *   - les PASSERELLES SORTANTES, qui appelleraient de vrais tiers.
 */

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import type { Server } from 'node:http';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/configuration';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ClockService, FixedClockService } from '../../src/infra/clock/clock.service';

export interface E2eApp {
  readonly app: NestExpressApplication;
  readonly server: Server;
  readonly clock: FixedClockService;
  readonly prefix: string;
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

export interface BuildE2eOptions {
  readonly now?: Date;
  readonly overrides?: readonly [unknown, unknown][];
  /**
   * Active la limitation de debit reelle pour cette instance.
   *
   * Desactivee par defaut via `THROTTLE_ENABLED=false` : plusieurs routes
   * portent un plafond volontairement bas (3 demandes de code OTP par minute),
   * bon reglage en production mais incompatible avec un scenario enchainant
   * plusieurs inscriptions. La limitation conserve son propre test dedie.
   */
  readonly enableThrottling?: boolean;
}

export async function buildE2eApp(options: BuildE2eOptions = {}): Promise<E2eApp> {
  const clock = new FixedClockService(options.now ?? new Date('2026-08-30T09:00:00.000Z'));

  // La configuration etant lue au montage du module, le reglage doit etre
  // pose AVANT la compilation.
  process.env.THROTTLE_ENABLED = options.enableThrottling ? 'true' : 'false';

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ClockService)
    .useValue(clock);

  for (const [token, value] of options.overrides ?? []) {
    builder = builder.overrideProvider(token as never).useValue(value);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    // Le corps brut est requis par les webhooks signes.
    rawBody: true,
    logger: process.env.DEBUG_TEST_DB ? ['error', 'warn', 'log'] : ['error'],
  });

  const config = app.get(AppConfigService);
  const settings = config.app;

  app.use(json({ limit: '2mb' }));

  // Le middleware de contexte est applique par `AppModule.configure()` :
  // il est deja actif ici, sans intervention supplementaire.

  app.setGlobalPrefix(settings.apiPrefix, { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: settings.apiVersion.replace(/^v/, ''),
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(false));

  await app.init();

  return {
    app,
    server: app.getHttpServer(),
    clock,
    // Le versionnage URI de NestJS prefixe la version d'un « v » :
    // la version « 1 » produit bien `/api/v1/...`.
    prefix: `/${settings.apiPrefix}/v${settings.apiVersion.replace(/^v/, '')}`,
    get: <T>(token: unknown): T => moduleRef.get<T>(token as never, { strict: false }),
    close: async () => {
      await app.close();
    },
  };
}
