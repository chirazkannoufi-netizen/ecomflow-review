import { Global, Logger, Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/config.module';
import { PRISMA, PrismaBaseClient, extendPrismaClient } from './prisma.service';
import { CrossTenantAccessError, TenantContextMissingError } from './tenant-guard.extension';
import { RequestContextStore } from '../context/request-context';

/**
 * Module d'acces aux donnees.
 *
 * Global : le client etendu est un singleton partage par tous les modules
 * metier. Le pool de connexions PostgreSQL est ainsi unique pour le processus.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    PrismaBaseClient,
    {
      provide: PRISMA,
      inject: [PrismaBaseClient],
      useFactory: (base: PrismaBaseClient) => {
        const logger = new Logger('TenantGuard');

        return extendPrismaClient(base, {
          /**
           * Une tentative d'acces inter-tenant est un evenement de securite,
           * pas une simple erreur de validation : elle est journalisee au
           * niveau `error` avec le contexte complet, pour declencher une alerte.
           */
          onCrossTenantAttempt: (error: CrossTenantAccessError) => {
            const context = RequestContextStore.get();
            logger.error(
              `ACCES INTER-TENANT BLOQUE — modele=${error.model} operation=${error.operation} ` +
                `tenantDemande=${error.requestedTenantId} tenantActif=${error.activeTenantId} ` +
                `utilisateur=${context?.userId ?? 'anonyme'} correlation=${context?.correlationId ?? '-'}`,
            );
          },

          /**
           * Une requete scopee sans tenant actif revele un defaut de cablage
           * (garde manquant, job mal encadre). On veut le voir immediatement.
           */
          onMissingContext: (error: TenantContextMissingError) => {
            const context = RequestContextStore.get();
            logger.error(
              `REQUETE NON SCOPEE REFUSEE — modele=${error.model} operation=${error.operation} ` +
                `correlation=${context?.correlationId ?? '-'}`,
            );
          },
        });
      },
    },
  ],
  exports: [PRISMA, PrismaBaseClient],
})
export class PrismaModule {}
