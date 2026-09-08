/**
 * Garde de permissions, enregistre globalement (apres `JwtAuthGuard`).
 *
 * Applique la regle « toute requete backend doit verifier le tenant ET les
 * droits avant d'acceder aux donnees » (V2 §4). Le frontend n'est jamais une
 * source d'autorite : masquer un bouton n'interdit pas l'appel HTTP.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@ecomflow/shared';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
  PLATFORM_ADMIN_KEY,
  type PermissionMode,
} from '../decorators';
import { RequestContextStore } from '../../infra/context/request-context';
import { ForbiddenException, PermissionDeniedException } from '../errors/business.exception';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const requestContext = RequestContextStore.require();

    // --- Routes reservees a la plateforme ---------------------------------
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_KEY, targets)) {
      if (!requestContext.isPlatformAdmin) {
        throw new ForbiddenException(
          ERROR_CODES.FORBIDDEN,
          'Cette operation est reservee a l administration de la plateforme.',
        );
      }
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    if (!required || required.length === 0) {
      // Aucune permission declaree : la route exige seulement d'etre
      // authentifie (profil, deconnexion, liste de ses boutiques).
      return true;
    }

    const mode = this.reflector.getAllAndOverride<PermissionMode>(PERMISSIONS_MODE_KEY, targets) ?? 'ALL';
    const granted = requestContext.permissions;

    const satisfied =
      mode === 'ANY'
        ? required.some((permission) => granted.has(permission))
        : required.every((permission) => granted.has(permission));

    if (!satisfied) {
      throw new PermissionDeniedException(required);
    }

    return true;
  }
}
