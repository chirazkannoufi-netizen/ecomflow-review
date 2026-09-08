import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ReturnsModule } from '../returns/returns.module';
import { CARRIER_ADAPTERS, type CarrierAdapter } from './carriers/carrier-adapter.interface';
import { CarrierRegistry } from './carriers/carrier.registry';
import { MockCarrierAdapter } from './carriers/mock-carrier.adapter';
import { YalidineAdapter } from './carriers/yalidine.adapter';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';
import { TrackingService } from './tracking.service';

/**
 * Expedition et suivi.
 *
 * AJOUTER UN TRANSPORTEUR
 *   1. ecrire l'adaptateur, en implementant `CarrierAdapter` ;
 *   2. le declarer dans `providers` ;
 *   3. l'ajouter au tableau injecte dans `CARRIER_ADAPTERS` ;
 *   4. ajouter sa ligne au catalogue `carriers` dans le seed, avec
 *      `implementationStatus: 'AVAILABLE'`.
 *   Aucun service metier n'est modifie.
 */
@Module({
  imports: [OrdersModule, ReturnsModule],
  controllers: [ShipmentsController],
  providers: [
    MockCarrierAdapter,
    YalidineAdapter,
    {
      provide: CARRIER_ADAPTERS,
      inject: [MockCarrierAdapter, YalidineAdapter],
      useFactory: (mock: MockCarrierAdapter, yalidine: YalidineAdapter): CarrierAdapter[] => [
        mock,
        yalidine,
      ],
    },
    CarrierRegistry,
    ShipmentsService,
    TrackingService,
  ],
  exports: [ShipmentsService, TrackingService, CarrierRegistry, MockCarrierAdapter],
})
export class ShipmentsModule {}
