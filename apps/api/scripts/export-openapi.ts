/**
 * Export de la specification OpenAPI dans un fichier.
 *
 * POURQUOI UN EXPORT HORS LIGNE
 *   La CI verifie que la specification versionnee correspond au code (voir
 *   `.github/workflows/ci.yml`). Sans cet export, la seule source serait
 *   l'application en cours d'execution : impossible a diffuser aux equipes
 *   frontend ou aux integrateurs, et impossible a comparer entre deux commits
 *   pour reperer une rupture de contrat.
 *
 * COMMENT L'APPLICATION EST INSTANCIEE
 *   Le contexte Nest est cree SANS ecouter de port et sans se connecter aux
 *   services externes au-dela de ce qu'exige l'injection de dependances. La
 *   generation du document n'execute aucune route : elle lit uniquement les
 *   metadonnees des decorateurs.
 *
 * Usage : npm run openapi:export -w @ecomflow/api [-- chemin/sortie.json]
 */

import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config/configuration';
import { buildOpenApiConfig } from '../src/openapi';

const DEFAULT_OUTPUT = resolve(__dirname, '..', 'openapi.json');

async function exportSpecification(): Promise<void> {
  const logger = new Logger('OpenAPI');
  const outputPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUTPUT;

  // La generation ne lit que les metadonnees des decorateurs : aucune requete
  // n'est emise. On demande donc explicitement a l'infrastructure de differer
  // sa connexion initiale, ce qui rend l'export executable en CI sans demarrer
  // PostgreSQL ni Redis. Rien n'est simule : une requete reelle echouerait.
  process.env.ECOMFLOW_SKIP_DB_CONNECT = 'true';

  // `logger: false` : la generation ne doit produire que le resultat attendu,
  // pour rester utilisable dans un pipeline.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    rawBody: true,
  });

  try {
    const config = app.get(AppConfigService);
    const settings = config.app;

    // Le prefixe et le versionnage doivent etre appliques AVANT la generation :
    // sinon le document decrirait `/orders` alors que l'API sert
    // `/api/v1/orders`, et tout client genere depuis ce fichier echouerait.
    app.setGlobalPrefix(settings.apiPrefix, { exclude: ['health/live', 'health/ready'] });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: settings.apiVersion.replace(/^v/, ''),
    });

    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      buildOpenApiConfig({ apiUrl: settings.apiUrl }),
    );

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');

    const pathCount = Object.keys(document.paths ?? {}).length;
    const operationCount = Object.values(document.paths ?? {}).reduce(
      (total, item) =>
        total +
        Object.keys(item as Record<string, unknown>).filter((key) =>
          ['get', 'post', 'put', 'patch', 'delete'].includes(key),
        ).length,
      0,
    );

    logger.log(`Specification ecrite : ${outputPath}`);
    logger.log(`${pathCount} chemins, ${operationCount} operations.`);
  } finally {
    // Ferme les connexions ouvertes par l'injection (Prisma, Redis) : sans
    // cela le processus resterait suspendu et bloquerait la CI.
    await app.close();
  }
}

exportSpecification().catch((error: unknown) => {
  // Ecriture directe sur stderr : le logger Nest est desactive pour ce script,
  // et une erreur fatale silencieuse rendrait tout diagnostic impossible en CI.
  process.stderr.write(
    `Export OpenAPI impossible.
${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`,
  );
  process.exitCode = 1;
});
