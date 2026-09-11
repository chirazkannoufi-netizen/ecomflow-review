/**
 * API du catalogue et du stock — familles `/products/*`, `/variants/*`,
 * `/inventory/*` (V2 §28).
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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  OUT_OF_STOCK_BEHAVIORS,
  PERMISSIONS,
  STOCK_EXIT_STRATEGIES,
  type OutOfStockBehavior,
  type StockExitStrategy,
} from '@ecomflow/shared';
import {
  Audited,
  CurrentMembershipId,
  RequirePermissions,
  RequiresOperationalSubscription,
  TenantId,
} from '../../common/decorators';
import { BulkArchiveDto, PaginationQueryDto } from '../../common/dto/query.dto';
import { InventoryService } from '../inventory/inventory.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { CatalogService } from './catalog.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class VariantInputDto {
  @ApiProperty({ example: 'ROB-001-M-RGE' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sku!: string;

  @ApiPropertyOptional({ example: 'Rouge / M' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({
    example: { couleur: 'Rouge', taille: 'M' },
    description: 'Attributs libres de la declinaison.',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Prix de vente propre a la variante, en centimes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  salePriceCentimes?: number;

  @ApiPropertyOptional({ description: 'Prix d achat propre a la variante, en centimes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePriceCentimes?: number;

  @ApiPropertyOptional({ description: 'Seuil d alerte propre a la variante.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;

  @ApiPropertyOptional({ description: 'Stock initial.', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialStock?: number;
}

export class CreateProductDto {
  @ApiProperty({ example: 'Robe longue brodee' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'ROB-001' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sku!: string;

  @ApiPropertyOptional({ example: 'Vetements' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  categoryName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 450000, description: 'Prix de vente en centimes.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  salePriceCentimes!: number;

  @ApiPropertyOptional({ example: 250000, description: 'Prix d achat en centimes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePriceCentimes?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  imageUrls?: string[];

  @ApiPropertyOptional({
    type: [VariantInputDto],
    description:
      'Declinaisons. Si absent, une variante « Standard » est creee ' +
      'automatiquement : toute commande pointe une variante (D-011).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VariantInputDto)
  variants?: VariantInputDto[];

  @ApiPropertyOptional({ description: 'Stock initial de la variante par defaut.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialStock?: number;
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  salePriceCentimes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePriceCentimes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  categoryName?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  imageUrls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description:
      'Consignes affichees au confirmateur pendant l appel. Chaine vide pour effacer.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  confirmationNotes?: string;
}

export class ListProductsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Recherche sur le nom ou le SKU.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('7')
  categoryId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  activeOnly?: boolean;
}

export class UpdateVariantStockSettingsDto {
  @ApiPropertyOptional({
    enum: OUT_OF_STOCK_BEHAVIORS,
    description:
      'Comportement en rupture. INHERIT suit le reglage de la boutique ' +
      '(allowOversell / reserveStockOnConfirm).',
  })
  @IsOptional()
  @IsIn(OUT_OF_STOCK_BEHAVIORS)
  outOfStockBehavior?: OutOfStockBehavior;

  @ApiPropertyOptional({
    enum: STOCK_EXIT_STRATEGIES,
    description: 'Ordre de consommation des lots. Sans lot, sans effet.',
  })
  @IsOptional()
  @IsIn(STOCK_EXIT_STRATEGIES)
  stockExitStrategy?: StockExitStrategy;

  @ApiPropertyOptional({ minimum: 0, description: 'Seuil d alerte propre a la variante.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;
}

export class AddCrossSellDto {
  @ApiProperty({
    description: 'SKU du produit a proposer en vente additionnelle.',
    example: 'HOU-001',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indiquez le SKU du produit a proposer.' })
  @MaxLength(100)
  sku!: string;
}

export class ListBatchesQueryDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Inclure les lots dont le reste est nul.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeExhausted?: boolean;
}

export class StockAdjustmentDto {
  @ApiProperty({
    description: 'Variation signee du stock physique. Negatif = casse, vol, perte.',
    example: -2,
  })
  @Type(() => Number)
  @IsInt()
  delta!: number;

  @ApiProperty({ description: 'Motif de l ajustement, obligatoire pour la tracabilite.' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Un motif est obligatoire pour tout ajustement de stock.' })
  @MaxLength(500)
  note!: string;
}

export class StockInboundDto {
  @ApiProperty({ minimum: 1, description: 'Quantite recue.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({ description: 'Reference de reception (bon de livraison).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  // --- Suivi par lots (facultatif) ------------------------------------------
  //
  // Renseigner `costCentimes` cree un LOT pour cette reception : c'est le seul
  // declencheur. Une entree sans cout reste un simple incrementement du
  // compteur, comme avant. Le choix est laisse a chaque reception plutot qu'a
  // un reglage global : une boutique connait le cout de certaines receptions
  // et pas d'autres, et l'obliger a inventer un chiffre pour continuer serait
  // le plus sur moyen d'obtenir des marges fausses.

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Cout d achat UNITAIRE de cette reception, en centimes. Sa presence cree un lot.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  costCentimes?: number;

  @ApiPropertyOptional({ description: 'Date de peremption du lot (ISO 8601).' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Reference du bon de livraison fournisseur.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  batchReference?: string;
}

@ApiTags('Catalogue et stock')
@ApiBearerAuth()
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
  ) {}

  // -------------------------------------------------------------------------
  // Produits
  // -------------------------------------------------------------------------

  @Get('products')
  @RequirePermissions(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Lister les produits avec leur stock' })
  async listProducts(@TenantId() tenantId: string, @Query() query: ListProductsQueryDto) {
    return this.catalog.listProducts(
      tenantId,
      { search: query.search, categoryId: query.categoryId, activeOnly: query.activeOnly },
      { page: query.page, pageSize: query.pageSize },
    );
  }

  @Get('products/:id')
  @RequirePermissions(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Detail d un produit et de ses variantes' })
  async getProduct(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getProduct(tenantId, id);
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Creer un produit',
    description:
      'Cree le produit, ses variantes et leurs lignes de stock. Sans variante ' +
      'fournie, une variante « Standard » est creee automatiquement.',
  })
  async createProduct(@TenantId() tenantId: string, @Body() dto: CreateProductDto) {
    return this.catalog.createProduct({
      tenantId,
      name: dto.name,
      sku: dto.sku,
      categoryName: dto.categoryName ?? null,
      description: dto.description ?? null,
      salePriceCentimes: dto.salePriceCentimes,
      purchasePriceCentimes: dto.purchasePriceCentimes ?? null,
      imageUrls: dto.imageUrls,
      variants: dto.variants,
      initialStock: dto.initialStock,
    });
  }

  @Patch('products/:id')
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({ summary: 'Modifier un produit' })
  async updateProduct(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    await this.catalog.updateProduct(tenantId, id, dto);
    return { acknowledged: true as const };
  }

  @Post('products/:id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @ApiOperation({
    summary: 'Archiver un produit',
    description:
      'Suppression logique. Refuse si du stock est encore reserve sur des ' +
      'commandes en cours : l historique et les marges passees en dependent.',
  })
  async archiveProduct(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.catalog.archiveProduct(tenantId, id);
  }

  @Post('products/bulk-archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @ApiOperation({
    summary: 'Archiver une selection de produits',
    description:
      'Suppression LOGIQUE, ligne par ligne. Le resultat detaille ce qui n a ' +
      'PAS ete archive et pourquoi — typiquement un produit dont le stock est ' +
      'encore reserve sur des commandes en cours.',
  })
  async bulkArchiveProducts(@TenantId() tenantId: string, @Body() dto: BulkArchiveDto) {
    return this.catalog.archiveMany(tenantId, dto.ids);
  }

  @Post('products/:id/variants')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({ summary: 'Ajouter une declinaison a un produit' })
  async addVariant(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VariantInputDto,
  ) {
    return this.catalog.addVariant(tenantId, id, dto);
  }

  @Patch('products/:id/variants/:variantId/stock-settings')
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Regler le comportement de stock d une declinaison',
    description:
      'Comportement en rupture et ordre de consommation des lots. Ces deux ' +
      'reglages decrivent le stock, pas l article : ils vivent donc a part du ' +
      'reste de la fiche produit.',
  })
  async updateVariantStockSettings(
    @TenantId() tenantId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantStockSettingsDto,
  ) {
    await this.catalog.updateVariantStockSettings(tenantId, variantId, dto);
    return { acknowledged: true as const };
  }

  @Get('products/:id/cross-sells')
  @RequirePermissions(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Lister les produits proposes en vente additionnelle' })
  async listCrossSells(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.listCrossSells(tenantId, id);
  }

  @Post('products/:id/cross-sells')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Proposer un produit en vente additionnelle',
    description:
      'Le produit est designe par son SKU, celui que le commercant lit sur ' +
      'son etiquette. Le lien est oriente : proposer B avec A ne propose pas ' +
      'A avec B.',
  })
  async addCrossSell(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddCrossSellDto,
  ) {
    await this.catalog.addCrossSell(tenantId, id, dto.sku);
    return { acknowledged: true as const };
  }

  @Delete('products/:id/cross-sells/:crossSellProductId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.PRODUCTS_MANAGE)
  @ApiOperation({ summary: 'Retirer un produit complementaire' })
  async removeCrossSell(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('crossSellProductId', ParseUUIDPipe) crossSellProductId: string,
  ): Promise<void> {
    await this.catalog.removeCrossSell(tenantId, id, crossSellProductId);
  }

  @Get('inventory/variants/:variantId/batches')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary: 'Lister les lots d une declinaison',
    description:
      'Les lots epuises sont inclus sur demande : leur cout d achat reste la ' +
      'seule trace de ce qu a coute une marchandise deja vendue.',
  })
  async batches(
    @TenantId() tenantId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Query() query: ListBatchesQueryDto,
  ) {
    return this.catalog.listBatches(tenantId, variantId, {
      includeExhausted: query.includeExhausted ?? false,
    });
  }

  @Get('categories')
  @RequirePermissions(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Lister les categories' })
  async listCategories(@TenantId() tenantId: string) {
    return this.catalog.listCategories(tenantId);
  }

  // -------------------------------------------------------------------------
  // Stock
  // -------------------------------------------------------------------------

  @Get('inventory/low-stock')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary: 'Variantes sous le seuil d alerte',
    description: 'Le seuil est celui de la variante, sinon celui de la boutique.',
  })
  async lowStock(@TenantId() tenantId: string) {
    return this.inventory.listLowStock(tenantId);
  }

  @Get('inventory/variants/:variantId/movements')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary: 'Historique des mouvements d une variante',
    description:
      'Journal append-only : chaque mouvement conserve l etat de stock ' +
      'resultant, ce qui permet de reconstituer le stock a toute date.',
  })
  async movements(
    @TenantId() tenantId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.prisma.inventoryMovement.findMany({
      where: { tenantId, variantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        quantity: true,
        referenceType: true,
        referenceId: true,
        note: true,
        onHandAfter: true,
        reservedAfter: true,
        quarantineAfter: true,
        createdAt: true,
      },
    });
  }

  @Post('inventory/variants/:variantId/inbound')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @RequiresOperationalSubscription()
  @Audited({ action: 'INVENTORY_ADJUSTED', entityType: 'ProductVariant', entityIdParam: 'variantId' })
  @ApiOperation({ summary: 'Enregistrer une entree en stock' })
  async inbound(
    @TenantId() tenantId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: StockInboundDto,
    @CurrentMembershipId() membershipId: string,
  ) {
    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;
      await this.inventory.inbound(
        tx,
        tenantId,
        variantId,
        dto.quantity,
        {
          referenceType: 'MANUAL',
          actorId: membershipId,
          note: dto.note ?? 'Reception fournisseur',
        },
        dto.costCentimes === undefined
          ? undefined
          : {
              costCentimes: dto.costCentimes,
              expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
              reference: dto.batchReference ?? null,
              note: dto.note ?? null,
            },
      );
    });

    const [snapshot] = await this.inventory.getSnapshots(tenantId, [variantId]);
    return snapshot;
  }

  @Post('inventory/variants/:variantId/adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @RequiresOperationalSubscription()
  @Audited({ action: 'INVENTORY_ADJUSTED', entityType: 'ProductVariant', entityIdParam: 'variantId' })
  @ApiOperation({
    summary: 'Ajuster le stock physique',
    description:
      'Inventaire, casse, vol. Le motif est obligatoire. Un ajustement qui ' +
      'rendrait le stock negatif est refuse avec le detail du calcul.',
  })
  async adjust(
    @TenantId() tenantId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: StockAdjustmentDto,
    @CurrentMembershipId() membershipId: string,
  ) {
    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;
      await this.inventory.adjust(tx, tenantId, variantId, dto.delta, {
        referenceType: 'MANUAL',
        actorId: membershipId,
        note: dto.note,
      });
    });

    const [snapshot] = await this.inventory.getSnapshots(tenantId, [variantId]);
    return snapshot;
  }

  @Get('inventory/reconciliation')
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @ApiOperation({
    summary: 'Ecarts entre le stock projete et la somme des mouvements',
    description:
      'Doit toujours retourner une liste vide. Un ecart revele un defaut ' +
      'd ecriture : il est signale, jamais corrige silencieusement.',
  })
  async reconciliation(@TenantId() tenantId: string) {
    const discrepancies = await this.inventory.findDiscrepancies(tenantId);
    return { consistent: discrepancies.length === 0, discrepancies };
  }
}
