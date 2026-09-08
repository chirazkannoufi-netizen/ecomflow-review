import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { ScheduledJobsService } from './scheduled-jobs.service';

/**
 * Traitements planifies.
 *
 * Ce module n'expose aucune route : il orchestre les services metier a
 * intervalle regulier. Les taches sont neutralisees en environnement de test
 * (`config.isTest`) pour que les suites restent deterministes.
 */
@Module({
  imports: [IntegrationsModule, ShipmentsModule, BillingModule, NotificationsModule],
  providers: [ScheduledJobsService],
  exports: [ScheduledJobsService],
})
export class JobsModule {}
