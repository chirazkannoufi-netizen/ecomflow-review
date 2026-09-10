/**
 * Moteur de workflow des commandes — V1 §8, V2 §10.
 *
 * C'est le POINT DE PASSAGE OBLIGE de tout changement de statut : interface,
 * webhook transporteur, filtre WhatsApp, import, job de relance. Aucun autre
 * code n'ecrit `orders.status`.
 *
 * Pourquoi cette centralisation est non negociable :
 *   un changement de statut n'est jamais une simple ecriture de colonne. Il
 *   entraine, selon le cas, une reservation de stock, une liberation, une
 *   sortie definitive, une mise a jour des compteurs client, une date metier,
 *   une ligne d'historique et un evenement de notification. Disperser cette
 *   logique produirait inevitablement des etats incoherents — stock reserve
 *   pour une commande annulee, compteurs clients faux, historique troue.
 *
 * TROIS NIVEAUX DE CONTROLE, dans cet ordre :
 *   1. la TRANSITION est-elle declaree ? (table `ORDER_TRANSITIONS`)
 *   2. l'ACTEUR a-t-il le droit de la declencher ? (permissions, type d'acteur)
 *   3. les GARDES metier sont-elles satisfaites ? (stock, adresse, colis...)
 *
 * Tout est execute DANS UNE SEULE TRANSACTION SQL : soit la commande change de
 * statut avec tous ses effets, soit rien ne bouge.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { OrderStatus as PrismaOrderStatus } from '@prisma/client';
import {
  ERROR_CODES,
  STOCK_RESERVED_STATUSES,
  findTransition,
  getOutgoingTransitions,
  resolveOutOfStockBehavior,
  type OrderStatus,
  type OrderTransitionRule,
  type TransitionActorKind,
  type TransitionGuard,
} from '@ecomflow/shared';
import {
  BusinessException,
  ConflictException,
  InvalidOrderTransitionException,
  NotFoundException,
  PermissionDeniedException,
  TransitionGuardFailedException,
} from '../../../common/errors/business.exception';
import { HttpStatus } from '@nestjs/common';
import { ClockService } from '../../../infra/clock/clock.service';
import { InjectPrisma, type PrismaClientExtended } from '../../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../../infra/prisma/prisma.service';
import { InventoryService } from '../../inventory/inventory.service';
import { SubscriptionStateService } from '../../billing/subscription-state.service';
import { CustomerStatsService } from '../../customers/customer-stats.service';
import { OutboxService } from '../../events/outbox.service';

export interface TransitionRequest {
  readonly tenantId: string;
  readonly orderId: string;
  readonly to: OrderStatus;
  /** `USER` pour une action d'interface, `SYSTEM` pour un job ou un webhook. */
  readonly actorKind: TransitionActorKind;
  /** Adhesion de l'utilisateur, si l'acteur est humain. */
  readonly membershipId?: string | null;
  /** Permissions effectives de l'acteur. Ignore pour un acteur SYSTEM. */
  readonly permissions?: ReadonlySet<string>;
  readonly reason?: string | null;
  readonly note?: string | null;
  /** Origine lisible : `ui`, `carrier-webhook:yalidine`, `whatsapp-filter`... */
  readonly source: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * Ignore les gardes listees. Reserve aux corrections administratives
   * explicites, toujours journalisees.
   */
  readonly bypassGuards?: readonly TransitionGuard[];
}

export interface TransitionResult {
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly appliedAt: Date;
  /** Effets declenches, exposes pour les tests et le journal d'audit. */
  readonly effects: readonly string[];
}

/** Vue minimale d'une commande necessaire a l'evaluation des gardes. */
interface OrderSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly status: PrismaOrderStatus;
  readonly phoneSnapshot: string;
  readonly addressId: string | null;
  readonly addressSnapshot: string | null;
  readonly wilayaCodeSnapshot: number | null;
  readonly stockReserved: boolean;
  readonly stockReleased: boolean;
  readonly customerId: string;
  readonly archivedAt: Date | null;
  readonly items: readonly {
    id: string;
    variantId: string;
    quantity: number;
    preparedQuantity: number | null;
    skuSnapshot: string;
  }[];
  readonly activeShipmentCount: number;
}

@Injectable()
export class OrderWorkflowService {
  private readonly logger = new Logger(OrderWorkflowService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly inventory: InventoryService,
    private readonly subscriptions: SubscriptionStateService,
    private readonly customerStats: CustomerStatsService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // API PUBLIQUE
  // ==========================================================================

  /**
   * Applique une transition de statut avec tous ses effets metier.
   *
   * @throws InvalidOrderTransitionException si la transition n'existe pas
   * @throws PermissionDeniedException si l'acteur n'a pas le droit
   * @throws TransitionGuardFailedException si une garde metier echoue
   */
  async transition(request: TransitionRequest): Promise<TransitionResult> {
    return this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;
      // La validation lit DANS la transaction : elle voit ainsi l'etat le plus
      // recent, y compris les ecritures non encore commitees par l'appelant.
      const rule = await this.validateRequest(tx, request);
      return this.applyWithin(tx, request, rule);
    });
  }

  /**
   * Variante executee DANS une transaction fournie par l'appelant.
   * Indispensable quand la transition accompagne d'autres ecritures qui
   * doivent partager son sort : creation de colis, traitement d'un retour.
   */
  async transitionWithin(
    tx: PrismaTransactionClient,
    request: TransitionRequest,
  ): Promise<TransitionResult> {
    const rule = await this.validateRequest(tx, request);
    return this.applyWithin(tx, request, rule);
  }

  /**
   * Transitions possibles depuis le statut courant, filtrees par les droits
   * de l'appelant. Alimente les boutons d'action de l'interface.
   */
  async listAvailableTransitions(
    tenantId: string,
    orderId: string,
    permissions: ReadonlySet<string>,
  ): Promise<readonly { to: OrderStatus; requiresReason: boolean; permission: string }[]> {
    const order = await this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: { status: true },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    return getOutgoingTransitions(order.status)
      .filter((rule) => rule.actors.includes('USER') && permissions.has(rule.permission))
      .map((rule) => ({
        to: rule.to,
        requiresReason: rule.requiresReason,
        permission: rule.permission,
      }));
  }

  // ==========================================================================
  // VALIDATION
  // ==========================================================================

  private async validateRequest(
    client: PrismaTransactionClient,
    request: TransitionRequest,
  ): Promise<OrderTransitionRule> {
    const order = await this.loadSnapshot(client, request.tenantId, request.orderId);

    if (order.archivedAt) {
      throw new ConflictException(
        ERROR_CODES.ORDER_ARCHIVED,
        'Cette commande est archivee : son statut ne peut plus changer.',
      );
    }

    const from = order.status;

    // --- 1. La transition existe-t-elle ? ---------------------------------
    const rule = findTransition(from, request.to);
    if (!rule) {
      const allowed = getOutgoingTransitions(from).map((entry) => entry.to);
      throw new InvalidOrderTransitionException(from, request.to, allowed);
    }

    // --- 2. L'acteur a-t-il le droit ? ------------------------------------
    if (!rule.actors.includes(request.actorKind)) {
      throw new BusinessException(
        ERROR_CODES.FORBIDDEN,
        request.actorKind === 'SYSTEM'
          ? `La transition ${from} vers ${request.to} exige une action humaine.`
          : `La transition ${from} vers ${request.to} est reservee au systeme.`,
        HttpStatus.FORBIDDEN,
        { details: { from, to: request.to, actorKind: request.actorKind } },
      );
    }

    if (request.actorKind === 'USER') {
      const permissions = request.permissions ?? new Set<string>();
      if (!permissions.has(rule.permission)) {
        throw new PermissionDeniedException([rule.permission]);
      }
    }

    // --- 3. Une raison est-elle exigee ? -----------------------------------
    if (rule.requiresReason && !request.reason?.trim()) {
      throw new BusinessException(
        ERROR_CODES.ORDER_REASON_REQUIRED,
        `Un motif est obligatoire pour passer la commande en ${request.to}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { details: { from, to: request.to } },
      );
    }

    // --- 4. Gardes metier ---------------------------------------------------
    const bypassed = new Set(request.bypassGuards ?? []);
    for (const guard of rule.guards) {
      if (bypassed.has(guard)) {
        this.logger.warn(
          `Garde ${guard} contournee sur la commande ${request.orderId} ` +
            `(${from} -> ${request.to}, source=${request.source}).`,
        );
        continue;
      }
      await this.evaluateGuard(client, guard, order, request);
    }

    return rule;
  }

  /**
   * Evalue une garde metier.
   *
   * Chaque garde produit un message explicite : l'agent doit comprendre ce
   * qu'il lui reste a faire, pas seulement que « ca n'a pas marche ».
   */
  private async evaluateGuard(
    client: PrismaTransactionClient,
    guard: TransitionGuard,
    order: OrderSnapshot,
    request: TransitionRequest,
  ): Promise<void> {
    switch (guard) {
      case 'REQUIRE_CUSTOMER_PHONE': {
        if (!order.phoneSnapshot?.trim()) {
          throw new TransitionGuardFailedException(
            guard,
            'Le numero de telephone du client est obligatoire avant de confirmer.',
          );
        }
        return;
      }

      case 'REQUIRE_DELIVERY_ADDRESS': {
        const hasAddress =
          Boolean(order.addressId) ||
          (Boolean(order.addressSnapshot?.trim()) && order.wilayaCodeSnapshot !== null);
        if (!hasAddress) {
          throw new TransitionGuardFailedException(
            guard,
            'Une adresse de livraison complete (wilaya, commune, adresse) est requise.',
          );
        }
        return;
      }

      case 'REQUIRE_AT_LEAST_ONE_ITEM': {
        if (order.items.length === 0) {
          throw new TransitionGuardFailedException(
            guard,
            'La commande ne contient aucun article.',
          );
        }
        return;
      }

      case 'REQUIRE_STOCK_AVAILABLE': {
        // Le stock deja reserve pour cette commande n'a pas a l'etre deux fois.
        if (order.stockReserved) return;

        const settings = await client.tenantSettings.findUnique({
          where: { tenantId: order.tenantId },
          select: { allowOversell: true, reserveStockOnConfirm: true },
        });

        const shop = {
          allowOversell: settings?.allowOversell ?? false,
          reserveStockOnConfirm: settings?.reserveStockOnConfirm ?? true,
        };

        const shortages = await this.inventory.findShortages(
          order.tenantId,
          order.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
          client,
        );

        // Le controle est desormais LIGNE PAR LIGNE.
        //
        // Auparavant, un seul reglage de boutique decidait pour tout le
        // catalogue, et la garde sortait avant meme de regarder le stock des
        // que la boutique tolerait la survente. Une variante ne pouvait donc
        // pas se proteger seule — or c'est precisement ce que demande un
        // article perissable dans une boutique qui accepte les precommandes
        // sur le reste de sa gamme.
        //
        // Une variante restee sur `INHERIT` retrouve exactement l'ancienne
        // condition (voir `resolveOutOfStockBehavior`).
        const blocking = shortages.filter(
          (shortage) => resolveOutOfStockBehavior(shortage.outOfStockBehavior, shop) !== 'ALLOW',
        );

        if (blocking.length > 0) {
          throw new TransitionGuardFailedException(
            guard,
            'Stock insuffisant pour confirmer cette commande.',
            {
              shortages: blocking.map((shortage) => ({
                sku: shortage.sku,
                requested: shortage.requested,
                available: shortage.available,
                reason: resolveOutOfStockBehavior(shortage.outOfStockBehavior, shop),
              })),
            },
          );
        }
        return;
      }

      case 'REQUIRE_PREPARATION_COMPLETED': {
        const incomplete = order.items.filter(
          (item) => item.preparedQuantity === null || item.preparedQuantity < item.quantity,
        );
        if (incomplete.length > 0) {
          throw new TransitionGuardFailedException(
            guard,
            'Toutes les lignes doivent etre preparees avant de marquer la commande prete a expedier.',
            {
              pendingLines: incomplete.map((item) => ({
                sku: item.skuSnapshot,
                expected: item.quantity,
                prepared: item.preparedQuantity ?? 0,
              })),
            },
          );
        }
        return;
      }

      case 'REQUIRE_ACTIVE_SHIPMENT': {
        if (order.activeShipmentCount === 0) {
          throw new TransitionGuardFailedException(
            guard,
            'Aucun colis actif : creez d abord l expedition chez le transporteur.',
          );
        }
        return;
      }

      case 'REQUIRE_NO_ACTIVE_SHIPMENT': {
        if (order.activeShipmentCount > 0) {
          throw new TransitionGuardFailedException(
            guard,
            'Un colis est encore actif chez le transporteur. Annulez-le d abord.',
          );
        }
        return;
      }

      case 'REQUIRE_SUBSCRIPTION_OPERATIONAL': {
        const state = await this.subscriptions.getState(order.tenantId);
        if (!state.operational) {
          throw new BusinessException(
            ERROR_CODES.SUBSCRIPTION_REQUIRED,
            `Operation bloquee : ${state.reason}`,
            HttpStatus.PAYMENT_REQUIRED,
            { details: { subscriptionStatus: state.status, source: request.source } },
          );
        }
        return;
      }
    }
  }

  // ==========================================================================
  // APPLICATION
  // ==========================================================================

  private async applyWithin(
    tx: PrismaTransactionClient,
    request: TransitionRequest,
    rule: OrderTransitionRule,
  ): Promise<TransitionResult> {
    const now = this.clock.now();
    const effects: string[] = [];

    // Relecture DANS la transaction, avec verrouillage optimiste par statut :
    // si un autre acteur a change le statut entre la validation et
    // l'application, l'update ne touche aucune ligne et on echoue proprement
    // plutot que d'ecraser sa decision.
    const current = await tx.order.findFirst({
      where: { tenantId: request.tenantId, id: request.orderId },
      select: { status: true, customerId: true, stockReserved: true, stockReleased: true },
    });

    if (!current) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    const from = current.status;
    if (from !== rule.from) {
      throw new ConflictException(
        ERROR_CODES.ORDER_INVALID_TRANSITION,
        'La commande a change de statut entre-temps. Rechargez la fiche.',
        { details: { expected: rule.from, actual: from } },
      );
    }

    const items = await tx.orderItem.findMany({
      where: { tenantId: request.tenantId, orderId: request.orderId },
      select: { variantId: true, quantity: true },
    });

    // --- Effets sur le stock -------------------------------------------------
    const wasReserved = STOCK_RESERVED_STATUSES.includes(from);
    const willBeReserved = STOCK_RESERVED_STATUSES.includes(request.to);
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: request.tenantId },
      select: { allowOversell: true, reserveStockOnConfirm: true },
    });

    const stockContext = {
      referenceType: 'ORDER' as const,
      referenceId: request.orderId,
      actorId: request.membershipId ?? null,
      note: `Transition ${from} -> ${request.to}`,
    };

    let stockReserved = current.stockReserved;
    let stockReleased = current.stockReleased;

    if (
      !wasReserved &&
      willBeReserved &&
      !current.stockReserved &&
      settings?.reserveStockOnConfirm !== false
    ) {
      await this.inventory.reserve(
        tx,
        request.tenantId,
        items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        stockContext,
        settings?.allowOversell ?? false,
      );
      stockReserved = true;
      effects.push('STOCK_RESERVED');
    }

    if (request.to === 'SHIPPED' && current.stockReserved && !current.stockReleased) {
      // L'expedition transforme la reservation en sortie definitive.
      await this.inventory.commitOutbound(
        tx,
        request.tenantId,
        items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        stockContext,
      );
      stockReleased = true;
      effects.push('STOCK_SHIPPED_OUT');
    } else if (
      wasReserved &&
      !willBeReserved &&
      current.stockReserved &&
      !current.stockReleased
    ) {
      // Annulation avant expedition : la marchandise redevient vendable.
      await this.inventory.releaseReservation(
        tx,
        request.tenantId,
        items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        stockContext,
      );
      stockReserved = false;
      effects.push('STOCK_RESERVATION_RELEASED');
    }

    // --- Dates metier --------------------------------------------------------
    const dates = this.businessDates(request.to, now);
    if (Object.keys(dates).length > 0) effects.push('BUSINESS_DATE_SET');

    // --- Mise a jour de la commande -----------------------------------------
    const updated = await tx.order.updateMany({
      where: { tenantId: request.tenantId, id: request.orderId, status: from },
      data: {
        status: request.to,
        stockReserved,
        stockReleased,
        ...dates,
        ...(request.to === 'READY_TO_SHIP' && request.membershipId
          ? { preparedByMembershipId: request.membershipId }
          : {}),
      },
    });

    if (updated.count === 0) {
      // Course perdue : un autre acteur a modifie le statut dans l'intervalle.
      throw new ConflictException(
        ERROR_CODES.ORDER_INVALID_TRANSITION,
        'La commande a ete modifiee simultanement. Rechargez la fiche et reessayez.',
      );
    }

    // --- Historique ----------------------------------------------------------
    await tx.orderStatusHistory.create({
      data: {
        tenantId: request.tenantId,
        orderId: request.orderId,
        oldStatus: from,
        newStatus: request.to,
        actorKind: request.actorKind,
        actorId: request.membershipId ?? null,
        source: request.source,
        reason: request.reason ?? null,
        note: request.note ?? null,
        metadata: request.metadata ? (request.metadata as object) : undefined,
        createdAt: now,
      },
    });
    effects.push('HISTORY_RECORDED');

    // --- Compteurs client ----------------------------------------------------
    if (isFinalOutcome(request.to)) {
      await this.customerStats.applyOutcome(tx, request.tenantId, current.customerId, request.to);
      effects.push('CUSTOMER_STATS_UPDATED');
    }

    // --- Evenement metier ----------------------------------------------------
    // Ecrit dans la MEME transaction : une notification ne peut donc jamais
    // partir pour une transition finalement annulee (V2 §30).
    await this.outbox.publish(tx, {
      tenantId: request.tenantId,
      eventType: 'order.status_changed',
      payload: {
        orderId: request.orderId,
        from,
        to: request.to,
        actorKind: request.actorKind,
        membershipId: request.membershipId ?? null,
        reason: request.reason ?? null,
        source: request.source,
      },
    });
    effects.push('EVENT_PUBLISHED');

    this.logger.log(
      `Commande ${request.orderId} : ${from} -> ${request.to} ` +
        `(acteur=${request.actorKind}, source=${request.source}, effets=${effects.join('+')})`,
    );

    return { orderId: request.orderId, from, to: request.to, appliedAt: now, effects };
  }

  // ==========================================================================
  // Utilitaires
  // ==========================================================================

  private async loadSnapshot(
    client: PrismaTransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<OrderSnapshot> {
    const order = await client.order.findFirst({
      where: { tenantId, id: orderId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        phoneSnapshot: true,
        addressId: true,
        addressSnapshot: true,
        wilayaCodeSnapshot: true,
        stockReserved: true,
        stockReleased: true,
        customerId: true,
        archivedAt: true,
        items: {
          select: {
            id: true,
            variantId: true,
            quantity: true,
            preparedQuantity: true,
            skuSnapshot: true,
          },
        },
        _count: {
          select: {
            shipments: {
              where: {
                status: {
                  in: [
                    'CREATION_PENDING',
                    'CREATED',
                    'PICKED_UP',
                    'IN_TRANSIT',
                    'OUT_FOR_DELIVERY',
                    'FAILED_ATTEMPT',
                    'RETURNING',
                  ],
                },
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    return { ...order, activeShipmentCount: order._count.shipments };
  }

  /** Date metier a horodater selon le statut atteint (V1 §7). */
  private businessDates(to: OrderStatus, now: Date): Record<string, Date> {
    switch (to) {
      case 'CONFIRMED':
        return { confirmedAt: now };
      case 'READY_TO_SHIP':
        return { preparedAt: now };
      case 'SHIPPED':
        return { shippedAt: now };
      case 'DELIVERED':
        return { deliveredAt: now };
      case 'RETURNED':
        return { returnedAt: now };
      case 'CANCELLED':
        return { cancelledAt: now };
      default:
        return {};
    }
  }
}

/** Statuts qui closent le sort d'une commande du point de vue du client. */
function isFinalOutcome(status: OrderStatus): boolean {
  return ['DELIVERED', 'CANCELLED', 'REFUSED', 'RETURNED'].includes(status);
}

/** Reexporte pour les tests unitaires. */
export const __testables = { isFinalOutcome };
