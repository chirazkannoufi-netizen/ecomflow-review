/**
 * API des integrations — famille `/integrations/*` (V2 §28, §29).
 *
 * Ces routes portent l'assistant d'onboarding sans developpeur (Addendum §34) :
 * connecter Google, choisir un onglet, verifier le mapping propose, tester
 * l'import, puis activer.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PERMISSIONS } from '@ecomflow/shared';
import {
  Audited,
  Public,
  RequirePermissions,
  RequiresOperationalSubscription,
  TenantId,
} from '../../common/decorators';
import { AppConfigService } from '../../config/configuration';
import { GoogleOAuthService } from './google/google-oauth.service';
import { SheetConfigService } from './google/sheet-config.service';
import { SheetSyncService } from './google/sheet-sync.service';
import type { ColumnMapping } from './google/sheet-row.parser';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class PreviewSheetDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  spreadsheetId!: string;

  @ApiProperty({ example: 'Commandes' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sheetName!: string;

  @ApiPropertyOptional({ default: 1, description: 'Ligne contenant les en-tetes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  headerRow?: number;

  @ApiPropertyOptional({
    description:
      'Mapping a tester. Si absent, un mapping est propose automatiquement ' +
      'a partir des en-tetes.',
  })
  @IsOptional()
  @IsObject()
  mapping?: ColumnMapping;
}

export class CreateSheetConfigDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  spreadsheetId!: string;

  @ApiProperty({ example: 'Commandes' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sheetName!: string;

  @ApiProperty({ description: 'Identifiant numerique de l onglet.', example: '0' })
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  sheetGid!: string;

  @ApiProperty({
    description: 'Correspondance champ EcomFlow -> colonne (lettre ou index 0-base).',
    example: { customerName: 'B', phone: 'C', wilaya: 'D', quantity: 'I' },
  })
  @IsObject()
  columnMapping!: ColumnMapping;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  headerRow?: number;

  @ApiPropertyOptional({ description: 'Premiere ligne de donnees. Par defaut, en-tete + 1.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  firstDataRow?: number;

  @ApiPropertyOptional({
    description:
      'Colonne portant un identifiant de ligne stable. FORTEMENT recommandee ' +
      'si votre feuille peut contenir deux lignes rigoureusement identiques.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(10)
  externalIdColumn?: string;

  @ApiPropertyOptional({ minimum: 5, maximum: 1440, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  syncIntervalMinutes?: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'N importer que les lignes dont le statut source figure dans cette liste.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  acceptedSourceStatuses?: string[];
}

export class UpdateSheetConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  columnMapping?: ColumnMapping;

  @ApiPropertyOptional({ minimum: 5, maximum: 1440 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  syncIntervalMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(10)
  externalIdColumn?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  acceptedSourceStatuses?: string[];
}

@ApiTags('Integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly sheetConfig: SheetConfigService,
    private readonly sync: SheetSyncService,
    private readonly config: AppConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Connexion Google
  // -------------------------------------------------------------------------

  @Get('google/authorize')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary: 'Obtenir l URL de consentement Google',
    description:
      'Seul l acces en LECTURE aux feuilles est demande par defaut. Demander ' +
      'un acces en ecriture a tout le Drive serait disproportionne et alarmerait ' +
      'le commercant a l ecran de consentement.',
  })
  authorize(
    @TenantId() tenantId: string,
    @Query('allowWrite') allowWrite?: string,
  ): { url: string } {
    const { url } = this.oauth.buildAuthorizationUrl(tenantId, {
      allowWrite: allowWrite === 'true',
    });
    return { url };
  }

  @Get('google/status')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_READ)
  @ApiOperation({
    summary: 'Etat de la connexion Google',
    description:
      'Distingue deux choses : l installation dispose-t-elle d identifiants ' +
      'OAuth, et cette boutique a-t-elle autorise l acces. Aucun jeton n est ' +
      'renvoye.',
  })
  async googleStatus(@TenantId() tenantId: string) {
    return this.oauth.getStatus(tenantId);
  }

  @Public()
  @Get('google/callback')
  @Redirect()
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<{ url: string }> {
    const appUrl = this.config.app.appUrl;

    // L'utilisateur a refuse le consentement : on le ramene proprement dans
    // l'application plutot que d'afficher une erreur technique.
    if (error || !code || !state) {
      return { url: `${appUrl}/integrations?google=refuse` };
    }

    try {
      const result = await this.oauth.handleCallback(code, state);
      return { url: `${appUrl}/integrations?google=connecte&compte=${encodeURIComponent(result.email)}` };
    } catch {
      return { url: `${appUrl}/integrations?google=erreur` };
    }
  }

  @Post('google/disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @Audited({ action: 'INTEGRATION_DISCONNECTED', entityType: 'Integration' })
  @ApiOperation({
    summary: 'Deconnecter le compte Google',
    description:
      'Revoque le jeton cote Google et desactive les synchronisations. Les ' +
      'commandes deja importees sont conservees.',
  })
  async disconnect(@TenantId() tenantId: string): Promise<void> {
    await this.oauth.disconnect(tenantId);
  }

  // -------------------------------------------------------------------------
  // Configuration des feuilles
  // -------------------------------------------------------------------------

  @Get('google/spreadsheets')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({ summary: 'Classeurs accessibles au compte connecte' })
  async listSpreadsheets(@TenantId() tenantId: string) {
    return this.sheetConfig.listSpreadsheets(tenantId);
  }

  @Get('google/spreadsheets/:spreadsheetId/sheets')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({ summary: 'Onglets d un classeur' })
  async listSheets(
    @TenantId() tenantId: string,
    @Param('spreadsheetId') spreadsheetId: string,
  ) {
    return this.sheetConfig.listSheets(tenantId, spreadsheetId);
  }

  @Post('google/preview')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary: 'Apercu d un onglet avec mapping propose',
    description:
      'Montre, ligne par ligne, ce qu EcomFlow comprend de la feuille : le ' +
      'telephone normalise, la wilaya reconnue, le prix converti. C est l ecran ' +
      'qui evite les mauvaises surprises avant le premier import reel.',
  })
  async preview(@TenantId() tenantId: string, @Body() dto: PreviewSheetDto) {
    return this.sheetConfig.previewSheet(tenantId, dto.spreadsheetId, dto.sheetName, {
      headerRow: dto.headerRow,
      mapping: dto.mapping,
    });
  }

  @Get('google/sheets')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_READ)
  @ApiOperation({ summary: 'Feuilles synchronisees et leur etat' })
  async listConfigs(@TenantId() tenantId: string) {
    return this.sheetConfig.listConfigs(tenantId);
  }

  @Post('google/sheets')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @Audited({ action: 'INTEGRATION_CONFIG_UPDATED', entityType: 'SheetSyncConfig' })
  @ApiOperation({
    summary: 'Configurer la synchronisation d un onglet',
    description:
      'Le mapping est valide avant enregistrement : champs obligatoires ' +
      'presents, aucune colonne affectee a deux champs. Accepter une ' +
      'configuration incomplete produirait des echecs en boucle.',
  })
  async createConfig(@TenantId() tenantId: string, @Body() dto: CreateSheetConfigDto) {
    return this.sheetConfig.createConfig({
      tenantId,
      spreadsheetId: dto.spreadsheetId,
      sheetName: dto.sheetName,
      sheetGid: dto.sheetGid,
      columnMapping: dto.columnMapping,
      headerRow: dto.headerRow,
      firstDataRow: dto.firstDataRow,
      externalIdColumn: dto.externalIdColumn ?? null,
      syncIntervalMinutes: dto.syncIntervalMinutes,
      acceptedSourceStatuses: dto.acceptedSourceStatuses,
    });
  }

  @Patch('google/sheets/:configId')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @Audited({ action: 'INTEGRATION_CONFIG_UPDATED', entityType: 'SheetSyncConfig' })
  @ApiOperation({ summary: 'Modifier une configuration de synchronisation' })
  async updateConfig(
    @TenantId() tenantId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: UpdateSheetConfigDto,
  ) {
    await this.sheetConfig.updateConfig(tenantId, configId, dto);
    return { acknowledged: true as const };
  }

  // -------------------------------------------------------------------------
  // Synchronisation
  // -------------------------------------------------------------------------

  @Post('google/sheets/:configId/test')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary: 'Test d import (simulation)',
    description:
      'Lit la feuille et valide chaque ligne SANS creer aucune commande. ' +
      'Etape « test d import » de l assistant d onboarding (Addendum §34).',
  })
  async testImport(
    @TenantId() tenantId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
  ) {
    return this.sync.sync(tenantId, configId, 'ONBOARDING', { dryRun: true, maxRows: 50 });
  }

  @Post('google/sheets/:configId/sync')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Synchroniser maintenant',
    description:
      'Import immediat. Sur quota Google depasse, la reponse indique l instant ' +
      'de reprise : aucune commande n est perdue, la synchronisation repartira ' +
      'exactement ou elle s est arretee.',
  })
  async syncNow(
    @TenantId() tenantId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
  ) {
    return this.sync.sync(tenantId, configId, 'MANUAL');
  }

  @Get('google/sheets/:configId/errors')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_READ)
  @ApiOperation({
    summary: 'Journal des lignes en erreur',
    description:
      'Chaque ligne rejetee est listee avec son numero, le code d erreur et ' +
      'une explication exploitable (V1 §6).',
  })
  async listErrors(
    @TenantId() tenantId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
  ) {
    return this.sheetConfig.listRowErrors(tenantId, configId);
  }

  @Post('google/sheets/:configId/retry-failed')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.IMPORTS_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Rejouer les lignes en erreur',
    description:
      'Utilise les valeurs brutes conservees : ne relit pas la feuille et ne ' +
      'consomme donc aucun quota Google. Ideal apres correction du catalogue.',
  })
  async retryFailed(
    @TenantId() tenantId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
  ) {
    return this.sync.retryFailedRows(tenantId, configId);
  }

  @Get('google/sync-runs')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_READ)
  @ApiOperation({
    summary: 'Historique des synchronisations',
    description: 'Statut, volumes, duree et motif d echec de chaque execution (V2 §30).',
  })
  async listRuns(@TenantId() tenantId: string, @Query('configId') configId?: string) {
    return this.sheetConfig.listSyncRuns(tenantId, configId ?? null);
  }
}
