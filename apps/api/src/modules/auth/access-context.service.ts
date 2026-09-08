/**
 * Resolution des droits effectifs d'un utilisateur sur une boutique.
 *
 * Repond a une question unique, posee a chaque requete authentifiee :
 * « cet utilisateur peut-il agir sur ce tenant, et avec quelles permissions ? »
 *
 * DECISION : les permissions ne sont PAS embarquees dans le jeton d'acces.
 *   Un jeton vit 15 minutes. Y figer les permissions signifierait qu'un retrait
 *   de droits (depart d'un agent, retrogradation) resterait sans effet pendant
 *   ce delai. Sur une plateforme ou un agent de confirmation manipule des
 *   donnees clients, ce delai est inacceptable.
 *   Les permissions sont donc relues, avec un cache memoire tres court
 *   (quelques secondes) invalide explicitement des qu'un role change.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { ForbiddenException, UnauthorizedException } from '../../common/errors/business.exception';

/** Duree de vie du cache de permissions. Court par choix de securite. */
const PERMISSION_CACHE_TTL_MS = 5_000;

export interface ResolvedAccess {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly membershipId: string | null;
  readonly roleCode: string | null;
  readonly permissions: ReadonlySet<string>;
  readonly isPlatformAdmin: boolean;
  readonly tenantStatus: string | null;
}

interface CacheEntry {
  readonly value: ResolvedAccess;
  readonly expiresAt: number;
}

@Injectable()
export class AccessContextService {
  private readonly logger = new Logger(AccessContextService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly clock: ClockService,
  ) {}

  /**
   * Resout les droits d'un utilisateur sur une boutique donnee.
   *
   * @param userId utilisateur authentifie
   * @param requestedTenantId boutique demandee (jeton ou en-tete X-Tenant-Id)
   */
  async resolve(userId: string, requestedTenantId: string | null): Promise<ResolvedAccess> {
    const cacheKey = `${userId}:${requestedTenantId ?? '-'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.clock.timestamp()) {
      return cached.value;
    }

    const resolved = await this.load(userId, requestedTenantId);
    this.cache.set(cacheKey, {
      value: resolved,
      expiresAt: this.clock.timestamp() + PERMISSION_CACHE_TTL_MS,
    });
    return resolved;
  }

  /**
   * Invalide le cache d'un utilisateur.
   * Appele des qu'un role, une permission ou une adhesion change, afin que la
   * revocation soit immediate et non differee de quelques secondes.
   */
  invalidateUser(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}:`)) this.cache.delete(key);
    }
  }

  /** Invalide le cache de tous les membres d'une boutique. */
  invalidateTenant(tenantId: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${tenantId}`)) this.cache.delete(key);
    }
  }

  /** Vide integralement le cache (changement de definition d'un role systeme). */
  invalidateAll(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------

  private async load(userId: string, requestedTenantId: string | null): Promise<ResolvedAccess> {
    // Cette lecture precede l'etablissement du perimetre tenant : elle est
    // donc explicitement declaree hors perimetre.
    return RequestContextStore.runUnscoped('AUTHENTICATION', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          status: true,
          platformRoleLinks: {
            select: {
              role: {
                select: {
                  code: true,
                  scope: true,
                  permissions: { select: { permission: { select: { key: true } } } },
                },
              },
            },
          },
        },
      });

      if (!user) {
        throw new UnauthorizedException(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          'Compte introuvable. Veuillez vous reconnecter.',
        );
      }

      if (user.status === 'DISABLED') {
        throw new UnauthorizedException(
          ERROR_CODES.AUTH_ACCOUNT_DISABLED,
          'Ce compte a ete desactive.',
        );
      }

      if (user.status === 'LOCKED') {
        throw new UnauthorizedException(
          ERROR_CODES.AUTH_ACCOUNT_LOCKED,
          'Ce compte est temporairement verrouille.',
        );
      }

      // --- Droits de plateforme (SUPER_ADMIN) ------------------------------
      const platformPermissions = new Set<string>();
      for (const link of user.platformRoleLinks) {
        for (const entry of link.role.permissions) {
          platformPermissions.add(entry.permission.key);
        }
      }
      const isPlatformAdmin = platformPermissions.size > 0;

      // --- Droits sur la boutique ------------------------------------------
      const memberships = await this.prisma.membership.findMany({
        where: { userId, status: 'ACTIVE' },
        select: {
          id: true,
          tenantId: true,
          createdAt: true,
          tenant: { select: { status: true } },
          role: {
            select: {
              code: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      const membership = requestedTenantId
        ? memberships.find((entry) => entry.tenantId === requestedTenantId)
        : memberships[0];

      if (requestedTenantId && !membership) {
        // L'utilisateur demande une boutique dont il n'est pas membre.
        // Un Super Admin peut acceder a n'importe quelle boutique dans le
        // cadre de l'administration ; tout autre utilisateur est refuse.
        if (isPlatformAdmin) {
          const tenant = await this.prisma.tenant.findUnique({
            where: { id: requestedTenantId },
            select: { status: true },
          });
          if (!tenant) {
            throw new ForbiddenException(
              ERROR_CODES.TENANT_NOT_FOUND,
              'Boutique introuvable.',
            );
          }
          return {
            userId,
            tenantId: requestedTenantId,
            membershipId: null,
            roleCode: 'SUPER_ADMIN',
            permissions: platformPermissions,
            isPlatformAdmin: true,
            tenantStatus: tenant.status,
          };
        }

        this.logger.warn(
          `Acces refuse : utilisateur=${userId} a demande la boutique ${requestedTenantId} ` +
            'sans adhesion active.',
        );
        throw new ForbiddenException(
          ERROR_CODES.TENANT_ACCESS_DENIED,
          'Vous n avez pas acces a cette boutique.',
        );
      }

      if (!membership) {
        // Compte sans boutique : legitime pour un Super Admin, ou pour un
        // utilisateur dont l'onboarding n'est pas termine.
        return {
          userId,
          tenantId: null,
          membershipId: null,
          roleCode: isPlatformAdmin ? 'SUPER_ADMIN' : null,
          permissions: platformPermissions,
          isPlatformAdmin,
          tenantStatus: null,
        };
      }

      const permissions = new Set<string>(platformPermissions);
      for (const entry of membership.role.permissions) {
        permissions.add(entry.permission.key);
      }

      return {
        userId,
        tenantId: membership.tenantId,
        membershipId: membership.id,
        roleCode: membership.role.code,
        permissions,
        isPlatformAdmin,
        tenantStatus: membership.tenant.status,
      };
    });
  }
}
