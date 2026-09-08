/**
 * Gestion des retours et refus — V1 §14, V2 §18.
 *
 * CYCLE DE VIE
 *   PENDING -> IN_TRANSIT -> RECEIVED -> INSPECTED -> CLOSED
 *   Le mouvement de stock n'a lieu qu'a l'INSPECTION, jamais avant : un colis
 *   annonce en retour par le transporteur n'est pas encore physiquement revenu.
 *   Remettre la marchandise en vente a ce moment-la creerait une survente
 *   garantie — le commercant vendrait un article qui voyage encore.
 *
 * DECISION DE STOCK (V2 §18)
 *   `RESTOCK`     : marchandise controlee et revendable -> stock disponible.
 *   `QUARANTINE`  : a verifier -> stock a verifier, non vendable.
 *   `WRITE_OFF`   : perdue ou detruite -> aucun retour en stock, la
 *                   marchandise devient une perte seche dans le calcul de
 *                   rentabilite (Addendum §33).
 *
 * IDEMPOTENCE
 *   Un webhook transporteur rejoue ne doit pas creer deux retours : un index
 *   UNIQUE PARTIEL garantit un seul retour OUVERT par commande. L'application
 *   du mouvement de stock est protegee par le drapeau `stockApplied` sur
 *   chaque ligne : inspecter deux fois ne double jamais le stock.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ProductCondition, ReturnReason, StockDecision } from '@prisma/client';
import { ERROR_CODES } from '@ecomflow/shared';
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
import { OutboxService, DOMAIN_EVENTS } from '../events/outbox.service';

export interface CreateReturnInput {
  readonly tenantId: string;
  readonly orderId: string;
  readonly reason: ReturnReason;
  readonly reasonDetail?: string | null;
  readonly shipmentId?: string | null;
  readonly membershipId?: string | null;
  readonly returnCostCentimes?: number;
  /** Lignes retournees. A defaut, toutes les lignes de la commande. */
  readonly items?: readonly { orderItemId: string; quantity: number }[];
  readonly notes?: string | null;
}

export interface InspectReturnInput {
  readonly tenantId: string;
  readonly returnId: string;
  readonly membershipId: string;
  readonly lines: readonly {
    returnItemId: string;
    condition: ProductCondition;
    stockDecision: Exclude<StockDecision, 'PENDING'>;
  }[];
  readonly notes?: string | null;
  readonly returnCostCentimes?: number;
}

@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly inventory: InventoryService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // CREATION
  // ==========================================================================

  /**
   * Cree un retour rattache a sa commande d'origine.
   *
   * Si un retour ouvert existe deja, il est RETOURNE tel quel plutot que de
   * lever une erreur : c'est exactement ce qui se produit quand un webhook
   * transporteur est rejoue, et ce n'est pas une anomalie.
   */
  async createReturn(
    input: CreateReturnInput,
    tx?: PrismaTransactionClient,
  ): Promise<{ returnId: string; reference: string; alreadyExisted: boolean }> {
    if (tx) return this.createWithin(tx, input);
    return this.prisma.$transaction((rawTx) =>
      this.createWithin(rawTx as PrismaTransactionClient, input),
    );
  }

  private async createWithin(
    tx: PrismaTransactionClient,
    input: CreateReturnInput,
  ): Promise<{ returnId: string; reference: string; alreadyExisted: boolean }> {
    const order = await tx.order.findFirst({
      where: { tenantId: input.tenantId, id: input.orderId },
      select: {
        id: true,
        reference: true,
        status: true,
        items: { select: { id: true, variantId: true, quantity: true } },
      },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    const existing = await tx.return.findFirst({
      where: {
        tenantId: input.tenantId,
        orderId: input.orderId,
        status: { notIn: ['CLOSED', 'CANCELLED'] },
      },
      select: { id: true, reference: true },
    });

    if (existing) {
      return { returnId: existing.id, reference: existing.reference, alreadyExisted: true };
    }

    // --- Lignes retournees --------------------------------------------------
    const itemsById = new Map(order.items.map((item) => [item.id, item]));
    const requested =
      input.items ??
      order.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity }));

    const lines: { orderItemId: string; variantId: string; quantity: number }[] = [];

    for (const line of requested) {
      const orderItem = itemsById.get(line.orderItemId);
      if (!orderItem) {
        throw new ValidationException(
          'Une ligne de retour reference un article absent de la commande.',
          { details: { orderItemId: line.orderItemId } },
        );
      }
      if (line.quantity <= 0 || line.quantity > orderItem.quantity) {
        throw new ValidationException(
          `Quantite retournee invalide pour la ligne ${line.orderItemId} : ` +
            `${line.quantity} (commande : ${orderItem.quantity}).`,
        );
      }
      lines.push({
        orderItemId: orderItem.id,
        variantId: orderItem.variantId,
        quantity: line.quantity,
      });
    }

    const reference = await this.allocateReference(tx, input.tenantId, order.reference);

    try {
      const created = await tx.return.create({
        data: {
          tenantId: input.tenantId,
          orderId: input.orderId,
          shipmentId: input.shipmentId ?? null,
          reference,
          reason: input.reason,
          reasonDetail: input.reasonDetail ?? null,
          status: 'PENDING',
          returnCostCentimes: input.returnCostCentimes ?? 0,
          notes: input.notes ?? null,
          createdByMembershipId: input.membershipId ?? null,
          items: {
            create: lines.map((line) => ({
              tenantId: input.tenantId,
              orderItemId: line.orderItemId,
              variantId: line.variantId,
              quantity: line.quantity,
            })),
          },
        },
        select: { id: true, reference: true },
      });

      // Le cout du retour alimente le calcul de perte (Addendum §33).
      if (input.returnCostCentimes && input.returnCostCentimes > 0) {
        await tx.order.update({
          where: { id: input.orderId },
          data: { returnCostCentimes: input.returnCostCentimes },
        });
      }

      await this.outbox.publish(tx, {
        tenantId: input.tenantId,
        eventType: DOMAIN_EVENTS.RETURN_CREATED,
        payload: {
          returnId: created.id,
          orderId: input.orderId,
          orderReference: order.reference,
          reason: input.reason,
        },
      });

      this.logger.log(
        `Retour ${created.reference} cree pour la commande ${order.reference} ` +
          `(motif : ${input.reason}).`,
      );

      return { returnId: created.id, reference: created.reference, alreadyExisted: false };
    } catch (error) {
      // L'index unique partiel a tranche une course entre deux webhooks.
      if (isUniqueConstraintError(error)) {
        const winner = await tx.return.findFirst({
          where: {
            tenantId: input.tenantId,
            orderId: input.orderId,
            status: { notIn: ['CLOSED', 'CANCELLED'] },
          },
          select: { id: true, reference: true },
        });
        if (winner) {
          return { returnId: winner.id, reference: winner.reference, alreadyExisted: true };
        }
      }
      throw error;
    }
  }

  // ==========================================================================
  // CYCLE DE VIE
  // ==========================================================================

  /** Le colis a ete remis au transporteur pour le retour. */
  async markInTransit(tenantId: string, returnId: string): Promise<void> {
    await this.transitionStatus(tenantId, returnId, 'IN_TRANSIT', ['PENDING']);
  }

  /** Le colis est physiquement revenu chez le commercant. */
  async markReceived(tenantId: string, returnId: string): Promise<void> {
    await this.transitionStatus(tenantId, returnId, 'RECEIVED', ['PENDING', 'IN_TRANSIT'], {
      receivedAt: this.clock.now(),
    });
  }

  /**
   * Inspection : c'est ICI, et seulement ici, que le stock bouge.
   *
   * Chaque ligne recoit son etat et sa decision. Le drapeau `stockApplied`
   * garantit qu'une inspection rejouee ne double jamais le stock.
   */
  async inspect(input: InspectReturnInput): Promise<{
    returnId: string;
    restocked: number;
    quarantined: number;
    writtenOff: number;
  }> {
    return this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      const returnRecord = await tx.return.findFirst({
        where: { tenantId: input.tenantId, id: input.returnId },
        select: {
          id: true,
          status: true,
          orderId: true,
          items: {
            select: { id: true, variantId: true, quantity: true, stockApplied: true },
          },
        },
      });

      if (!returnRecord) {
        throw new NotFoundException(ERROR_CODES.RETURN_NOT_FOUND, 'Retour introuvable.');
      }

      if (['CLOSED', 'CANCELLED'].includes(returnRecord.status)) {
        throw new ConflictException(
          ERROR_CODES.RETURN_INVALID_STATE,
          'Ce retour est deja cloture.',
        );
      }

      const itemsById = new Map(returnRecord.items.map((item) => [item.id, item]));

      let restocked = 0;
      let quarantined = 0;
      let writtenOff = 0;

      for (const line of input.lines) {
        const item = itemsById.get(line.returnItemId);
        if (!item) {
          throw new ValidationException(
            'Une ligne d inspection reference un article absent du retour.',
            { details: { returnItemId: line.returnItemId } },
          );
        }

        // Deja traitee : on ignore silencieusement plutot que d'echouer.
        // Reprendre une inspection interrompue doit rester possible.
        if (item.stockApplied) {
          this.logger.debug(
            `Ligne de retour ${item.id} deja appliquee au stock : ignoree.`,
          );
          continue;
        }

        if (line.stockDecision === 'RESTOCK') {
          await this.inventory.processReturn(
            tx,
            input.tenantId,
            item.variantId,
            item.quantity,
            'RESTOCK',
            {
              referenceType: 'RETURN',
              referenceId: returnRecord.id,
              actorId: input.membershipId,
              note: 'Retour controle, remis en vente',
            },
          );
          restocked += item.quantity;
        } else if (line.stockDecision === 'QUARANTINE') {
          await this.inventory.processReturn(
            tx,
            input.tenantId,
            item.variantId,
            item.quantity,
            'QUARANTINE',
            {
              referenceType: 'RETURN',
              referenceId: returnRecord.id,
              actorId: input.membershipId,
              note: 'Retour place en stock a verifier',
            },
          );
          quarantined += item.quantity;
        } else {
          // WRITE_OFF : aucun mouvement de stock. La marchandise est perdue,
          // ce que le calcul de rentabilite prendra en compte.
          writtenOff += item.quantity;
        }

        await tx.returnItem.update({
          where: { id: item.id },
          data: {
            condition: line.condition,
            stockDecision: line.stockDecision,
            stockApplied: true,
          },
        });
      }

      // La decision au niveau du retour est la plus « severe » rencontree :
      // elle resume l'issue pour le reporting.
      const overallDecision: StockDecision =
        writtenOff > 0 ? 'WRITE_OFF' : quarantined > 0 ? 'QUARANTINE' : 'RESTOCK';

      await tx.return.update({
        where: { id: returnRecord.id },
        data: {
          status: 'INSPECTED',
          stockDecision: overallDecision,
          productCondition: input.lines[0]?.condition ?? 'UNKNOWN',
          inspectedAt: this.clock.now(),
          notes: input.notes ?? undefined,
          ...(input.returnCostCentimes !== undefined
            ? { returnCostCentimes: input.returnCostCentimes }
            : {}),
        },
      });

      if (input.returnCostCentimes !== undefined) {
        await tx.order.update({
          where: { id: returnRecord.orderId },
          data: { returnCostCentimes: input.returnCostCentimes },
        });
      }

      this.logger.log(
        `Retour ${returnRecord.id} inspecte : ${restocked} remis en stock, ` +
          `${quarantined} en verification, ${writtenOff} perdus.`,
      );

      return { returnId: returnRecord.id, restocked, quarantined, writtenOff };
    });
  }

  /** Cloture definitive du retour. */
  async close(tenantId: string, returnId: string): Promise<void> {
    const returnRecord = await this.prisma.return.findFirst({
      where: { tenantId, id: returnId },
      select: { status: true, items: { select: { stockApplied: true } } },
    });

    if (!returnRecord) {
      throw new NotFoundException(ERROR_CODES.RETURN_NOT_FOUND, 'Retour introuvable.');
    }

    // Clore un retour dont le stock n'a pas ete arbitre laisserait de la
    // marchandise dans un etat indetermine.
    const pending = returnRecord.items.filter((item) => !item.stockApplied);
    if (pending.length > 0) {
      throw new ConflictException(
        ERROR_CODES.RETURN_INVALID_STATE,
        'Inspectez toutes les lignes avant de cloturer le retour.',
        { details: { pendingLines: pending.length } },
      );
    }

    await this.prisma.return.update({
      where: { id: returnId },
      data: { status: 'CLOSED', closedAt: this.clock.now() },
    });
  }

  /** Annule un retour cree par erreur. */
  async cancel(tenantId: string, returnId: string, reason: string): Promise<void> {
    const returnRecord = await this.prisma.return.findFirst({
      where: { tenantId, id: returnId },
      select: { status: true, items: { select: { stockApplied: true } } },
    });

    if (!returnRecord) {
      throw new NotFoundException(ERROR_CODES.RETURN_NOT_FOUND, 'Retour introuvable.');
    }

    // Un retour dont le stock a deja bouge ne peut pas etre annule : il
    // faudrait defaire des mouvements, ce qui casserait la piste d'audit.
    if (returnRecord.items.some((item) => item.stockApplied)) {
      throw new ConflictException(
        ERROR_CODES.RETURN_INVALID_STATE,
        'Ce retour a deja produit des mouvements de stock : il ne peut plus etre annule. ' +
          'Passez par un ajustement de stock si une correction est necessaire.',
      );
    }

    await this.prisma.return.update({
      where: { id: returnId },
      data: {
        status: 'CANCELLED',
        closedAt: this.clock.now(),
        notes: reason.slice(0, 500),
      },
    });
  }

  // ==========================================================================
  // LECTURE
  // ==========================================================================

  async list(
    tenantId: string,
    filters: { status?: string[]; reason?: ReturnReason[]; from?: Date; to?: Date } = {},
  ) {
    return this.prisma.return.findMany({
      where: {
        tenantId,
        ...(filters.status?.length
          ? { status: { in: filters.status as never[] } }
          : {}),
        ...(filters.reason?.length ? { reason: { in: [...filters.reason] } } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          select: { id: true, reference: true, customerNameSnapshot: true, totalCentimes: true },
        },
        items: true,
      },
      take: 200,
    });
  }

  async getById(tenantId: string, returnId: string) {
    const record = await this.prisma.return.findFirst({
      where: { tenantId, id: returnId },
      include: {
        order: { select: { id: true, reference: true, customerNameSnapshot: true } },
        shipment: { select: { trackingNumber: true, carrier: { select: { name: true } } } },
        // Le magasinier inspecte des produits, pas des identifiants : le nom et
        // le SKU accompagnent chaque ligne pour qu'il sache ce qu'il tient.
        items: {
          include: {
            variant: { select: { sku: true, label: true } },
            orderItem: { select: { productNameSnapshot: true, skuSnapshot: true } },
          },
        },
      },
    });

    if (!record) {
      throw new NotFoundException(ERROR_CODES.RETURN_NOT_FOUND, 'Retour introuvable.');
    }

    return record;
  }

  // -------------------------------------------------------------------------

  private async transitionStatus(
    tenantId: string,
    returnId: string,
    to: 'IN_TRANSIT' | 'RECEIVED',
    allowedFrom: readonly string[],
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const updated = await this.prisma.return.updateMany({
      where: { tenantId, id: returnId, status: { in: allowedFrom as never[] } },
      data: { status: to, ...extra },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        ERROR_CODES.RETURN_INVALID_STATE,
        `Ce retour ne peut pas passer a ${to} depuis son statut actuel.`,
      );
    }
  }

  /**
   * Reference lisible du retour : `RET-<reference commande>`.
   * Un suffixe numerique est ajoute pour un second retour sur la meme commande
   * (SAV apres cloture du premier).
   */
  private async allocateReference(
    tx: PrismaTransactionClient,
    tenantId: string,
    orderReference: string,
  ): Promise<string> {
    const base = `RET-${orderReference.replace(/^ORD-/, '')}`;

    const existing = await tx.return.count({
      where: { tenantId, reference: { startsWith: base } },
    });

    return existing === 0 ? base : `${base}-${existing + 1}`;
  }
}
