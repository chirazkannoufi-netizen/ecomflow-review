import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderWorkflowService } from './workflow/order-workflow.service';

/**
 * Domaine « commandes ».
 *
 * `OrderWorkflowService` est exporte : c'est le point d'entree unique des
 * changements de statut, utilise par la confirmation, la preparation,
 * l'expedition, le tracking, les retours et le filtre WhatsApp.
 */
@Module({
  imports: [InventoryModule, CustomersModule],
  controllers: [OrdersController],
  providers: [OrderWorkflowService, OrdersService],
  exports: [OrderWorkflowService, OrdersService],
})
export class OrdersModule {}
