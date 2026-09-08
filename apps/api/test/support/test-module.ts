/**
 * Montage d'un module NestJS pour les tests d'integration.
 *
 * On monte les VRAIS services, connectes a la VRAIE base : c'est tout l'objet
 * d'un test d'integration. Seules deux choses sont substituees :
 *
 *  - l'HORLOGE, remplacee par `FixedClockService`. Sans cela, tester
 *    « l'essai dure exactement 7 jours » exigerait d'attendre une semaine.
 *  - les passerelles SORTANTES (WhatsApp), qui appelleraient de vrais
 *    services tiers.
 *
 * Le garde d'isolation multi-tenant, lui, n'est JAMAIS neutralise : les tests
 * doivent s'executer dans les memes conditions que la production.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import type { Provider, Type } from '@nestjs/common';
import { AppConfigModule } from '../../src/config/config.module';
import { InfraModule } from '../../src/infra/infra.module';
import { ClockService, FixedClockService } from '../../src/infra/clock/clock.service';
import { AuditModule } from '../../src/modules/audit/audit.module';
import { EventsModule } from '../../src/modules/events/events.module';
import { MailModule } from '../../src/modules/notifications/mail/mail.module';
import { WhatsappModule } from '../../src/modules/whatsapp/whatsapp.module';
import { BillingCoreModule } from '../../src/modules/billing/billing-core.module';
import { CustomersModule } from '../../src/modules/customers/customers.module';
import { InventoryModule } from '../../src/modules/inventory/inventory.module';
import { OrdersModule } from '../../src/modules/orders/orders.module';
import { TenantsModule } from '../../src/modules/tenants/tenants.module';

export interface TestContext {
  readonly module: TestingModule;
  readonly clock: FixedClockService;
  get<T>(token: Type<T> | string | symbol): T;
  close(): Promise<void>;
}

export interface BuildTestModuleOptions {
  /** Modules supplementaires a monter. */
  readonly imports?: unknown[];
  /** Fournisseurs supplementaires ou substitutions. */
  readonly providers?: Provider[];
  /** Instant initial de l'horloge figee. */
  readonly now?: Date;
  /**
   * Substitutions de fournisseurs : `[[GoogleSheetsClient, fakeClient]]`.
   *
   * Reserve aux passerelles SORTANTES (Google, WhatsApp, transporteurs, paiement).
   * Substituer un service metier viderait le test d'integration de sa substance.
   */
  readonly overrides?: readonly [Type<unknown> | string | symbol, unknown][];
}

/** Modules du socle, montes pour tout test d'integration. */
const CORE_MODULES = [
  AppConfigModule,
  InfraModule,
  AuditModule,
  EventsModule,
  MailModule,
  WhatsappModule,
  BillingCoreModule,
  TenantsModule,
  CustomersModule,
  InventoryModule,
  OrdersModule,
];

export async function buildTestModule(
  options: BuildTestModuleOptions = {},
): Promise<TestContext> {
  const clock = new FixedClockService(options.now ?? new Date('2026-08-29T10:00:00.000Z'));

  let builder = Test.createTestingModule({
    imports: [...CORE_MODULES, ...((options.imports ?? []) as never[])],
    providers: options.providers ?? [],
  })
    // L'horloge figee est injectee a la place de l'horloge systeme dans TOUS
    // les services : les regles temporelles deviennent testables au jour pres.
    .overrideProvider(ClockService)
    .useValue(clock);

  for (const [token, value] of options.overrides ?? []) {
    builder = builder.overrideProvider(token as never).useValue(value);
  }

  const module = await builder.compile();

  await module.init();

  return {
    module,
    clock,
    get: <T>(token: Type<T> | string | symbol): T => module.get<T>(token, { strict: false }),
    close: async () => {
      await module.close();
    },
  };
}
