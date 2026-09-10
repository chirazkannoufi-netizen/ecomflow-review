/**
 * Catalogue produits — V1 §11, V2 §14.
 *
 * REGLE STRUCTURANTE : tout produit possede AU MOINS UNE VARIANTE.
 *   Un produit sans declinaison recoit une variante « par defaut ». Les lignes
 *   de commande pointent toujours une variante, jamais un produit. Cela evite
 *   deux chemins de calcul de stock, ce qu'interdit la V2 §14 (« les regles de
 *   decrementation doivent etre centralisees »). Voir DECISIONS.md — D-011.
 *
 * SUPPRESSION LOGIQUE UNIQUEMENT
 *   Un produit reference par des commandes passees ne peut pas etre supprime :
 *   l'historique et les calculs de marge en dependent. `archive()` le retire
 *   du catalogue actif sans toucher aux donnees.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ERROR_CODES,
  buildPageMeta,
  toSkipTake,
  type OutOfStockBehavior,
  type Paginated,
  type StockExitStrategy,
} from '@ecomflow/shared';
import {
  ConflictException,
  NotFoundException,
  ValidationException,
} from '../../common/errors/business.exception';
import { ClockService } from '../../infra/clock/clock.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { isUniqueConstraintError } from '../../infra/prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

export interface CreateVariantInput {
  readonly sku: string;
  readonly label?: string | null;
  readonly attributes?: Record<string, string>;
  readonly salePriceCentimes?: number | null;
  readonly purchasePriceCentimes?: number | null;
  readonly lowStockThreshold?: number | null;
  readonly initialStock?: number;
}

export interface CreateProductInput {
  readonly tenantId: string;
  readonly name: string;
  readonly sku: string;
  readonly categoryName?: string | null;
  readonly description?: string | null;
  readonly salePriceCentimes: number;
  readonly purchasePriceCentimes?: number | null;
  readonly imageUrls?: readonly string[];
  readonly variants?: readonly CreateVariantInput[];
  readonly initialStock?: number;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly inventory: InventoryService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // PRODUITS
  // ==========================================================================

  async createProduct(input: CreateProductInput): Promise<{ productId: string; variantIds: string[] }> {
    if (input.salePriceCentimes < 0) {
      throw new ValidationException('Le prix de vente ne peut pas etre negatif.');
    }

    return this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      const categoryId = input.categoryName
        ? (await this.resolveCategory(tx, input.tenantId, input.categoryName)).id
        : null;

      let product;
      try {
        product = await tx.product.create({
          data: {
            tenantId: input.tenantId,
            categoryId,
            name: input.name.trim(),
            sku: input.sku.trim().toUpperCase(),
            description: input.description ?? null,
            salePriceCentimes: input.salePriceCentimes,
            purchasePriceCentimes: input.purchasePriceCentimes ?? null,
            imageUrls: [...(input.imageUrls ?? [])],
            isActive: true,
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueConstraintError(error, 'sku')) {
          throw new ConflictException(
            ERROR_CODES.SKU_ALREADY_EXISTS,
            `Le SKU « ${input.sku} » est deja utilise dans cette boutique.`,
          );
        }
        throw error;
      }

      // Aucune variante fournie : on cree la variante par defaut, invisible
      // pour le commercant mais indispensable au modele de stock.
      const variantInputs: CreateVariantInput[] =
        input.variants && input.variants.length > 0
          ? [...input.variants]
          : [
              {
                sku: `${input.sku.trim().toUpperCase()}-STD`,
                label: 'Standard',
                initialStock: input.initialStock ?? 0,
              },
            ];

      const variantIds: string[] = [];

      for (const [index, variantInput] of variantInputs.entries()) {
        const variantId = await this.createVariantWithin(
          tx,
          input.tenantId,
          product.id,
          variantInput,
          index === 0,
        );
        variantIds.push(variantId);
      }

      this.logger.log(
        `Produit ${input.sku} cree pour la boutique ${input.tenantId} ` +
          `avec ${variantIds.length} variante(s).`,
      );

      return { productId: product.id, variantIds };
    });
  }

  /** Ajoute une declinaison a un produit existant. */
  async addVariant(
    tenantId: string,
    productId: string,
    input: CreateVariantInput,
  ): Promise<{ variantId: string }> {
    const product = await this.prisma.product.findFirst({
      where: { tenantId, id: productId, archivedAt: null },
      select: { id: true },
    });

    if (!product) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Produit introuvable.');
    }

    const variantId = await this.prisma.$transaction((rawTx) =>
      this.createVariantWithin(rawTx as PrismaTransactionClient, tenantId, productId, input, false),
    );

    return { variantId };
  }

  private async createVariantWithin(
    tx: PrismaTransactionClient,
    tenantId: string,
    productId: string,
    input: CreateVariantInput,
    isDefault: boolean,
  ): Promise<string> {
    try {
      const variant = await tx.productVariant.create({
        data: {
          tenantId,
          productId,
          sku: input.sku.trim().toUpperCase(),
          label: input.label ?? null,
          attributes: (input.attributes ?? {}) as object,
          salePriceCentimes: input.salePriceCentimes ?? null,
          purchasePriceCentimes: input.purchasePriceCentimes ?? null,
          lowStockThreshold: input.lowStockThreshold ?? null,
          isDefault,
          isActive: true,
        },
        select: { id: true },
      });

      await this.inventory.initializeLevel(tx, tenantId, variant.id, input.initialStock ?? 0);

      return variant.id;
    } catch (error) {
      if (isUniqueConstraintError(error, 'sku')) {
        throw new ConflictException(
          ERROR_CODES.SKU_ALREADY_EXISTS,
          `Le SKU de variante « ${input.sku} » est deja utilise dans cette boutique.`,
        );
      }
      throw error;
    }
  }

  async updateProduct(
    tenantId: string,
    productId: string,
    changes: {
      name?: string;
      description?: string | null;
      salePriceCentimes?: number;
      purchasePriceCentimes?: number | null;
      categoryName?: string | null;
      imageUrls?: readonly string[];
      isActive?: boolean;
      confirmationNotes?: string | null;
    },
  ): Promise<void> {
    const categoryId =
      changes.categoryName !== undefined
        ? changes.categoryName
          ? (
              await this.resolveCategory(
                this.prisma,
                tenantId,
                changes.categoryName,
              )
            ).id
          : null
        : undefined;

    const updated = await this.prisma.product.updateMany({
      where: { tenantId, id: productId, archivedAt: null },
      data: {
        ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
        ...(changes.description !== undefined ? { description: changes.description } : {}),
        ...(changes.salePriceCentimes !== undefined
          ? { salePriceCentimes: changes.salePriceCentimes }
          : {}),
        ...(changes.purchasePriceCentimes !== undefined
          ? { purchasePriceCentimes: changes.purchasePriceCentimes }
          : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(changes.imageUrls !== undefined ? { imageUrls: [...changes.imageUrls] } : {}),
        ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
        ...(changes.confirmationNotes !== undefined
          ? { confirmationNotes: changes.confirmationNotes?.trim() || null }
          : {}),
      },
    });

    if (updated.count === 0) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Produit introuvable.');
    }
  }

  /**
   * Archive un produit et ses variantes.
   *
   * Aucune suppression physique : les commandes passees referencent ces
   * variantes, et les calculs de marge historiques en dependent.
   */
  async archiveProduct(tenantId: string, productId: string): Promise<void> {
    const reserved = await this.prisma.inventoryLevel.findFirst({
      where: { tenantId, variant: { productId }, reserved: { gt: 0 } },
      select: { variantId: true },
    });

    if (reserved) {
      throw new ConflictException(
        ERROR_CODES.CONFLICT,
        'Ce produit a du stock reserve sur des commandes en cours. ' +
          'Traitez-les avant de l archiver.',
      );
    }

    const now = this.clock.now();

    await this.prisma.$transaction([
      this.prisma.product.updateMany({
        where: { tenantId, id: productId },
        data: { archivedAt: now, isActive: false },
      }),
      this.prisma.productVariant.updateMany({
        where: { tenantId, productId },
        data: { archivedAt: now, isActive: false },
      }),
    ]);
  }

  // ==========================================================================
  // LECTURE
  // ==========================================================================

  async listProducts(
    tenantId: string,
    filters: { search?: string; categoryId?: string; activeOnly?: boolean } = {},
    options: { page?: number; pageSize?: number } = {},
  ): Promise<Paginated<ProductListItem>> {
    const { skip, take } = toSkipTake(options);
    const page = Math.max(1, Math.trunc(options.page ?? 1));

    const where: Prisma.ProductWhereInput = {
      tenantId,
      archivedAt: null,
      ...(filters.activeOnly ? { isActive: true } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.search?.trim()
        ? {
            OR: [
              { name: { contains: filters.search.trim(), mode: 'insensitive' } },
              { sku: { contains: filters.search.trim(), mode: 'insensitive' } },
              {
                variants: {
                  some: { sku: { contains: filters.search.trim(), mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          sku: true,
          salePriceCentimes: true,
          purchasePriceCentimes: true,
          isActive: true,
          imageUrls: true,
          confirmationNotes: true,
          category: { select: { id: true, name: true } },
          variants: {
            where: { archivedAt: null },
            select: {
              id: true,
              sku: true,
              label: true,
              attributes: true,
              salePriceCentimes: true,
              isActive: true,
              outOfStockBehavior: true,
              stockExitStrategy: true,
              level: { select: { onHand: true, reserved: true, quarantine: true } },
            },
          },
        },
      }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        sku: row.sku,
        salePriceCentimes: row.salePriceCentimes,
        purchasePriceCentimes: row.purchasePriceCentimes,
        isActive: row.isActive,
        imageUrls: row.imageUrls,
        confirmationNotes: row.confirmationNotes,
        categoryName: row.category?.name ?? null,
        variants: row.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          label: variant.label,
          attributes: variant.attributes as Record<string, string>,
          salePriceCentimes: variant.salePriceCentimes ?? row.salePriceCentimes,
          isActive: variant.isActive,
          outOfStockBehavior: variant.outOfStockBehavior,
          stockExitStrategy: variant.stockExitStrategy,
          onHand: variant.level?.onHand ?? 0,
          reserved: variant.level?.reserved ?? 0,
          available: (variant.level?.onHand ?? 0) - (variant.level?.reserved ?? 0),
        })),
        // Le stock du produit est la somme de ses variantes : c'est le chiffre
        // que le commercant a en tete.
        totalAvailable: row.variants.reduce(
          (sum, variant) =>
            sum + (variant.level?.onHand ?? 0) - (variant.level?.reserved ?? 0),
          0,
        ),
      })),
      meta: buildPageMeta(page, take, total),
    };
  }

  async getProduct(tenantId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { tenantId, id: productId },
      include: {
        category: { select: { id: true, name: true } },
        variants: {
          where: { archivedAt: null },
          include: { level: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Produit introuvable.');
    }

    return product;
  }

  /**
   * Regle le comportement de rupture et la strategie de sortie d'une variante.
   *
   * POURQUOI UN POINT D'ENTREE SEPARE DE `updateProduct`
   *   Ces deux reglages ne decrivent pas l'article vendu, mais la facon dont
   *   le stock se comporte. Ils changent pour des raisons differentes de celles
   *   qui font changer un prix ou un libelle — un article devient perissable
   *   sans changer de nom — et par des personnes differentes : le magasinier
   *   les touche, pas le responsable du catalogue.
   */
  async updateVariantStockSettings(
    tenantId: string,
    variantId: string,
    changes: {
      outOfStockBehavior?: OutOfStockBehavior;
      stockExitStrategy?: StockExitStrategy;
      lowStockThreshold?: number | null;
    },
  ): Promise<void> {
    const updated = await this.prisma.productVariant.updateMany({
      where: { tenantId, id: variantId, archivedAt: null },
      data: {
        ...(changes.outOfStockBehavior !== undefined
          ? { outOfStockBehavior: changes.outOfStockBehavior }
          : {}),
        ...(changes.stockExitStrategy !== undefined
          ? { stockExitStrategy: changes.stockExitStrategy }
          : {}),
        ...(changes.lowStockThreshold !== undefined
          ? { lowStockThreshold: changes.lowStockThreshold }
          : {}),
      },
    });

    if (updated.count === 0) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Variante introuvable.');
    }
  }

  /** Produits proposes en vente additionnelle avec `productId`. */
  async listCrossSells(
    tenantId: string,
    productId: string,
  ): Promise<readonly CrossSellItem[]> {
    const rows = await this.prisma.productCrossSell.findMany({
      where: { tenantId, productId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        crossSellProductId: true,
        position: true,
        crossSellProduct: {
          select: { name: true, sku: true, salePriceCentimes: true, isActive: true },
        },
      },
    });

    return rows.map((row) => ({
      productId: row.crossSellProductId,
      name: row.crossSellProduct.name,
      sku: row.crossSellProduct.sku,
      salePriceCentimes: row.crossSellProduct.salePriceCentimes,
      isActive: row.crossSellProduct.isActive,
      position: row.position,
    }));
  }

  /**
   * Ajoute un produit complementaire, designe par son SKU.
   *
   * LE SKU PLUTOT QUE L'IDENTIFIANT
   *   C'est ce que le commercant a sous les yeux, sur l'etiquette et dans sa
   *   feuille. Exiger un UUID obligerait a passer par un selecteur qui charge
   *   tout le catalogue pour retrouver un article dont on connait deja la
   *   reference.
   */
  async addCrossSell(
    tenantId: string,
    productId: string,
    crossSellSku: string,
  ): Promise<void> {
    const sku = crossSellSku.trim();

    if (!sku) {
      throw new ValidationException('Indiquez le SKU du produit a proposer.', {
        details: { field: 'sku' },
      });
    }

    const target = await this.prisma.product.findFirst({
      where: { tenantId, sku, archivedAt: null },
      select: { id: true },
    });

    if (!target) {
      throw new NotFoundException(
        ERROR_CODES.NOT_FOUND,
        `Aucun produit actif ne porte le SKU « ${sku} ».`,
      );
    }

    if (target.id === productId) {
      // La base l'interdit aussi (CHECK), mais un message clair vaut mieux
      // qu'une violation de contrainte remontee telle quelle.
      throw new ValidationException('Un produit ne peut pas se proposer lui-meme.', {
        details: { field: 'sku', value: sku },
      });
    }

    const source = await this.prisma.product.findFirst({
      where: { tenantId, id: productId, archivedAt: null },
      select: { id: true },
    });

    if (!source) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Produit introuvable.');
    }

    const last = await this.prisma.productCrossSell.findFirst({
      where: { tenantId, productId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    try {
      await this.prisma.productCrossSell.create({
        data: {
          tenantId,
          productId,
          crossSellProductId: target.id,
          position: (last?.position ?? -1) + 1,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          ERROR_CODES.CONFLICT,
          'Ce produit est deja propose en vente additionnelle.',
        );
      }
      throw error;
    }
  }

  async removeCrossSell(
    tenantId: string,
    productId: string,
    crossSellProductId: string,
  ): Promise<void> {
    await this.prisma.productCrossSell.deleteMany({
      where: { tenantId, productId, crossSellProductId },
    });
  }

  /**
   * Lots d'une variante, du plus ancien au plus recent.
   *
   * Les lots EPUISES restent listes : « ou est passe le lot d'octobre ? » est
   * une question qui se pose apres coup, et un lot qui disparait de l'ecran
   * des qu'il est vide ne laisse aucune trace lisible de son cout d'achat.
   */
  async listBatches(
    tenantId: string,
    variantId: string,
    options: { includeExhausted?: boolean } = {},
  ): Promise<readonly StockBatchItem[]> {
    const rows = await this.prisma.stockBatch.findMany({
      where: {
        tenantId,
        variantId,
        ...(options.includeExhausted ? {} : { remainingQuantity: { gt: 0 } }),
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        reference: true,
        quantity: true,
        remainingQuantity: true,
        costCentimes: true,
        expiresAt: true,
        receivedAt: true,
        note: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      quantity: row.quantity,
      remainingQuantity: row.remainingQuantity,
      costCentimes: row.costCentimes,
      expiresAt: row.expiresAt,
      receivedAt: row.receivedAt,
      note: row.note,
    }));
  }

  async listCategories(tenantId: string) {
    return this.prisma.productCategory.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, _count: { select: { products: true } } },
    });
  }

  // -------------------------------------------------------------------------

  private async resolveCategory(
    tx: PrismaTransactionClient,
    tenantId: string,
    name: string,
  ): Promise<{ id: string }> {
    const slug = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);

    return tx.productCategory.upsert({
      where: { tenantId_slug: { tenantId, slug } },
      create: { tenantId, name: name.trim(), slug },
      update: {},
      select: { id: true },
    });
  }
}

export interface CrossSellItem {
  readonly productId: string;
  readonly name: string;
  readonly sku: string;
  readonly salePriceCentimes: number;
  readonly isActive: boolean;
  readonly position: number;
}

export interface StockBatchItem {
  readonly id: string;
  readonly reference: string | null;
  readonly quantity: number;
  readonly remainingQuantity: number;
  readonly costCentimes: number;
  readonly expiresAt: Date | null;
  readonly receivedAt: Date;
  readonly note: string | null;
}

export interface ProductListItem {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly salePriceCentimes: number;
  readonly purchasePriceCentimes: number | null;
  readonly isActive: boolean;
  readonly imageUrls: readonly string[];
  /// Consignes lues par le confirmateur pendant l'appel.
  readonly confirmationNotes: string | null;
  readonly categoryName: string | null;
  readonly variants: readonly {
    id: string;
    sku: string;
    label: string | null;
    attributes: Record<string, string>;
    salePriceCentimes: number;
    isActive: boolean;
    outOfStockBehavior: OutOfStockBehavior;
    stockExitStrategy: StockExitStrategy;
    onHand: number;
    reserved: number;
    available: number;
  }[];
  readonly totalAvailable: number;
}
