/**
 * Module racine.
 *
 * ORDRE DES GARDES GLOBALES — il est significatif :
 *   1. `ThrottlerGuard`    : rejette le trafic abusif avant tout travail utile.
 *   2. `JwtAuthGuard`      : etablit l identite et le tenant courant.
 *   3. `PermissionsGuard`  : verifie les droits sur le tenant etabli.
 *   4. `SubscriptionGuard` : verifie l abonnement, en dernier, car il
 *                            interroge la base et ne doit s executer que pour
 *                            un appelant deja authentifie et autorise.
 *
 * Inverser 2 et 3 ferait echouer les permissions faute de contexte ; placer
 * 4 avant 1 exposerait la base a une charge non filtree.
 */

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/configuration';
import { InfraModule } from './infra/infra.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { SubscriptionGuard } from './common/guards/subscription.guard';

// --- Socle transverse ---
import { AuditModule } from './modules/audit/audit.module';
import { EventsModule } from './modules/events/events.module';
import { MailModule } from './modules/notifications/mail/mail.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { BillingCoreModule } from './modules/billing/billing-core.module';

// --- Domaines metier ---
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ConfirmationModule } from './modules/confirmation/confirmation.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { ShipmentsModule } from './modules/shipments/shipments.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    AppConfigModule,
    InfraModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.throttle.ttlSeconds * 1000,
            limit: config.throttle.limit,
          },
        ],
        // Neutralise la limitation quand une couche amont s'en charge deja
        // (passerelle API), ou pendant les tests de bout en bout, ou plusieurs
        // inscriptions s'enchainent en quelques secondes. La limitation elle-meme
        // conserve son propre test dedie.
        //
        // EN DEVELOPPEMENT, ELLE EST TOUJOURS NEUTRALISEE.
        //   L'inscription demande un code de verification, et le mode
        //   developpement affiche ce code a l'ecran plutot que de l'envoyer par
        //   SMS. Mais `/auth/register` n'accepte que trois tentatives par
        //   minute : quiconque teste le parcours deux ou trois fois de suite se
        //   heurte a « Trop de tentatives » et ne peut plus rien saisir pendant
        //   une minute — sur un ecran dont c'est precisement le but d'etre
        //   reessaye.
        //
        //   Le garde-fou reste entier la ou il protege quelque chose : en
        //   production, et dans son test dedie (`NODE_ENV=test`), qui ne passe
        //   pas par cette branche.
        skipIf: () => !config.throttle.enabled || config.isDevelopment,
      }),
    }),

    // --- Socle transverse ---
    AuditModule,
    EventsModule,
    MailModule,
    NotificationsModule,
    WhatsappModule,
    BillingCoreModule,

    // --- Domaines metier ---
    TenantsModule,
    AuthModule,
    UsersModule,
    OnboardingModule,
    CustomersModule,
    CatalogModule,
    InventoryModule,
    OrdersModule,
    ConfirmationModule,
    ShipmentsModule,
    ReturnsModule,
    IntegrationsModule,
    BillingModule,
    DashboardModule,
    WebhooksModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applique a TOUTES les routes : le contexte doit exister meme pour une
    // requete anonyme, ne serait-ce que pour son identifiant de correlation.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
