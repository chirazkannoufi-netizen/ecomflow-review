import { Module } from '@nestjs/common';
import { ShipmentsModule } from '../shipments/shipments.module';
import { WebhooksController } from './webhooks.controller';

/**
 * Webhooks entrants. Le module ne contient aucun service : il ne fait
 * qu'exposer des routes qui delegent aux domaines concernes, apres
 * verification de signature.
 */
@Module({
  imports: [ShipmentsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
