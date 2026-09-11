/**
 * DTO du domaine « commandes ».
 *
 * Aucun champ sensible (`tenantId`, `status`, montants calcules) n'est
 * acceptable en entree : ils sont derives cote serveur. Le
 * `ValidationPipe` global etant configure en `forbidNonWhitelisted`, un
 * client qui tenterait de les envoyer recoit une erreur explicite plutot
 * qu'une elevation silencieuse (voir DECISIONS.md — D-027).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MANUAL_ORDER_SOURCES, ORDER_SOURCES, ORDER_STATUSES } from '@ecomflow/shared';
import {
  DateRangeQueryDto,
  PaginationQueryDto,
  toStringArray,
} from '../../../common/dto/query.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class OrderLineDto {
  @ApiPropertyOptional({ description: 'Identifiant de la variante.' })
  @IsOptional()
  @IsUUID('7')
  variantId?: string;

  @ApiPropertyOptional({ description: 'SKU de la variante, alternative a variantId.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  sku?: string;

  @ApiProperty({ minimum: 1, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'La quantite doit etre au moins de 1.' })
  quantity!: number;

  @ApiPropertyOptional({
    description: 'Prix unitaire en centimes. A defaut, celui du catalogue est applique.',
    example: 450000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitPriceCentimes?: number;

  @ApiPropertyOptional({ description: 'Remise sur la ligne, en centimes.', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  discountCentimes?: number;
}

export class CreateOrderDto {
  @ApiPropertyOptional({
    enum: MANUAL_ORDER_SOURCES,
    default: 'MANUAL',
    description:
      'Provenance declaree par l agent. Bornee aux choix HUMAINS : `API` et ' +
      '`CSV_IMPORT` sont des constats poses par le systeme qui cree la ' +
      'commande, pas des options de saisie.',
  })
  @IsOptional()
  @IsIn(MANUAL_ORDER_SOURCES)
  source?: (typeof MANUAL_ORDER_SOURCES)[number];

  @ApiProperty({ example: 'Sara Benali' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Le nom du client est obligatoire.' })
  @MaxLength(150)
  customerName!: string;

  @ApiProperty({ example: '0555123456', description: 'Numero algerien, toute forme acceptee.' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone!: string;

  @ApiProperty({
    example: 'Alger',
    description: 'Code (1 a 58) ou nom de la wilaya. Les variantes courantes sont reconnues.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  wilaya!: string;

  @ApiProperty({ example: 'Bab Ezzouar' })
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  commune!: string;

  @ApiProperty({ example: 'Cite 1200 Logements, Bat B4' })
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  addressText!: string;

  @ApiProperty({ type: [OrderLineDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1, { message: 'Une commande doit contenir au moins un article.' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];

  @ApiPropertyOptional({ description: 'Frais de livraison en centimes.', example: 50000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFeeCentimes?: number;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Membre a qui affecter la commande.' })
  @IsOptional()
  @IsUUID('7')
  assignedMembershipId?: string;
}

export class ChangeOrderStatusDto {
  @ApiProperty({ enum: ORDER_STATUSES, description: 'Statut cible.' })
  @IsIn([...ORDER_STATUSES], { message: 'Statut cible inconnu.' })
  status!: (typeof ORDER_STATUSES)[number];

  @ApiPropertyOptional({
    description: 'Motif. Obligatoire pour les transitions negatives (annulation, refus).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class AssignOrderDto {
  @ApiPropertyOptional({
    description: 'Membre destinataire. `null` retire l affectation.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID('7')
  membershipId?: string | null;
}

export class ResolveDuplicateDto {
  @ApiProperty({
    enum: ['KEPT_BOTH', 'MERGED', 'CANCELLED_DUPLICATE'],
    description:
      'Decision. `KEPT_BOTH` conserve les deux commandes, `CANCELLED_DUPLICATE` ' +
      'signale que le doublon a ete annule separement.',
  })
  @IsIn(['KEPT_BOTH', 'MERGED', 'CANCELLED_DUPLICATE'])
  resolution!: 'KEPT_BOTH' | 'MERGED' | 'CANCELLED_DUPLICATE';
}

export class ListOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    isArray: true,
    enum: ORDER_STATUSES,
    description: 'Statuts, separes par des virgules.',
  })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn([...ORDER_STATUSES], { each: true })
  status?: (typeof ORDER_STATUSES)[number][];

  @ApiPropertyOptional({ isArray: true, enum: ORDER_SOURCES })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn([...ORDER_SOURCES], { each: true })
  source?: (typeof ORDER_SOURCES)[number][];

  @ApiPropertyOptional({ minimum: 1, maximum: 58 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  wilayaCode?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('7')
  assignedMembershipId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('7')
  carrierId?: string;

  @ApiPropertyOptional({ description: 'Recherche globale.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ description: 'Inclut les commandes archivees.', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  includeArchived?: boolean;

  @ApiPropertyOptional({
    enum: ['createdAt', 'orderedAt', 'totalCentimes', 'status'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'orderedAt', 'totalCentimes', 'status'])
  sortBy?: 'createdAt' | 'orderedAt' | 'totalCentimes' | 'status';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';
}

export class OrdersDateRangeDto extends DateRangeQueryDto {}
