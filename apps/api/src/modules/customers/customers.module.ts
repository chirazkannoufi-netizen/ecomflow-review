import { Module } from '@nestjs/common';
import { CustomerStatsService } from './customer-stats.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomerStatsService, CustomersService],
  exports: [CustomerStatsService, CustomersService],
})
export class CustomersModule {}
