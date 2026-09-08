/**
 * Garde d'abonnement.
 *
 * Bloque les routes marquees `@RequiresOperationalSubscription()` lorsque
 * l'essai est termine et qu'aucun abonnement actif ne prend le relais
 * (V1 §21, V2 §7, critere d'acceptation : « apres expiration sans abonnement
 * actif, les fonctionnalites operationnelles sont bloquees »).
 *
 * CE QUI RESTE ACCESSIBLE apres expiration, volontairement :
 *   - la consultation des donnees deja saisies ;
 *   - l'export (le commercant doit pouvoir recuperer ses donnees) ;
 *   - la gestion de l'abonnement et le paiement ;
 *   - le profil et la deconnexion.
 * Bloquer ces routes transformerait une fin d'essai en prise en otage des
 * donnees, ce que la loi 18-07 et le simple bon sens commercial excluent.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, SUBSCRIPTION_KEY } from '../decorators';
import { RequestContextStore } from '../../infra/context/request-context';
import { SubscriptionRequiredException } from '../errors/business.exception';
import { SubscriptionStateService } from '../../modules/billing/subscription-state.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<boolean>(SUBSCRIPTION_KEY, targets);
    if (!required) return true;

    const requestContext = RequestContextStore.require();

    // Un administrateur de plateforme intervient en support : il n'est pas
    // soumis a l'abonnement de la boutique qu'il assiste.
    if (requestContext.isPlatformAdmin) return true;

    if (!requestContext.tenantId) {
      // Aucune boutique active : la route operationnelle n'a pas de sens.
      throw new SubscriptionRequiredException(
        'EXPIRED',
        'Aucune boutique active sur cette session.',
      );
    }

    const state = await this.subscriptions.getState(requestContext.tenantId);
    if (!state.operational) {
      throw new SubscriptionRequiredException(state.status, state.reason);
    }

    return true;
  }
}
