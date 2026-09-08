import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersModule } from '../orders/orders.module';
import { ReturnsService } from './returns.service';

@Module({
  imports: [InventoryModule, OrdersModule],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
