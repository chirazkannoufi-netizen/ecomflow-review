/**
 * Referentiel geographique — lecture seule, commun a toutes les boutiques.
 *
 * DEUX REGIMES DE PERMISSION, ET LA LIGNE PASSE ENTRE LIRE ET AGIR
 *   Les deux routes de LECTURE n'exigent aucune permission metier : la liste
 *   des wilayas et des communes d'Algerie n'est la donnee de personne, et
 *   demander `ORDERS_CREATE` pour lire un nom de commune melangerait le droit
 *   de VOIR un referentiel public avec celui d'AGIR sur une boutique. Le garde
 *   d'authentification suffit.
 *
 *   Le GABARIT, lui, porte `ORDERS_CREATE`. Ce n'est pas un referentiel mais un
 *   outil de saisie : le telecharger n'a de sens que pour qui va s'en servir
 *   pour creer des commandes.
 */

import { Controller, Get, Header, Param, ParseIntPipe, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ecomflow/shared';
import { RequirePermissions } from '../../common/decorators';
import { GeoService } from './geo.service';
import { OrderTemplateService } from './order-template.service';

@ApiTags('Referentiel geographique')
@ApiBearerAuth()
@Controller('geo')
export class GeoController {
  constructor(
    private readonly geo: GeoService,
    private readonly template: OrderTemplateService,
  ) {}

  @Get('wilayas')
  @ApiOperation({
    summary: 'Les 58 wilayas du decoupage de 2019',
    description:
      'Servies depuis le paquet partage, ou elles font autorite : elles sont ' +
      'lues a chaque ligne d import pour resoudre les variantes de ' +
      'translitteration, ce qui exige une lecture synchrone (D-018).',
  })
  listWilayas() {
    return this.geo.listWilayas();
  }

  @Get('wilayas/:code/communes')
  @ApiOperation({
    summary: 'Communes d une wilaya',
    description:
      'Sert a REMPLIR une liste deroulante, pas a valider une saisie : une ' +
      'commune absente du referentiel reste une commune acceptable (D-018). ' +
      'Une wilaya sans commune connue renvoie une liste vide, pas une erreur.',
  })
  async listCommunes(@Param('code', ParseIntPipe) code: number) {
    return this.geo.listCommunes(code);
  }

  @Get('order-template.xlsx')
  @RequirePermissions(PERMISSIONS.ORDERS_CREATE)
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @Header('Content-Disposition', 'attachment; filename="ecomflow-commandes.xlsx"')
  @ApiOperation({
    summary: 'Gabarit d import de commandes',
    description:
      'Produit a la demande, avec les wilayas et les communes REELLEMENT en ' +
      'base : un gabarit fige se desynchroniserait du referentiel. La colonne ' +
      'Wilaya porte une liste de validation ; la commune reste libre, parce ' +
      'qu une commune inconnue n est pas une erreur (D-018).',
  })
  async orderTemplate(): Promise<StreamableFile> {
    return new StreamableFile(await this.template.build());
  }
}
