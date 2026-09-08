/**
 * API des utilisateurs et des roles — familles `/users/*`, `/roles/*`.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PERMISSIONS } from '@ecomflow/shared';
import { Audited, RequirePermissions, TenantId } from '../../common/decorators';
import { UsersService } from './users.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InviteMemberDto {
  @ApiProperty({ example: 'agent@boutique-dz.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'Nabil Agent' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  fullName!: string;

  @ApiProperty({ description: 'Role a attribuer dans la boutique.' })
  @IsUUID('7')
  roleId!: string;
}

export class ChangeRoleDto {
  @ApiProperty()
  @IsUUID('7')
  roleId!: string;
}

export class CreateRoleDto {
  @ApiProperty({ example: 'Superviseur confirmation' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({
    type: [String],
    description: 'Cles de permissions. Les permissions de plateforme sont refusees.',
    example: ['orders.read', 'confirmation.manage'],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRolePermissionsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions!: string[];
}

@ApiTags('Utilisateurs et roles')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // -------------------------------------------------------------------------
  // Membres
  // -------------------------------------------------------------------------

  @Get('users')
  @RequirePermissions(PERMISSIONS.USERS_READ)
  @ApiOperation({ summary: 'Lister les membres de la boutique' })
  async listMembers(@TenantId() tenantId: string) {
    return this.users.listMembers(tenantId);
  }

  @Post('users/invite')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Audited({ action: 'USER_INVITED', entityType: 'Membership' })
  @ApiOperation({
    summary: 'Inviter un membre',
    description:
      'Un utilisateur existant est rattache a la boutique sans creer de second ' +
      'compte. Un nouveau compte recoit un mot de passe provisoire, envoye par ' +
      'e-mail et retourne une seule fois a l administrateur.',
  })
  async invite(@TenantId() tenantId: string, @Body() dto: InviteMemberDto) {
    return this.users.inviteMember(tenantId, dto);
  }

  @Patch('users/:membershipId/role')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Audited({ action: 'USER_ROLE_CHANGED', entityType: 'Membership', entityIdParam: 'membershipId' })
  @ApiOperation({
    summary: 'Changer le role d un membre',
    description:
      'Le retrait de droits prend effet immediatement. Retirer le DERNIER ' +
      'proprietaire est refuse : la boutique deviendrait inadministrable.',
  })
  async changeRole(
    @TenantId() tenantId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    await this.users.changeRole(tenantId, membershipId, dto.roleId);
    return { acknowledged: true as const };
  }

  @Post('users/:membershipId/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Audited({ action: 'USER_DEACTIVATED', entityType: 'Membership', entityIdParam: 'membershipId' })
  @ApiOperation({
    summary: 'Desactiver un membre',
    description: 'Son historique et ses actions passees sont conserves.',
  })
  async deactivate(
    @TenantId() tenantId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<void> {
    await this.users.deactivateMember(tenantId, membershipId);
  }

  @Post('users/:membershipId/reactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @ApiOperation({ summary: 'Reactiver un membre' })
  async reactivate(
    @TenantId() tenantId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<void> {
    await this.users.reactivateMember(tenantId, membershipId);
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  @Get('roles')
  @RequirePermissions(PERMISSIONS.USERS_READ)
  @ApiOperation({
    summary: 'Roles de la boutique et leurs permissions',
    description:
      '`immutable` signale les roles dont les permissions ne peuvent pas etre ' +
      'modifiees (OWNER), par garde-fou anti auto-verrouillage.',
  })
  async listRoles(@TenantId() tenantId: string) {
    return this.users.listRoles(tenantId);
  }

  @Get('roles/permissions')
  @RequirePermissions(PERMISSIONS.USERS_READ)
  @ApiOperation({
    summary: 'Catalogue des permissions attribuables',
    description:
      'Groupees et decrites pour l ecran de gestion des roles. Les permissions ' +
      'de plateforme en sont exclues : elles ne sont jamais attribuables a une ' +
      'boutique.',
  })
  listPermissions() {
    return this.users.listPermissionCatalog();
  }

  @Post('roles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Audited({ action: 'ROLE_PERMISSIONS_CHANGED', entityType: 'Role' })
  @ApiOperation({ summary: 'Creer un role personnalise' })
  async createRole(@TenantId() tenantId: string, @Body() dto: CreateRoleDto) {
    return this.users.createRole(tenantId, dto);
  }

  @Patch('roles/:roleId/permissions')
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Audited({ action: 'ROLE_PERMISSIONS_CHANGED', entityType: 'Role', entityIdParam: 'roleId' })
  @ApiOperation({
    summary: 'Modifier les permissions d un role',
    description:
      'Remplace integralement le jeu de permissions. Refuse sur un role ' +
      'immuable ou si une permission de plateforme est demandee.',
  })
  async updateRolePermissions(
    @TenantId() tenantId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: UpdateRolePermissionsDto,
  ) {
    await this.users.updateRolePermissions(tenantId, roleId, dto.permissions);
    return { acknowledged: true as const };
  }

  @Delete('roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @ApiOperation({
    summary: 'Supprimer un role personnalise',
    description: 'Refuse si le role est systeme ou encore attribue a des membres.',
  })
  async deleteRole(
    @TenantId() tenantId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<void> {
    await this.users.deleteRole(tenantId, roleId);
  }
}
