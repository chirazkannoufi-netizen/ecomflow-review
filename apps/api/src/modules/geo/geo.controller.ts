/**
 * Referentiel geographique — lecture seule, commun a toutes les boutiques.
 *
 * PAS DE PERMISSION METIER SUR CES ROUTES
 *   La liste des wilayas et des communes d'Algerie n'est la donnee de personne.
 *   Exiger `ORDERS_CREATE` pour lire un nom de commune melangerait le droit de
 *   VOIR un referentiel public avec celui d'AGIR sur une boutique. Le garde
 *   d'authentification suffit : il faut etre connecte, rien de plus.
 */

import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GeoService } from './geo.service';

@ApiTags('Referentiel geographique')
@ApiBearerAuth()
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

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
}
