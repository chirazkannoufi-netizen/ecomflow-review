/**
 * API de la boutique — famille `/tenants/*` (V2 §28).
 *
 * Regroupe l'identite de la boutique et ses parametres operationnels : seuils
 * de stock, regles de confirmation, filtre WhatsApp, seuils de fiabilite et de
 * detection de doublons.
 */

import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { LOCALES, PERMISSIONS, RELIABILITY_ACTIONS, resolveLocale } from '@ecomflow/shared';
import { Audited, Ctx, RequirePermissions, TenantId } from '../../common/decorators';
import type { RequestContext } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { NotFoundException } from '../../common/errors/business.exception';
import { ERROR_CODES } from '@ecomflow/shared';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateTenantDto {
  @ApiPropertyOptional({ description: 'Nom commercial de la boutique.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  logoUrl?: string;
}

export class UpdateSettingsDto {
  // --- Langues -----------------------------------------------------------
  @ApiPropertyOptional({
    enum: LOCALES,
    description:
      'Langue proposee par defaut aux NOUVEAUX membres de la boutique. ' +
      'Elle ne change jamais la langue de quelqu un qui a deja choisi la ' +
      'sienne : une preference personnelle ne se surcharge pas a distance.',
  })
  @IsOptional()
  @IsIn([...LOCALES])
  defaultLocale?: (typeof LOCALES)[number];

  @ApiPropertyOptional({
    enum: LOCALES,
    nullable: true,
    description:
      'Impose une langue unique pour TOUS les messages adresses aux clients ' +
      'finaux. Laisser vide — le defaut — pour ecrire a chaque client dans sa ' +
      'propre langue, ce qui donne le meilleur taux de confirmation.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? null : value))
  @ValidateIf((_object, value) => value !== null)
  @IsIn([...LOCALES])
  customerMessageLocale?: (typeof LOCALES)[number] | null;

  // --- Stock -------------------------------------------------------------
  @ApiPropertyOptional({ minimum: 0, description: 'Seuil d alerte de stock par defaut.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;

  @ApiPropertyOptional({
    description: 'Reserver le stock des la confirmation, plutot qu a la preparation.',
  })
  @IsOptional()
  @IsBoolean()
  reserveStockOnConfirm?: boolean;

  @ApiPropertyOptional({
    description:
      'Autoriser la confirmation d une commande sans stock suffisant. ' +
      'Desactive par defaut : l integrite du stock prime.',
  })
  @IsOptional()
  @IsBoolean()
  allowOversell?: boolean;

  // --- Confirmation ------------------------------------------------------
  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxCallAttempts?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 168, description: 'Delai de rappel par defaut (h).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  defaultCallbackDelayHours?: number;

  // --- Filtre WhatsApp (Addendum §31) ------------------------------------
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  whatsappFilterEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 48, description: 'Delai sans reponse (h).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  whatsappTimeoutHours?: number;

  @ApiPropertyOptional({
    description:
      'Montant au-dela duquel la commande part directement chez un agent ' +
      'humain, en centimes. Null pour ne pas plafonner.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  whatsappMaxAmountCentimes?: number;

  // --- Score de fiabilite (Addendum §32) ---------------------------------
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  reliabilityEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  reliabilityMinHistory?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  reliabilityReliableThreshold?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  reliabilityWatchThreshold?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  reliabilityFailureLimit?: number;

  @ApiPropertyOptional({
    isArray: true,
    enum: RELIABILITY_ACTIONS,
    description:
      'Actions recommandees pour un client a risque. Vide = aucune restriction : ' +
      'le score reste un simple indicateur pour l agent.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn([...RELIABILITY_ACTIONS], { each: true })
  reliabilityAtRiskActions?: string[];

  // --- Doublons (V2 §19) --------------------------------------------------
  @ApiPropertyOptional({ minimum: 1, maximum: 720 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  duplicateWindowHours?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  duplicateAlertScore?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  duplicateLikelyScore?: number;

  // --- Rentabilite (Addendum §33) ----------------------------------------
  @ApiPropertyOptional({
    description: 'Cout transport par defaut si le transporteur ne le renvoie pas, en centimes.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  defaultCarrierCostCentimes?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Seuil d alerte du taux de retour (%).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  returnRateAlertPercent?: number;
}

@ApiTags('Boutique')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(@InjectPrisma() private readonly prisma: PrismaClientExtended) {}

  @Get('current')
  @ApiOperation({
    summary: 'Boutique active et profil de l utilisateur',
    description:
      'Utilise par le frontend au chargement. Ne demande aucune permission : ' +
      'tout membre authentifie doit pouvoir savoir dans quelle boutique il se ' +
      'trouve.',
  })
  async current(@Ctx() context: RequestContext) {
    const user = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.findUnique({
        where: { id: context.userId as string },
        select: {
          id: true,
          email: true,
          fullName: true,
          phoneVerifiedAt: true,
          locale: true,
        },
      }),
    );

    if (!user) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Utilisateur introuvable.');
    }

    const tenant = context.tenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: context.tenantId },
          select: { id: true, name: true, slug: true, status: true, logoUrl: true },
        })
      : null;

    // Langue par defaut de la boutique : elle sert de repli quand un compte
    // n'a jamais exprime de preference, et de valeur proposee a l'inscription.
    const settings = context.tenantId
      ? await this.prisma.tenantSettings.findUnique({
          where: { tenantId: context.tenantId },
          select: { defaultLocale: true },
        })
      : null;

    // Les boutiques dont l'utilisateur est membre, pour le selecteur de
    // boutique quand il en gere plusieurs.
    const memberships = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.membership.findMany({
        where: { userId: context.userId as string, status: 'ACTIVE' },
        select: {
          tenant: { select: { id: true, name: true, slug: true, status: true } },
          role: { select: { code: true, name: true } },
        },
      }),
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phoneVerified: user.phoneVerifiedAt !== null,
        locale: user.locale,
      },
      // La langue effective, deja resolue cote serveur : le front n'a pas a
      // reimplementer l'ordre de priorite, au risque de diverger.
      locale: resolveLocale(user.locale, settings?.defaultLocale),
      tenantDefaultLocale: settings?.defaultLocale ?? null,
      tenant,
      role: context.isPlatformAdmin ? 'SUPER_ADMIN' : (memberships[0]?.role.code ?? null),
      isPlatformAdmin: context.isPlatformAdmin,
      availableTenants: memberships.map((entry) => ({
        ...entry.tenant,
        roleName: entry.role.name,
      })),
    };
  }

  @Get('settings')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Parametres operationnels de la boutique' })
  async getSettings(@TenantId() tenantId: string) {
    const settings = await this.prisma.tenantSettings.findUnique({ where: { tenantId } });

    if (!settings) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Parametres introuvables.');
    }

    return settings;
  }

  @Patch('settings')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  @Audited({ action: 'TENANT_SETTINGS_UPDATED', entityType: 'TenantSettings' })
  @ApiOperation({
    summary: 'Modifier les parametres de la boutique',
    description:
      'Tous les seuils du produit sont configurables ici : stock, tentatives ' +
      'd appel, filtre WhatsApp, score de fiabilite, detection de doublons. ' +
      'Aucun n est code en dur.',
  })
  async updateSettings(@TenantId() tenantId: string, @Body() dto: UpdateSettingsDto) {
    const updated = await this.prisma.tenantSettings.update({
      where: { tenantId },
      data: { ...dto },
    });
    return updated;
  }

  @Patch('current')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  @Audited({ action: 'TENANT_SETTINGS_UPDATED', entityType: 'Tenant' })
  @ApiOperation({ summary: 'Modifier l identite de la boutique' })
  async updateTenant(@TenantId() tenantId: string, @Body() dto: UpdateTenantDto) {
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
      },
      select: { id: true, name: true, slug: true, status: true, logoUrl: true },
    });
  }
}
