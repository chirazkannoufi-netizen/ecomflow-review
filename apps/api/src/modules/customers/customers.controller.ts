/**
 * API des clients — famille `/customers/*` (V2 §28).
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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PERMISSIONS, RELIABILITY_TIERS } from '@ecomflow/shared';
import { Audited, RequirePermissions, TenantId } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/query.dto';
import { CustomersService } from './customers.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ListCustomersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Nom, telephone ou e-mail.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: RELIABILITY_TIERS })
  @IsOptional()
  @IsIn([...RELIABILITY_TIERS])
  reliabilityTier?: (typeof RELIABILITY_TIERS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  tag?: string;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'Second numero de contact.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  secondaryPhone?: string;

  @ApiPropertyOptional({ description: 'Notes internes, non visibles du client.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
}

export class AnonymizeCustomerDto {
  @ApiProperty({
    description: 'Motif de la demande d effacement, conserve dans le journal d audit.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Un motif est obligatoire pour anonymiser un client.' })
  @MaxLength(500)
  reason!: string;
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CUSTOMERS_READ)
  @ApiOperation({
    summary: 'Lister les clients',
    description:
      'La recherche par telephone normalise le terme : « 0555 12 34 56 » ' +
      'retrouve bien « +213555123456 ».',
  })
  async list(@TenantId() tenantId: string, @Query() query: ListCustomersQueryDto) {
    return this.customers.list(
      tenantId,
      { search: query.search, reliabilityTier: query.reliabilityTier, tag: query.tag },
      { page: query.page, pageSize: query.pageSize },
    );
  }

  @Get('by-phone/:phone')
  @RequirePermissions(PERMISSIONS.CUSTOMERS_READ)
  @ApiOperation({
    summary: 'Retrouver un client par telephone',
    description:
      'Recherche la plus utilisee par les agents : le client appelle, on tape ' +
      'son numero. Retourne `null` si aucun client ne correspond.',
  })
  async findByPhone(@TenantId() tenantId: string, @Param('phone') phone: string) {
    return this.customers.findByPhone(tenantId, phone);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMERS_READ)
  @ApiOperation({
    summary: 'Fiche client complete',
    description:
      'Historique des commandes, adresses, et score de fiabilite AVEC SES ' +
      'FACTEURS : l agent doit comprendre pourquoi un client est signale, ' +
      'pas seulement voir une pastille rouge (Addendum §32).',
  })
  async getOne(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.getById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMERS_MANAGE)
  @ApiOperation({ summary: 'Modifier une fiche client' })
  async update(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    await this.customers.update(tenantId, id, dto);
    return { acknowledged: true as const };
  }

  @Post(':id/recompute-reliability')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_MANAGE)
  @ApiOperation({
    summary: 'Recalculer le score de fiabilite',
    description:
      'Recalcule integralement depuis l historique reel des commandes. ' +
      'Garantit que le score reste fonde sur des donnees verifiables.',
  })
  async recompute(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.recomputeReliability(tenantId, id);
  }

  @Post(':id/anonymize')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_MANAGE, PERMISSIONS.SETTINGS_MANAGE)
  @Audited({ action: 'CUSTOMER_DATA_ERASED', entityType: 'Customer', entityIdParam: 'id' })
  @ApiOperation({
    summary: 'Anonymiser un client (droit a l effacement)',
    description:
      'Remplace les donnees personnelles tout en conservant l historique ' +
      'COMMERCIAL (montants, statuts), necessaire aux obligations comptables ' +
      'du commercant. Loi 18-07, Addendum §37.',
  })
  async anonymize(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnonymizeCustomerDto,
  ): Promise<void> {
    await this.customers.anonymize(tenantId, id, dto.reason);
  }
}
