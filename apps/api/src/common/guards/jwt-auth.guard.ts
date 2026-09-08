/**
 * Garde d'authentification, enregistre GLOBALEMENT.
 *
 * Consequence : toute route est fermee par defaut. Ouvrir une route demande un
 * `@Public()` explicite. Une route ajoutee sans y penser est donc protegee,
 * jamais exposee — c'est l'inverse du reglage par defaut le plus dangereux.
 *
 * Le garde :
 *  1. verifie le jeton d'acces ;
 *  2. resout l'adhesion et les permissions effectives ;
 *  3. enrichit le contexte de requete, ce qui active du meme coup le garde
 *     d'isolation Prisma pour tout le reste du traitement.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ERROR_CODES, TENANT_HEADER } from '@ecomflow/shared';
import { IS_PUBLIC_KEY } from '../decorators';
import { RequestContextStore } from '../../infra/context/request-context';
import { UnauthorizedException } from '../errors/business.exception';
import { AccessContextService } from '../../modules/auth/access-context.service';
import { TokenService } from '../../modules/auth/token.service';

/** Format d'identifiant accepte dans l'en-tete de selection de boutique. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();

    if (isPublic) {
      // Une route publique reste non authentifiee, mais on marque le contexte
      // pour que le garde Prisma n'echoue pas sur une lecture legitime
      // (consultation des plans tarifaires, par exemple).
      RequestContextStore.update({ unscopedReason: 'AUTHENTICATION' });
      return true;
    }

    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        'Authentification requise.',
      );
    }

    const payload = await this.tokens.verifyAccessToken(token);

    // La boutique demandee provient de l'en-tete si l'utilisateur en change,
    // sinon de celle inscrite dans le jeton. Elle est TOUJOURS revalidee
    // contre les adhesions reelles : un en-tete forge ne donne aucun acces.
    const requestedTenantId = this.extractTenantId(request) ?? payload.tid;

    const resolved = await this.access.resolve(payload.sub, requestedTenantId);

    if (resolved.tenantStatus === 'SUSPENDED' && !resolved.isPlatformAdmin) {
      throw new UnauthorizedException(
        ERROR_CODES.TENANT_SUSPENDED,
        'Cette boutique est suspendue. Contactez le support.',
      );
    }

    RequestContextStore.update({
      userId: resolved.userId,
      tenantId: resolved.tenantId,
      membershipId: resolved.membershipId,
      permissions: resolved.permissions,
      isPlatformAdmin: resolved.isPlatformAdmin,
      // Un Super Admin sans boutique selectionnee travaille hors perimetre.
      unscopedReason: resolved.tenantId ? null : 'PLATFORM_ADMIN',
    });

    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.get('authorization');
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
    return value.trim();
  }

  private extractTenantId(request: Request): string | null {
    const raw = request.get(TENANT_HEADER);
    if (!raw) return null;
    const value = raw.trim();
    // Une valeur malformee est ignoree plutot que propagee : elle ne doit ni
    // atteindre la base, ni apparaitre dans un message d'erreur.
    return UUID_PATTERN.test(value) ? value : null;
  }
}
