/**
 * Creation complete d'une boutique.
 *
 * Une boutique n'est utilisable que si TOUT son socle existe : roles,
 * permissions, parametres, abonnement d'essai, progression d'onboarding,
 * adhesion du proprietaire. Cette operation est donc ATOMIQUE : soit la
 * boutique existe entierement, soit elle n'existe pas du tout.
 *
 * Une boutique a moitie creee — sans roles, sans abonnement — serait un piege :
 * l'utilisateur se connecterait sans aucun droit, sans essai, sans pouvoir
 * rien faire ni comprendre pourquoi.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_LABELS,
  TENANT_ROLES,
  TRIAL_DURATION_DAYS,
  computeTrialEnd,
} from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { ConflictException } from '../../common/errors/business.exception';
import { ERROR_CODES } from '@ecomflow/shared';

export interface ProvisionTenantParams {
  readonly name: string;
  readonly ownerUserId: string;
  /** Statut initial : ONBOARDING tant que l'assistant n'est pas termine. */
  readonly status?: 'ONBOARDING' | 'ACTIVE';
  /** Demarre l'essai gratuit. Faux pour une boutique creee par le Super Admin. */
  readonly startTrial?: boolean;
  readonly timezone?: string;
}

export interface ProvisionedTenant {
  readonly tenantId: string;
  readonly slug: string;
  readonly ownerMembershipId: string;
  readonly trialEndAt: Date | null;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly clock: ClockService,
  ) {}

  /**
   * Cree une boutique et tout son socle, dans une seule transaction.
   *
   * @param tx transaction existante, si l'appelant orchestre deja un ensemble
   *           plus large (inscription : utilisateur + boutique + anti-abus).
   */
  async provision(
    params: ProvisionTenantParams,
    tx?: PrismaTransactionClient,
  ): Promise<ProvisionedTenant> {
    if (tx) return this.provisionWithin(tx, params);

    return this.prisma.$transaction((transaction) =>
      this.provisionWithin(transaction as PrismaTransactionClient, params),
    );
  }

  private async provisionWithin(
    tx: PrismaTransactionClient,
    params: ProvisionTenantParams,
  ): Promise<ProvisionedTenant> {
    const now = this.clock.now();
    const slug = await this.allocateSlug(tx, params.name);

    // La creation de la boutique elle-meme precede l'etablissement du
    // perimetre : elle s'execute donc hors scope, puis tout le reste est
    // encadre par `runWithTenant`.
    const tenant = await RequestContextStore.runUnscoped('BOOTSTRAP', () =>
      tx.tenant.create({
        data: {
          name: params.name.trim(),
          slug,
          status: params.status ?? 'ONBOARDING',
          timezone: params.timezone ?? 'Africa/Algiers',
          createdByUserId: params.ownerUserId,
        },
        select: { id: true, slug: true },
      }),
    );

    return RequestContextStore.runWithTenant(tenant.id, async () => {
      // --- Roles de la boutique -------------------------------------------
      const roleIdsByCode = await this.createTenantRoles(tx, tenant.id);

      const ownerRoleId = roleIdsByCode.get('OWNER');
      /* istanbul ignore next -- OWNER fait partie de TENANT_ROLES */
      if (!ownerRoleId) {
        throw new Error('Role OWNER absent apres provisionnement de la boutique.');
      }

      // --- Adhesion du proprietaire ---------------------------------------
      const membership = await tx.membership.create({
        data: {
          tenantId: tenant.id,
          userId: params.ownerUserId,
          roleId: ownerRoleId,
          status: 'ACTIVE',
          joinedAt: now,
        },
        select: { id: true },
      });

      // --- Parametres par defaut ------------------------------------------
      await tx.tenantSettings.create({ data: { tenantId: tenant.id } });

      // --- Progression d'onboarding (Addendum §34) ------------------------
      await tx.onboardingProgress.create({
        data: {
          tenantId: tenant.id,
          completedSteps: ['ACCOUNT_CREATED', 'STORE_CREATED'],
          currentStep: 'ORDER_SOURCE_CONNECTED',
        },
      });

      // --- Abonnement / essai gratuit -------------------------------------
      const startTrial = params.startTrial ?? true;
      const trialEndAt = startTrial ? computeTrialEnd(now) : null;

      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          status: startTrial ? 'TRIAL_ACTIVE' : 'EXPIRED',
          trialStartAt: startTrial ? now : null,
          trialEndAt,
          lastEvaluatedAt: now,
        },
      });

      // --- Sequence de references de commande pour l'annee en cours -------
      await tx.orderSequence.create({
        data: { tenantId: tenant.id, year: now.getUTCFullYear(), lastValue: 0 },
      });

      this.logger.log(
        `Boutique provisionnee : ${tenant.slug} (${tenant.id}), essai ${
          startTrial ? `${TRIAL_DURATION_DAYS} jours` : 'desactive'
        }.`,
      );

      return {
        tenantId: tenant.id,
        slug: tenant.slug,
        ownerMembershipId: membership.id,
        trialEndAt,
      };
    });
  }

  /**
   * Cree les roles systeme de la boutique avec leur jeu de permissions.
   *
   * Les permissions sont resolues depuis la table `permissions`, qui fait
   * autorite en base. Une permission declaree dans `@ecomflow/shared` mais
   * absente de la base (seed non rejoue apres une mise a jour) est signalee
   * plutot qu'ignoree silencieusement.
   */
  private async createTenantRoles(
    tx: PrismaTransactionClient,
    tenantId: string,
  ): Promise<Map<string, string>> {
    const permissionRows = await tx.permission.findMany({
      where: { isPlatform: false },
      select: { id: true, key: true },
    });
    const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));

    const roleIdsByCode = new Map<string, string>();

    for (const code of TENANT_ROLES) {
      const role = await tx.role.create({
        data: {
          tenantId,
          scope: 'TENANT',
          code,
          name: SYSTEM_ROLE_LABELS[code],
          description: SYSTEM_ROLE_DESCRIPTIONS[code],
          isSystem: true,
        },
        select: { id: true },
      });
      roleIdsByCode.set(code, role.id);

      const keys = DEFAULT_ROLE_PERMISSIONS[code];
      const links: { roleId: string; permissionId: string }[] = [];
      const missing: string[] = [];

      for (const key of keys) {
        const permissionId = permissionIdByKey.get(key);
        if (!permissionId) {
          missing.push(key);
          continue;
        }
        links.push({ roleId: role.id, permissionId });
      }

      if (missing.length > 0) {
        // Signale sans bloquer : la boutique reste utilisable avec les
        // permissions connues, et l'exploitant sait qu'il doit rejouer le seed.
        this.logger.error(
          `Permissions absentes de la base pour le role ${code} : ${missing.join(', ')}. ` +
            'Executez `npm run seed` pour synchroniser le catalogue des permissions.',
        );
      }

      if (links.length > 0) {
        await tx.rolePermission.createMany({ data: links, skipDuplicates: true });
      }
    }

    return roleIdsByCode;
  }

  /**
   * Genere un identifiant d'URL unique a partir du nom de la boutique.
   *
   * En cas de collision, un suffixe numerique est ajoute. La boucle est bornee :
   * au-dela, un suffixe aleatoire garantit la terminaison plutot que de risquer
   * une boucle infinie sur un nom tres commun.
   */
  private async allocateSlug(tx: PrismaTransactionClient, name: string): Promise<string> {
    const base = slugify(name) || 'boutique';

    return RequestContextStore.runUnscoped('BOOTSTRAP', async () => {
      for (let suffix = 0; suffix < 25; suffix += 1) {
        const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
        const existing = await tx.tenant.findUnique({
          where: { slug: candidate },
          select: { id: true },
        });
        if (!existing) return candidate;
      }

      const random = Math.random().toString(36).slice(2, 8);
      const candidate = `${base}-${random}`;
      const existing = await tx.tenant.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException(
          ERROR_CODES.CONFLICT,
          'Impossible de generer un identifiant unique pour cette boutique. Reessayez.',
        );
      }
      return candidate;
    });
  }
}

/** Transforme un nom en identifiant d'URL : « Boutique Sara » -> `boutique-sara`. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
