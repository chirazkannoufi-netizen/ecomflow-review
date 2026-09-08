import { Global, Module } from '@nestjs/common';
import { SubscriptionStateService } from './subscription-state.service';
import { TrialAbuseService } from './trial-abuse.service';

/**
 * Noyau de facturation, separe du module complet `BillingModule`.
 *
 * Il ne contient que les services dont dependent l'authentification et les
 * gardes globales : l'etat d'abonnement et la prevention d'abus de l'essai.
 * Cette separation evite un cycle `AuthModule <-> BillingModule` : le module
 * complet (plans, paiements, Chargily, webhooks) importe l'authentification,
 * alors que ce noyau n'importe rien de metier.
 */
@Global()
@Module({
  providers: [SubscriptionStateService, TrialAbuseService],
  exports: [SubscriptionStateService, TrialAbuseService],
})
export class BillingCoreModule {}
