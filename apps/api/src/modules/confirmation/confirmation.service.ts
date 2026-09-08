/**
 * Centre de confirmation telephonique — V1 §9, V2 §11.
 *
 * C'est l'ecran le plus utilise de la plateforme : un agent y traite des
 * dizaines de commandes par heure. Deux exigences en decoulent :
 *
 *  1. LA FILE DOIT ETRE RAPIDE. Elle s'appuie sur un index partiel dedie
 *     (`orders_confirmation_queue_idx`) restreint aux statuts reellement
 *     presents dans la file, et n'agrege rien a la volee.
 *
 *  2. UNE ACTION = UN APPEL. Confirmer, rappeler, reporter ou annuler declenche
 *     en une seule operation : l'enregistrement de la tentative d'appel, la
 *     transition de statut avec tous ses effets metier (stock, compteurs
 *     client, historique) et la planification du rappel. L'agent ne doit jamais
 *     avoir a enchainer deux ecrans pour une seule decision.
 *
 * PRIORISATION (Addendum §32)
 *   Les clients fiables remontent dans la file. Un client a risque n'en est
 *   JAMAIS exclu : il est simplement traite plus tard. Le score aide l'agent,
 *   il ne decide pas a sa place.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CallOutcome, Prisma } from '@prisma/client';
import {
  CONFIRMATION_QUEUE_STATUSES,
  ERROR_CODES,
  buildPageMeta,
  reliabilityQueueWeight,
  toSkipTake,
  type OrderStatus,
  type Paginated,
} from '@ecomflow/shared';
import {
  ConflictException,
  NotFoundException,
  ValidationException,
} from '../../common/errors/business.exception';
import { ClockService } from '../../infra/clock/clock.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { CustomerStatsService } from '../customers/customer-stats.service';
import { OrderWorkflowService } from '../orders/workflow/order-workflow.service';

/** Actions rapides du centre de confirmation (V1 §9). */
export type ConfirmationAction =
  | 'CONFIRM'
  | 'CALL_BACK'
  | 'POSTPONE'
  | 'NO_ANSWER'
  | 'CANCEL'
  | 'WRONG_NUMBER';

/** Correspondance action -> statut cible et resultat d'appel enregistre. */
const ACTION_MAP: Record<
  ConfirmationAction,
  { status: OrderStatus; outcome: CallOutcome; requiresReason: boolean }
> = {
  CONFIRM: { status: 'CONFIRMED', outcome: 'CONFIRMED', requiresReason: false },
  CALL_BACK: { status: 'CALL_BACK', outcome: 'CALL_BACK', requiresReason: false },
  POSTPONE: { status: 'POSTPONED', outcome: 'POSTPONED', requiresReason: false },
  NO_ANSWER: { status: 'NO_ANSWER', outcome: 'NO_ANSWER', requiresReason: false },
  CANCEL: { status: 'CANCELLED', outcome: 'CANCELLED', requiresReason: true },
  WRONG_NUMBER: { status: 'WRONG_NUMBER', outcome: 'WRONG_NUMBER', requiresReason: false },
};

export interface QueueFilters {
  readonly status?: readonly OrderStatus[];
  readonly wilayaCode?: number;
  readonly source?: string;
  /** Restreint aux commandes affectees a cet agent. */
  readonly assignedMembershipId?: string;
  /** Restreint aux commandes non affectees. */
  readonly unassignedOnly?: boolean;
  /** Exclut les rappels programmes dans le futur. */
  readonly dueOnly?: boolean;
  readonly search?: string;
}

export interface QueueItem {
  readonly orderId: string;
  readonly reference: string;
  readonly status: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly address: string | null;
  readonly totalCentimes: number;
  readonly deliveryFeeCentimes: number;
  readonly items: readonly { sku: string; productName: string; quantity: number; unitPriceCentimes: number }[];
  readonly notes: string | null;
  readonly callAttemptsCount: number;
  readonly nextCallbackAt: Date | null;
  readonly assigneeName: string | null;
  readonly createdAt: Date;
  /** Score de fiabilite du client, `null` si historique insuffisant. */
  readonly reliabilityScore: number | null;
  readonly reliabilityTier: string;
  readonly confirmationChannel: string;
  readonly whatsappState: string;
  readonly pendingDuplicateFlags: number;
}

export interface ActionInput {
  readonly tenantId: string;
  readonly orderId: string;
  readonly action: ConfirmationAction;
  readonly membershipId: string;
  readonly permissions: ReadonlySet<string>;
  readonly note?: string | null;
  readonly reason?: string | null;
  /** Date du prochain rappel (CALL_BACK / POSTPONE). */
  readonly callbackAt?: Date | null;
  readonly callDurationSeconds?: number | null;
}

export interface ActionResult {
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly attemptNumber: number;
  readonly nextCallbackAt: Date | null;
  /** Vrai si le nombre maximal de tentatives est atteint. */
  readonly maxAttemptsReached: boolean;
}

@Injectable()
export class ConfirmationService {
  private readonly logger = new Logger(ConfirmationService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly workflow: OrderWorkflowService,
    private readonly customerStats: CustomerStatsService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // FILE DE TRAVAIL
  // ==========================================================================

  /**
   * File de confirmation, triee par priorite.
   *
   * Ordre : rappels echus d'abord (un client qui attend un rappel a une heure
   * precise passe avant tout), puis priorite de fiabilite, puis anciennete.
   */
  async getQueue(
    tenantId: string,
    filters: QueueFilters = {},
    options: { page?: number; pageSize?: number } = {},
  ): Promise<Paginated<QueueItem>> {
    const { skip, take } = toSkipTake(options);
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const where = this.buildQueueWhere(tenantId, filters);

    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: [
          // `nulls: 'last'` est essentiel : sans lui, PostgreSQL place les NULL
          // en tete en tri ascendant, et les commandes jamais rappelees
          // passeraient avant les rappels echus.
          { nextCallbackAt: { sort: 'asc', nulls: 'last' } },
          { queuePriority: 'asc' },
          { createdAt: 'asc' },
        ],
        select: queueSelection,
      }),
    ]);

    return {
      data: rows.map(toQueueItem),
      meta: buildPageMeta(page, take, total),
    };
  }

  /**
   * Commande suivante a traiter, avec affectation automatique a l'agent.
   *
   * Le verrou `FOR UPDATE SKIP LOCKED` garantit que deux agents cliquant
   * « suivant » au meme instant ne recoivent jamais la meme commande : le
   * second saute simplement la ligne verrouillee. Sans cela, deux agents
   * appelleraient le meme client — irritant pour lui, et couteux en temps.
   */
  async claimNext(
    tenantId: string,
    membershipId: string,
    filters: QueueFilters = {},
  ): Promise<QueueItem | null> {
    const statuses = filters.status?.length
      ? [...filters.status]
      : [...CONFIRMATION_QUEUE_STATUSES];

    const claimed = await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM orders
        WHERE tenant_id = ${tenantId}::uuid
          AND archived_at IS NULL
          AND status = ANY(${statuses}::"OrderStatus"[])
          AND (next_callback_at IS NULL OR next_callback_at <= NOW())
          AND (assigned_membership_id IS NULL OR assigned_membership_id = ${membershipId}::uuid)
        ORDER BY
          next_callback_at ASC NULLS LAST,
          queue_priority ASC,
          created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      const target = rows[0];
      if (!target) return null;

      await tx.order.update({
        where: { id: target.id },
        data: { assignedMembershipId: membershipId },
      });

      return target.id;
    });

    if (!claimed) return null;

    const order = await this.prisma.order.findFirst({
      where: { tenantId, id: claimed },
      select: queueSelection,
    });

    return order ? toQueueItem(order) : null;
  }

  // ==========================================================================
  // ACTIONS RAPIDES
  // ==========================================================================

  /**
   * Applique une action de confirmation.
   *
   * Tout se passe dans UNE transaction : tentative d'appel, transition de
   * statut, planification du rappel et compteurs client. Un echec a mi-chemin
   * ne laisse jamais une tentative enregistree sans changement de statut, ni
   * l'inverse.
   */
  async applyAction(input: ActionInput): Promise<ActionResult> {
    const mapping = ACTION_MAP[input.action];

    if (mapping.requiresReason && !input.reason?.trim()) {
      throw new ValidationException(
        `Un motif est obligatoire pour l action « ${input.action} ».`,
      );
    }

    const order = await this.prisma.order.findFirst({
      where: { tenantId: input.tenantId, id: input.orderId },
      select: {
        id: true,
        status: true,
        customerId: true,
        callAttemptsCount: true,
        archivedAt: true,
      },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    if (order.archivedAt) {
      throw new ConflictException(
        ERROR_CODES.ORDER_ARCHIVED,
        'Cette commande est archivee.',
      );
    }

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId: input.tenantId },
      select: { maxCallAttempts: true, defaultCallbackDelayHours: true },
    });

    const maxAttempts = settings?.maxCallAttempts ?? 4;
    const defaultDelayHours = settings?.defaultCallbackDelayHours ?? 4;

    const attemptNumber = order.callAttemptsCount + 1;
    const nextCallbackAt = this.resolveCallbackDate(
      input.action,
      input.callbackAt ?? null,
      defaultDelayHours,
    );

    return this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      // --- 1. Trace de la tentative d'appel --------------------------------
      await tx.orderCallAttempt.create({
        data: {
          tenantId: input.tenantId,
          orderId: input.orderId,
          membershipId: input.membershipId,
          attemptNumber,
          outcome: mapping.outcome,
          note: input.note ?? null,
          scheduledCallbackAt: nextCallbackAt,
          durationSeconds: input.callDurationSeconds ?? null,
        },
      });

      // --- 2. Transition de statut ------------------------------------------
      const transition = await this.workflow.transitionWithin(tx, {
        tenantId: input.tenantId,
        orderId: input.orderId,
        to: mapping.status,
        actorKind: 'USER',
        membershipId: input.membershipId,
        permissions: input.permissions,
        reason: input.reason ?? null,
        note: input.note ?? null,
        source: 'confirmation-center',
        metadata: { action: input.action, attemptNumber },
      });

      // --- 3. Compteurs d'appel et rappel ----------------------------------
      await tx.order.update({
        where: { id: input.orderId },
        data: {
          callAttemptsCount: attemptNumber,
          nextCallbackAt,
          confirmationChannel: 'HUMAN_AGENT',
          assignedMembershipId: input.membershipId,
        },
      });

      // --- 4. Client injoignable : le score doit le refleter ---------------
      if (input.action === 'WRONG_NUMBER') {
        await this.customerStats.registerUnreachable(tx, input.tenantId, order.customerId);
      }

      const maxAttemptsReached =
        attemptNumber >= maxAttempts &&
        (['NO_ANSWER', 'CALL_BACK', 'POSTPONE'] as ConfirmationAction[]).includes(input.action);

      if (maxAttemptsReached) {
        // On ne bascule PAS automatiquement en ANNULEE : le cahier des charges
        // n'autorise aucune annulation automatique, et un client peut tres bien
        // repondre a la cinquieme tentative. On signale, l'humain decide.
        this.logger.log(
          `Commande ${input.orderId} : ${attemptNumber} tentatives d appel, ` +
            `seuil de ${maxAttempts} atteint. Signalee pour arbitrage.`,
        );
      }

      return {
        orderId: input.orderId,
        from: transition.from,
        to: transition.to,
        attemptNumber,
        nextCallbackAt,
        maxAttemptsReached,
      };
    });
  }

  /**
   * Corrige le numero de telephone d'une commande signalee « numero incorrect »,
   * puis la reinjecte dans la file.
   */
  async correctPhoneNumber(input: {
    tenantId: string;
    orderId: string;
    membershipId: string;
    permissions: ReadonlySet<string>;
    phoneE164: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      await tx.order.update({
        where: { id: input.orderId },
        data: { phoneSnapshot: input.phoneE164 },
      });

      await this.workflow.transitionWithin(tx, {
        tenantId: input.tenantId,
        orderId: input.orderId,
        to: 'TO_CONFIRM',
        actorKind: 'USER',
        membershipId: input.membershipId,
        permissions: input.permissions,
        note: 'Numero de telephone corrige',
        source: 'confirmation-center',
      });
    });
  }

  /** Statistiques de la file, pour l'en-tete de l'ecran de confirmation. */
  async getQueueStats(tenantId: string): Promise<{
    total: number;
    dueNow: number;
    scheduled: number;
    unassigned: number;
    byStatus: Record<string, number>;
  }> {
    const now = this.clock.now();
    const base: Prisma.OrderWhereInput = {
      tenantId,
      archivedAt: null,
      status: { in: [...CONFIRMATION_QUEUE_STATUSES] },
    };

    const [total, dueNow, unassigned, grouped] = await Promise.all([
      this.prisma.order.count({ where: base }),
      this.prisma.order.count({
        where: { ...base, OR: [{ nextCallbackAt: null }, { nextCallbackAt: { lte: now } }] },
      }),
      this.prisma.order.count({ where: { ...base, assignedMembershipId: null } }),
      this.prisma.order.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of grouped) byStatus[row.status] = row._count._all;

    return { total, dueNow, scheduled: total - dueNow, unassigned, byStatus };
  }

  /**
   * Recalcule la priorite de file de toutes les commandes en attente, a partir
   * du score de fiabilite du client (Addendum §32). Execute par un job.
   */
  async refreshQueuePriorities(tenantId: string): Promise<number> {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        archivedAt: null,
        status: { in: [...CONFIRMATION_QUEUE_STATUSES] },
      },
      select: { id: true, queuePriority: true, customer: { select: { reliabilityTier: true } } },
      take: 5_000,
    });

    let updated = 0;
    for (const order of orders) {
      const weight = reliabilityQueueWeight({
        score: null,
        tier: order.customer.reliabilityTier,
        factors: [],
        recommendedActions: [],
        consideredOutcomes: 0,
      });

      if (weight !== order.queuePriority) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: { queuePriority: weight },
        });
        updated += 1;
      }
    }

    return updated;
  }

  // ==========================================================================

  private buildQueueWhere(tenantId: string, filters: QueueFilters): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {
      tenantId,
      archivedAt: null,
      status: {
        in: filters.status?.length ? [...filters.status] : [...CONFIRMATION_QUEUE_STATUSES],
      },
    };

    if (filters.wilayaCode !== undefined) where.wilayaCodeSnapshot = filters.wilayaCode;
    if (filters.source) where.source = filters.source as Prisma.OrderWhereInput['source'];
    if (filters.assignedMembershipId) where.assignedMembershipId = filters.assignedMembershipId;
    if (filters.unassignedOnly) where.assignedMembershipId = null;

    if (filters.dueOnly) {
      where.OR = [{ nextCallbackAt: null }, { nextCallbackAt: { lte: this.clock.now() } }];
    }

    if (filters.search?.trim()) {
      const term = filters.search.trim();
      where.AND = [
        {
          OR: [
            { reference: { contains: term, mode: 'insensitive' } },
            { customerNameSnapshot: { contains: term, mode: 'insensitive' } },
            { phoneSnapshot: { contains: term } },
          ],
        },
      ];
    }

    return where;
  }

  /**
   * Date du prochain rappel.
   * Une date passee est refusee : elle ferait remonter la commande en tete de
   * file indefiniment, devant des rappels legitimes.
   */
  private resolveCallbackDate(
    action: ConfirmationAction,
    requested: Date | null,
    defaultDelayHours: number,
  ): Date | null {
    if (action !== 'CALL_BACK' && action !== 'POSTPONE') return null;

    if (requested) {
      if (requested.getTime() <= this.clock.timestamp()) {
        throw new ValidationException('La date de rappel doit etre dans le futur.');
      }
      return requested;
    }

    return this.clock.inHours(defaultDelayHours);
  }
}

// ---------------------------------------------------------------------------

const queueSelection = {
  id: true,
  reference: true,
  status: true,
  customerNameSnapshot: true,
  phoneSnapshot: true,
  wilayaCodeSnapshot: true,
  communeSnapshot: true,
  addressSnapshot: true,
  totalCentimes: true,
  deliveryFeeCentimes: true,
  notes: true,
  callAttemptsCount: true,
  nextCallbackAt: true,
  createdAt: true,
  confirmationChannel: true,
  whatsappState: true,
  assignee: { select: { user: { select: { fullName: true } } } },
  customer: { select: { reliabilityScore: true, reliabilityTier: true } },
  items: {
    select: {
      skuSnapshot: true,
      productNameSnapshot: true,
      quantity: true,
      unitPriceCentimes: true,
    },
  },
  _count: { select: { duplicateFlagsAsSubject: { where: { resolution: 'PENDING' as const } } } },
} as const;

type QueueRow = {
  id: string;
  reference: string;
  status: string;
  customerNameSnapshot: string;
  phoneSnapshot: string;
  wilayaCodeSnapshot: number | null;
  communeSnapshot: string | null;
  addressSnapshot: string | null;
  totalCentimes: number;
  deliveryFeeCentimes: number;
  notes: string | null;
  callAttemptsCount: number;
  nextCallbackAt: Date | null;
  createdAt: Date;
  confirmationChannel: string;
  whatsappState: string;
  assignee: { user: { fullName: string } } | null;
  customer: { reliabilityScore: number | null; reliabilityTier: string };
  items: {
    skuSnapshot: string;
    productNameSnapshot: string;
    quantity: number;
    unitPriceCentimes: number;
  }[];
  _count: { duplicateFlagsAsSubject: number };
};

function toQueueItem(row: QueueRow): QueueItem {
  return {
    orderId: row.id,
    reference: row.reference,
    status: row.status,
    customerName: row.customerNameSnapshot,
    phone: row.phoneSnapshot,
    wilayaCode: row.wilayaCodeSnapshot,
    commune: row.communeSnapshot,
    address: row.addressSnapshot,
    totalCentimes: row.totalCentimes,
    deliveryFeeCentimes: row.deliveryFeeCentimes,
    items: row.items.map((item) => ({
      sku: item.skuSnapshot,
      productName: item.productNameSnapshot,
      quantity: item.quantity,
      unitPriceCentimes: item.unitPriceCentimes,
    })),
    notes: row.notes,
    callAttemptsCount: row.callAttemptsCount,
    nextCallbackAt: row.nextCallbackAt,
    assigneeName: row.assignee?.user.fullName ?? null,
    createdAt: row.createdAt,
    reliabilityScore: row.customer.reliabilityScore,
    reliabilityTier: row.customer.reliabilityTier,
    confirmationChannel: row.confirmationChannel,
    whatsappState: row.whatsappState,
    pendingDuplicateFlags: row._count.duplicateFlagsAsSubject,
  };
}
