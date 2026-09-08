import { Module } from '@nestjs/common';
import { BillingCoreModule } from './billing-core.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { ChargilyGateway } from './chargily.gateway';

/**
 * Module de facturation complet : plans, abonnements, paiements.
 *
 * Il importe `BillingCoreModule` (etat d'abonnement, anti-abus du Trial), qui
 * reste separe pour eviter un cycle avec l'authentification et les gardes
 * globales — voir le commentaire de `billing-core.module.ts`.
 */
@Module({
  imports: [BillingCoreModule],
  controllers: [BillingController],
  providers: [BillingService, ChargilyGateway],
  exports: [BillingService, ChargilyGateway],
})
export class BillingModule {}
