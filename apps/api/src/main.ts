/**
 * Point d'entree de l'API EcomFlow.
 *
 * L'ordre d'initialisation est important et documente ci-dessous : plusieurs
 * reglages n'ont d'effet que s'ils sont poses avant que la premiere requete
 * n'atteigne le routeur.
 */

import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AppConfigService } from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildOpenApiConfig } from './openapi';

/** Taille maximale d'un corps de requete JSON. */
const JSON_BODY_LIMIT = '2mb';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    // Le corps brut est conserve pour les webhooks : verifier une signature
    // exige les octets exacts recus, pas un JSON re-serialise.
    rawBody: true,
  });

  const config = app.get(AppConfigService);
  const settings = config.app;

  // --- Securite HTTP -------------------------------------------------------
  app.use(
    helmet({
      // L'API ne sert pas de HTML : la CSP par defaut de helmet gene surtout
      // Swagger UI sans rien proteger d'utile ici.
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Derriere un proxy (Nginx, Traefik, Railway), `request.ip` doit refleter
  // l'adresse reelle du client : elle alimente la limitation de debit et la
  // detection d'abus de l'essai.
  if (config.isProduction) {
    app.set('trust proxy', 1);
  }

  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

  // --- CORS ----------------------------------------------------------------
  app.enableCors({
    origin: [...settings.corsOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Correlation-Id'],
    maxAge: 86_400,
  });

  // --- Routage -------------------------------------------------------------
  app.setGlobalPrefix(settings.apiPrefix, {
    // Les sondes doivent rester joignables sans prefixe de version : les
    // orchestrateurs les configurent une fois pour toutes.
    exclude: ['health/live', 'health/ready'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: settings.apiVersion.replace(/^v/, '') });

  // --- Validation ----------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // `whitelist` retire les champs non declares dans le DTO ;
      // `forbidNonWhitelisted` refuse la requete au lieu de les ignorer
      // silencieusement. Un client qui envoie `tenantId` ou `role` dans le
      // corps recoit donc une erreur explicite plutot qu'une elevation de
      // privilege silencieuse par assignation de masse.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  // --- Gestion des erreurs -------------------------------------------------
  app.useGlobalFilters(new AllExceptionsFilter(config.isProduction));

  // --- Documentation OpenAPI ----------------------------------------------
  if (settings.swaggerEnabled) {
    const documentConfig = buildOpenApiConfig({ apiUrl: settings.apiUrl });

    const document = SwaggerModule.createDocument(app, documentConfig);
    SwaggerModule.setup(`${settings.apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha', operationsSorter: 'alpha' },
      customSiteTitle: 'EcomFlow API',
    });
    logger.log(`Documentation OpenAPI : ${settings.apiUrl}/${settings.apiPrefix}/docs`);
  }

  // --- Arret propre --------------------------------------------------------
  // Sans cela, un redemarrage couperait les requetes en cours et laisserait
  // des connexions PostgreSQL ouvertes.
  app.enableShutdownHooks();

  await app.listen(settings.port, '0.0.0.0');

  logger.log(
    `EcomFlow API demarree — environnement=${settings.nodeEnv} port=${settings.port} ` +
      `prefixe=/${settings.apiPrefix}/${settings.apiVersion}`,
  );
}

bootstrap().catch((error: unknown) => {
  // Un echec de demarrage doit etre bruyant et non ambigu : le processus
  // s'arrete avec un code d'erreur pour que l'orchestrateur ne le considere
  // jamais comme sain.
  const logger = new Logger('Bootstrap');
  logger.error('Demarrage impossible.', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
