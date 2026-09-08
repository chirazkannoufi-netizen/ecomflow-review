import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { AppConfigService } from './configuration';
import { validateEnv } from './env.validation';

/**
 * Chargement et validation de la configuration.
 *
 * Un seul fichier `.env` existe, a la racine du depot : dupliquer les secrets
 * par application multiplierait les risques de fuite et de desynchronisation.
 * Les chemins sont testes dans l'ordre, le premier trouve gagne.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [
        // Execution depuis apps/api (npm workspaces).
        join(process.cwd(), '..', '..', '.env'),
        // Execution depuis la racine du depot.
        join(process.cwd(), '.env'),
        // Conteneur : le fichier est monte a la racine de l'application.
        '/app/.env',
      ],
      validate: validateEnv,
      // Les variables deja presentes dans l'environnement (Docker, CI, secrets
      // manager) ont toujours la priorite sur le fichier .env.
      ignoreEnvFile: process.env.IGNORE_ENV_FILE === 'true',
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService, ConfigModule],
})
export class AppConfigModule {}
