/**
 * Utilisateurs, roles et permissions d'une boutique — V1 §4, V2 §4.
 *
 * DEUX GARDE-FOUS ANTI AUTO-VERROUILLAGE
 *
 *  1. On ne peut jamais retirer le DERNIER proprietaire d'une boutique. Sans
 *     cette regle, un OWNER pourrait se retrograder par erreur et rendre sa
 *     propre boutique inadministrable — il faudrait alors une intervention
 *     manuelle de la plateforme.
 *
 *  2. Le role OWNER conserve toujours l'integralite des permissions tenant.
 *     Amputer OWNER produirait le meme blocage par un autre chemin.
 *
 * REVOCATION IMMEDIATE
 *   Tout changement de role ou d'adhesion invalide le cache de permissions de
 *   l'utilisateur concerne : le retrait de droits prend effet a la requete
 *   suivante, pas au bout de quelques secondes (D-006).
 */

import { Injectable } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  ERROR_CODES,
  IMMUTABLE_ROLES,
  PERMISSION_CATALOG,
  TENANT_PERMISSIONS,
  isSystemRole,
} from '@ecomflow/shared';
import {
  ConflictException,
  NotFoundException,
  ValidationException,
} from '../../common/errors/business.exception';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { AccessContextService } from '../auth/access-context.service';
import { AuditService } from '../audit/audit.service';
import { HashService } from '../../infra/crypto/hash.service';
import { MailService } from '../notifications/mail/mail.service';
import { AppConfigService } from '../../config/configuration';

@Injectable()
export class UsersService {
  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly access: AccessContextService,
    private readonly audit: AuditService,
    private readonly hash: HashService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // MEMBRES
  // ==========================================================================

  async listMembers(tenantId: string) {
    return this.prisma.membership.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        invitedAt: true,
        joinedAt: true,
        createdAt: true,
        role: { select: { id: true, code: true, name: true, isSystem: true } },
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            status: true,
            lastLoginAt: true,
            phoneVerifiedAt: true,
          },
        },
      },
    });
  }

  /**
   * Invite un membre.
   *
   * Un utilisateur EXISTANT est simplement rattache a la boutique : on ne cree
   * jamais un second compte pour une meme adresse, ce qui produirait deux
   * identites concurrentes.
   */
  async inviteMember(
    tenantId: string,
    input: { email: string; fullName: string; roleId: string },
  ): Promise<{ membershipId: string; userExisted: boolean; temporaryPassword?: string }> {
    const role = await this.prisma.role.findFirst({
      where: { tenantId, id: input.roleId },
      select: { id: true, code: true, name: true },
    });

    if (!role) {
      throw new NotFoundException(ERROR_CODES.ROLE_NOT_FOUND, 'Role introuvable dans cette boutique.');
    }

    const email = input.email.trim().toLowerCase();

    return RequestContextStore.runUnscoped('PLATFORM_ADMIN', async () => {
      const existingUser = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true, fullName: true },
      });

      const existingMembership = existingUser
        ? await this.prisma.membership.findFirst({
            where: { tenantId, userId: existingUser.id },
            select: { id: true },
          })
        : null;

      if (existingMembership) {
        throw new ConflictException(
          ERROR_CODES.USER_ALREADY_MEMBER,
          'Cette personne est deja membre de la boutique.',
        );
      }

      // Mot de passe provisoire pour un nouveau compte. Il n'est retourne
      // qu'a l'appelant (l'administrateur qui invite) et envoye par e-mail :
      // il n'est jamais stocke en clair.
      const temporaryPassword = existingUser ? undefined : this.hash.generateToken(9);

      const userId =
        existingUser?.id ??
        (
          await this.prisma.user.create({
            data: {
              email,
              fullName: input.fullName.trim(),
              passwordHash: await this.hash.hashPassword(temporaryPassword as string),
              status: 'ACTIVE',
            },
            select: { id: true },
          })
        ).id;

      const membership = await this.prisma.membership.create({
        data: {
          tenantId,
          userId,
          roleId: role.id,
          status: 'ACTIVE',
          invitedAt: this.clock.now(),
          joinedAt: existingUser ? this.clock.now() : null,
        },
        select: { id: true },
      });

      this.access.invalidateUser(userId);

      await this.audit.record({
        action: 'USER_INVITED',
        entityType: 'Membership',
        entityId: membership.id,
        tenantId,
        metadata: { email, roleCode: role.code, userExisted: Boolean(existingUser) },
      });

      await this.sendInvitationEmail(email, input.fullName, role.name, temporaryPassword);

      return {
        membershipId: membership.id,
        userExisted: Boolean(existingUser),
        ...(temporaryPassword ? { temporaryPassword } : {}),
      };
    });
  }

  /** Change le role d'un membre. */
  async changeRole(tenantId: string, membershipId: string, roleId: string): Promise<void> {
    const [membership, role] = await Promise.all([
      this.prisma.membership.findFirst({
        where: { tenantId, id: membershipId },
        select: { id: true, userId: true, role: { select: { code: true } } },
      }),
      this.prisma.role.findFirst({
        where: { tenantId, id: roleId },
        select: { id: true, code: true },
      }),
    ]);

    if (!membership) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Membre introuvable.');
    }
    if (!role) {
      throw new NotFoundException(ERROR_CODES.ROLE_NOT_FOUND, 'Role introuvable.');
    }

    if (membership.role.code === 'OWNER' && role.code !== 'OWNER') {
      await this.assertNotLastOwner(tenantId, membershipId);
    }

    await this.prisma.membership.update({ where: { id: membershipId }, data: { roleId } });
    this.access.invalidateUser(membership.userId);

    await this.audit.record({
      action: 'USER_ROLE_CHANGED',
      entityType: 'Membership',
      entityId: membershipId,
      tenantId,
      metadata: { from: membership.role.code, to: role.code },
    });
  }

  /** Desactive un membre sans supprimer son historique. */
  async deactivateMember(tenantId: string, membershipId: string): Promise<void> {
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, id: membershipId },
      select: { id: true, userId: true, status: true, role: { select: { code: true } } },
    });

    if (!membership) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Membre introuvable.');
    }

    if (membership.role.code === 'OWNER') {
      await this.assertNotLastOwner(tenantId, membershipId);
    }

    await this.prisma.membership.update({
      where: { id: membershipId },
      data: { status: 'DISABLED' },
    });

    this.access.invalidateUser(membership.userId);

    await this.audit.record({
      action: 'USER_DEACTIVATED',
      entityType: 'Membership',
      entityId: membershipId,
      tenantId,
    });
  }

  async reactivateMember(tenantId: string, membershipId: string): Promise<void> {
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, id: membershipId },
      select: { userId: true },
    });

    if (!membership) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Membre introuvable.');
    }

    await this.prisma.membership.update({
      where: { id: membershipId },
      data: { status: 'ACTIVE' },
    });
    this.access.invalidateUser(membership.userId);
  }

  // ==========================================================================
  // ROLES ET PERMISSIONS
  // ==========================================================================

  async listRoles(tenantId: string) {
    const roles = await this.prisma.role.findMany({
      where: { tenantId },
      orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        isSystem: true,
        permissions: { select: { permission: { select: { key: true } } } },
        _count: { select: { memberships: true } },
      },
    });

    return roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      /** Un role immuable ne peut pas voir ses permissions modifiees. */
      immutable: isSystemRole(role.code) && IMMUTABLE_ROLES.includes(role.code),
      permissions: role.permissions.map((entry) => entry.permission.key),
      memberCount: role._count.memberships,
    }));
  }

  /** Catalogue des permissions attribuables, groupe pour l'interface. */
  listPermissionCatalog() {
    return PERMISSION_CATALOG.filter((entry) =>
      (TENANT_PERMISSIONS as readonly string[]).includes(entry.key),
    );
  }

  /** Cree un role personnalise. */
  async createRole(
    tenantId: string,
    input: { name: string; description?: string; permissions: readonly string[] },
  ): Promise<{ roleId: string }> {
    this.assertPermissionsAssignable(input.permissions);

    const code = input.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);

    if (isSystemRole(code)) {
      throw new ValidationException(
        `« ${code} » est un nom de role reserve. Choisissez un autre libelle.`,
      );
    }

    return this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      const role = await tx.role.create({
        data: {
          tenantId,
          scope: 'TENANT',
          code,
          name: input.name.trim(),
          description: input.description ?? null,
          isSystem: false,
        },
        select: { id: true },
      });

      await this.replacePermissions(tx, role.id, input.permissions);
      this.access.invalidateTenant(tenantId);

      return { roleId: role.id };
    });
  }

  /** Remplace le jeu de permissions d'un role. */
  async updateRolePermissions(
    tenantId: string,
    roleId: string,
    permissions: readonly string[],
  ): Promise<void> {
    const role = await this.prisma.role.findFirst({
      where: { tenantId, id: roleId },
      select: { id: true, code: true, isSystem: true },
    });

    if (!role) {
      throw new NotFoundException(ERROR_CODES.ROLE_NOT_FOUND, 'Role introuvable.');
    }

    if (isSystemRole(role.code) && IMMUTABLE_ROLES.includes(role.code)) {
      throw new ConflictException(
        ERROR_CODES.ROLE_IMMUTABLE,
        `Le role ${role.code} conserve toujours l integralite de ses permissions : ` +
          'l amputer rendrait la boutique inadministrable.',
      );
    }

    this.assertPermissionsAssignable(permissions);

    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;
      await this.replacePermissions(tx, roleId, permissions);
    });

    this.access.invalidateTenant(tenantId);

    await this.audit.record({
      action: 'ROLE_PERMISSIONS_CHANGED',
      entityType: 'Role',
      entityId: roleId,
      tenantId,
      metadata: { roleCode: role.code, permissionCount: permissions.length },
    });
  }

  /** Supprime un role personnalise inutilise. */
  async deleteRole(tenantId: string, roleId: string): Promise<void> {
    const role = await this.prisma.role.findFirst({
      where: { tenantId, id: roleId },
      select: { id: true, code: true, isSystem: true, _count: { select: { memberships: true } } },
    });

    if (!role) {
      throw new NotFoundException(ERROR_CODES.ROLE_NOT_FOUND, 'Role introuvable.');
    }

    if (role.isSystem) {
      throw new ConflictException(
        ERROR_CODES.ROLE_IMMUTABLE,
        'Un role systeme ne peut pas etre supprime.',
      );
    }

    if (role._count.memberships > 0) {
      throw new ConflictException(
        ERROR_CODES.ROLE_IN_USE,
        `Ce role est encore attribue a ${role._count.memberships} membre(s). ` +
          'Reaffectez-les avant de le supprimer.',
      );
    }

    await this.prisma.role.delete({ where: { id: roleId } });
    this.access.invalidateTenant(tenantId);
  }

  // -------------------------------------------------------------------------

  private async replacePermissions(
    tx: PrismaTransactionClient,
    roleId: string,
    permissions: readonly string[],
  ): Promise<void> {
    const rows = await tx.permission.findMany({
      where: { key: { in: [...permissions] }, isPlatform: false },
      select: { id: true },
    });

    await tx.rolePermission.deleteMany({ where: { roleId } });

    if (rows.length > 0) {
      await tx.rolePermission.createMany({
        data: rows.map((row) => ({ roleId, permissionId: row.id })),
        skipDuplicates: true,
      });
    }
  }

  /**
   * Refuse toute permission de PLATEFORME sur un role de boutique.
   * Sans ce controle, un OWNER pourrait s'attribuer `platform.tenants.manage`
   * et administrer les boutiques concurrentes.
   */
  private assertPermissionsAssignable(permissions: readonly string[]): void {
    const unknown = permissions.filter(
      (key) => !(ALL_PERMISSIONS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      throw new ValidationException(`Permissions inconnues : ${unknown.join(', ')}.`);
    }

    const platform = permissions.filter((key) => key.startsWith('platform.'));
    if (platform.length > 0) {
      throw new ValidationException(
        `Les permissions de plateforme ne peuvent pas etre attribuees a un role ` +
          `de boutique : ${platform.join(', ')}.`,
      );
    }
  }

  private async assertNotLastOwner(tenantId: string, membershipId: string): Promise<void> {
    const owners = await this.prisma.membership.count({
      where: {
        tenantId,
        status: 'ACTIVE',
        role: { code: 'OWNER' },
        id: { not: membershipId },
      },
    });

    if (owners === 0) {
      throw new ConflictException(
        ERROR_CODES.LAST_OWNER_PROTECTED,
        'Cette boutique doit conserver au moins un proprietaire actif. ' +
          'Nommez un autre proprietaire avant de modifier celui-ci.',
      );
    }
  }

  private async sendInvitationEmail(
    email: string,
    fullName: string,
    roleName: string,
    temporaryPassword?: string,
  ): Promise<void> {
    await this.mail.send({
      to: email,
      subject: 'Vous avez ete invite sur EcomFlow',
      text: [
        `Bonjour ${fullName},`,
        '',
        `Vous avez ete ajoute a une boutique EcomFlow avec le role « ${roleName} ».`,
        '',
        temporaryPassword
          ? [
              'Un compte a ete cree pour vous. Mot de passe provisoire :',
              `    ${temporaryPassword}`,
              '',
              'Changez-le des votre premiere connexion.',
            ].join('\n')
          : 'Connectez-vous avec vos identifiants habituels.',
        '',
        `${this.config.app.appUrl}/connexion`,
      ].join('\n'),
    });
  }
}
