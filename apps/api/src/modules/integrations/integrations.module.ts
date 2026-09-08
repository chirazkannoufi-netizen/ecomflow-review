import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { GoogleOAuthService } from './google/google-oauth.service';
import { GoogleSheetsClient } from './google/google-sheets.client';
import { SheetConfigService } from './google/sheet-config.service';
import { SheetSyncService } from './google/sheet-sync.service';
import { IntegrationsController } from './integrations.controller';

/**
 * Integrations de sources de commandes.
 *
 * `GoogleSheetsClient` est un singleton : son limiteur de debit protege le
 * quota du PROJET Google, partage par toutes les boutiques. En instancier un
 * par tenant reviendrait a multiplier le quota autorise par le nombre de
 * boutiques — et a le depasser aussitot.
 */
@Module({
  imports: [OrdersModule],
  controllers: [IntegrationsController],
  providers: [GoogleOAuthService, GoogleSheetsClient, SheetSyncService, SheetConfigService],
  exports: [GoogleOAuthService, GoogleSheetsClient, SheetSyncService, SheetConfigService],
})
export class IntegrationsModule {}
