/**
 * API de l'assistant d'onboarding — `/onboarding/*` (Addendum §34).
 *
 * Ces routes restent accessibles meme sans abonnement operationnel : un
 * commercant doit pouvoir terminer sa configuration a tout moment.
 */

import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantId } from '../../common/decorators';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@ApiBearerAuth()
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('state')
  @ApiOperation({
    summary: 'Etat d avancement de la configuration',
    description:
      'Chaque etape est VERIFIEE contre la base, pas lue depuis un drapeau : ' +
      'si un jeton Google est revoque, l etape correspondante repasse a ' +
      '« non faite ». La progression ne compte que les etapes obligatoires.',
  })
  async state(@TenantId() tenantId: string) {
    return this.onboarding.getState(tenantId);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finaliser l onboarding et activer la boutique',
    description:
      'Refuse tant que les etapes obligatoires ne sont pas franchies, en ' +
      'listant precisement ce qui manque. Activer une boutique incapable de ' +
      'recevoir une commande serait un faux depart.',
  })
  async complete(@TenantId() tenantId: string) {
    return this.onboarding.complete(tenantId);
  }
}
