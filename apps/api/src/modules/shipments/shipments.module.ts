import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ReturnsModule } from '../returns/returns.module';
import { CARRIER_ADAPTERS, type CarrierAdapter } from './carriers/carrier-adapter.interface';
import { CarrierRegistry } from './carriers/carrier.registry';
import { MockCarrierAdapter } from './carriers/mock-carrier.adapter';
import { createEcotrackAdapters } from './carriers/ecotrack.adapter';
import { YalidineAdapter, createYalidineResellers } from './carriers/yalidine.adapter';
import { ZrExpressAdapter } from './carriers/zr-express.adapter';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';
import { TrackingService } from './tracking.service';

/**
 * Expedition et suivi.
 *
 * AJOUTER UN TRANSPORTEUR
 *   1. ecrire l'adaptateur, en implementant `CarrierAdapter` ;
 *   2. l'ajouter au tableau injecte dans `CARRIER_ADAPTERS` ;
 *   3. ajouter sa ligne au catalogue `carriers` dans le seed, avec
 *      `implementationStatus: 'UNVERIFIED'` — et `'AVAILABLE'` seulement une
 *      fois qu'il a tourne contre un compte marchand reel (D-070).
 *   Aucun service metier n'est modifie.
 *
 * AJOUTER UNE SOCIETE D'UNE FAMILLE EXISTANTE
 *   Rien a ecrire : une ligne d'identite dans `YALIDINE_RESELLERS` ou
 *   `ECOTRACK_TENANTS`, et sa ligne au catalogue. Guepex, Yalitec et We Can
 *   revendent le reseau Yalidine ; DHD, Conexlog (« UPS ») et SpeedMail
 *   tournent sur Ecotrack. Meme API, autre domaine — donc le meme code, pas
 *   une copie de plus (D-070).
 *
 *   Seul Yalidine est `@Injectable` : le module et les tests le designent par
 *   son type. Les autres sont des INSTANCES, construites ici.
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
        ...createYalidineResellers(),
        ...createEcotrackAdapters(),
        new ZrExpressAdapter(),
      ],
    },
    CarrierRegistry,
    ShipmentsService,
    TrackingService,
  ],
  exports: [ShipmentsService, TrackingService, CarrierRegistry, MockCarrierAdapter],
})
export class ShipmentsModule {}
