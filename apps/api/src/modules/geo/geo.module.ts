import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { OrderTemplateService } from './order-template.service';

/**
 * Referentiel geographique.
 *
 * `GeoService` est EXPORTE : le rapprochement d'un libelle de commune sert aussi
 * a l'import et a la generation du gabarit Excel, pas seulement a l'ecran.
 */
@Module({
  controllers: [GeoController],
  providers: [GeoService, OrderTemplateService],
  exports: [GeoService, OrderTemplateService],
})
export class GeoModule {}
