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
  computeOrderTotal,
  getWilayaByCode,
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
import { AuditService } from '../audit/audit.service';
import { CustomerStatsService } from '../customers/customer-stats.service';
import { OrderWorkflowService } from '../orders/workflow/order-workflow.service';

/** Actions rapides du centre de confirmation (V1 §9). */
export type ConfirmationAction =
  | 'CONFIRM'
  | 'CALL_BACK'
  | 'POSTPONE'
  | 'NO_ANSWER'
  | 'CANCEL'
  | 'REFUSED'
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
  // REFUS DU CLIENT — « je ne veux plus de cette commande ».
  //
  //   Distinct de CANCEL, ou c'est la BOUTIQUE qui renonce (rupture, doublon,
  //   erreur de saisie). Les deux sortaient jusqu'ici sous le meme statut
  //   ANNULEE, ce qui rendait indistinguables un client qui fait perdre une
  //   vente et une commande que nous avons nous-memes retiree — alors que
  //   seul le premier doit peser sur le score de fiabilite du client.
  //
  //   Aucun motif exige : le statut dit deja tout. L'annulation, elle, est
  //   une decision interne qui doit se justifier.
  REFUSED: { status: 'REFUSED', outcome: 'REFUSED', requiresReason: false },
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
  /**
   * Restreint aux commandes contenant ce SKU.
   *
   * Filtrer par PRODUIT sert une situation precise et frequente : une rupture
   * de stock, ou un lot defectueux. L'agent doit alors rappeler uniquement les
   * clients concernes, sans parcourir toute la file.
   */
  readonly productSku?: string;
  /**
   * Plage de dates de commande, bornes incluses.
   *
   * Une PLAGE et non un jour unique : le systeme de design propose des
   * raccourcis (« aujourd'hui », « 9 derniers jours », « ce mois ») qui sont
   * tous des intervalles, et une file d'appel se travaille par periode, pas
   * par journee isolee.
   */
  readonly orderedFrom?: Date;
  readonly orderedTo?: Date;
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
  /** Domicile ou bureau (« stopdesk »), convenu pendant l'appel. */
  readonly deliveryType: string;
  readonly totalCentimes: number;
  readonly deliveryFeeCentimes: number;
  /**
   * Lignes de la commande. `id` est expose parce que l'agent peut ajuster les
   * quantites pendant l'appel (`updateItems`) : sans lui, l'ecran ne pourrait
   * designer la ligne a modifier autrement que par un SKU, qui n'est pas une
   * cle (deux lignes peuvent porter le meme SKU a des prix differents).
   */
  readonly items: readonly {
    id: string;
    sku: string;
    productName: string;
    variantLabel: string | null;
    quantity: number;
    unitPriceCentimes: number;
    discountCentimes: number;
    /**
     * Stock DISPONIBLE de la declinaison au moment ou la file est chargee.
     *
     * L'agent au telephone en a besoin avant de dire oui a « mettez-m'en
     * trois » : promettre une quantite que le depot n'a pas se paie plus tard
     * en annulation, et le client l'apprend apres coup.
     */
    availableStock: number | null;
  }[];
  readonly notes: string | null;
  readonly callAttemptsCount: number;
  readonly nextCallbackAt: Date | null;
  readonly assigneeName: string | null;
  readonly createdAt: Date;
  /** Score de fiabilite du client, `null` si historique insuffisant. */
  readonly reliabilityScore: number | null;
  readonly reliabilityTier: string;
  /** Historique du client, affiche a cote du palier : « 6 commandes, 5 livrees, 0 refus ». */
  readonly customerHistory: {
    ordersCount: number;
    deliveredCount: number;
    refusedCount: number;
  };
  /** Provenance de la commande, affichee en tete du tiroir d'edition. */
  readonly source: string;
  /** Tentatives d'appel deja faites, de la plus recente a la plus ancienne. */
  readonly attempts: readonly {
    attemptNumber: number;
    outcome: string;
    note: string | null;
    agentName: string | null;
    createdAt: Date;
  }[];
  readonly confirmationChannel: string;
  readonly whatsappState: string;
  readonly pendingDuplicateFlags: number;
}

/** Montants d'une commande apres recalcul serveur. */
export interface OrderAmountsResult {
  readonly itemsTotalCentimes: number;
  readonly discountCentimes: number;
  readonly deliveryFeeCentimes: number;
  /** Ajustement d'echange (SAV), signe. Voir `Order.exchangeAmountCentimes`. */
  readonly exchangeAmountCentimes: number;
  readonly totalCentimes: number;
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
    private readonly audit: AuditService,
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
        reference: true,
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

      // --- 5. Journal d'audit : QUI a fait QUOI, et QUAND -------------------
      //
      // L'horodatage exact existait deja a deux endroits — `createdAt` de la
      // tentative d'appel et l'historique de statut — mais aucun des deux n'est
      // le JOURNAL D'AUDIT, qui est la table interrogee quand on veut
      // reconstituer l'activite d'un agent, toutes entites confondues.
      //
      // L'action journalisee est l'ISSUE REELLE (`CONFIRM`, `REFUSED`...) et
      // non un generique « statut change » : c'est la distinction qui rend le
      // journal exploitable — savoir qu'une commande a change de statut
      // n'apprend rien, savoir qu'un agent a enregistre trente refus dans
      // l'apres-midi, si.
      //
      // Ecrit DANS la transaction : une issue enregistree sans sa trace, ou
      // l'inverse, rendrait le journal faux plutot qu'incomplet.
      //
      // `@Audited` n'est PAS utilise ici : le decorateur pose une metadonnee
      // que rien ne lit dans cette base de code (aucun intercepteur ne la
      // consomme), il n'ecrit donc aucune ligne.
      await this.audit.recordInTransaction(tx, {
        action: `ORDER_CONFIRMATION_${input.action}`,
        entityType: 'Order',
        entityId: input.orderId,
        tenantId: input.tenantId,
        metadata: {
          source: 'confirmation-center',
          outcome: mapping.outcome,
          from: transition.from,
          to: transition.to,
          attemptNumber,
          reference: order.reference,
          nextCallbackAt: nextCallbackAt ? nextCallbackAt.toISOString() : null,
          reason: input.reason ?? null,
        },
      });

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

  // ==========================================================================
  // MODIFICATION DES LIGNES PENDANT L'APPEL
  // ==========================================================================

  /**
   * Ajuste les quantites d'une commande ENCORE DANS LA FILE de confirmation.
   *
   * POURQUOI CETTE OPERATION VIT ICI, ET PAS DANS LE MODULE COMMANDES
   *   « Finalement, mettez-m'en deux » et « enlevez le bleu » sont des phrases
   *   d'appel telephonique. Jusqu'ici l'agent n'avait qu'un champ de note
   *   libre : il ecrivait la demande en toutes lettres et quelqu'un devait la
   *   ressaisir plus tard, en esperant l'avoir bien lue. Le montant annonce au
   *   client — celui qu'il devra payer au livreur — ne correspondait alors
   *   plus a la commande.
   *
   *   L'operation est volontairement BORNEE A LA FILE plutot qu'offerte comme
   *   une edition generale de commande :
   *
   *   - Aucun statut de la file ne reserve de stock (`STOCK_RESERVED_STATUSES`
   *     commence a CONFIRMEE). Modifier les quantites ici ne touche donc a
   *     AUCUNE reservation : c'est ce qui rend l'operation sure et courte.
   *     La meme modification apres confirmation devrait reserver, liberer et
   *     verifier la disponibilite — un autre probleme, qui merite son propre
   *     endpoint.
   *   - Elle est couverte par `confirmation.manage`, la permission de l'agent
   *     au telephone, et non par une permission d'edition de commande.
   *
   * CE QU'ELLE NE FAIT PAS
   *   Elle n'ajoute pas de ligne : cela suppose de chercher dans le catalogue
   *   et de resoudre un prix, ce qui appartient a l'ecran de commande. On
   *   ajuste ce qui a ete commande ; on ne recompose pas la commande.
   */
  async updateItems(input: {
    tenantId: string;
    orderId: string;
    membershipId: string;
    /** Quantite VOULUE par ligne. Zero retire la ligne. */
    lines: readonly { orderItemId: string; quantity: number }[];
  }): Promise<OrderAmountsResult> {
    return this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId },
        select: {
          id: true,
          status: true,
          deliveryFeeCentimes: true,
          discountCentimes: true,
          exchangeAmountCentimes: true,
          items: {
            select: {
              id: true,
              quantity: true,
              unitPriceCentimes: true,
              discountCentimes: true,
              productNameSnapshot: true,
              skuSnapshot: true,
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.', {
          details: { orderId: input.orderId },
        });
      }

      if (!CONFIRMATION_QUEUE_STATUSES.includes(order.status)) {
        // Une commande deja confirmee a reserve son stock, et une commande
        // expediee est chez le transporteur : dans les deux cas, la corriger
        // depuis cet ecran donnerait un total juste et un stock faux.
        throw new ConflictException(
          ERROR_CODES.ORDER_INVALID_TRANSITION,
          'Cette commande n est plus dans la file de confirmation : ses lignes ne peuvent plus etre modifiees ici.',
          { details: { status: order.status } },
        );
      }

      const byId = new Map(order.items.map((item) => [item.id, item]));
      const wanted = new Map<string, number>();

      for (const line of input.lines) {
        const item = byId.get(line.orderItemId);
        if (!item) {
          throw new ValidationException('Cette ligne n appartient pas a la commande.', {
            details: { orderItemId: line.orderItemId },
          });
        }
        if (!Number.isInteger(line.quantity) || line.quantity < 0) {
          throw new ValidationException('La quantite doit etre un entier positif ou nul.', {
            details: { orderItemId: line.orderItemId, quantity: line.quantity },
          });
        }
        wanted.set(line.orderItemId, line.quantity);
      }

      const kept = order.items.filter((item) => (wanted.get(item.id) ?? item.quantity) > 0);

      if (kept.length === 0) {
        // Meme regle que la garde REQUIRE_AT_LEAST_ONE_ITEM du workflow : une
        // commande vide n'est pas une commande. Si le client ne veut plus
        // rien, l'issue est un REFUS, pas une commande a zero article.
        throw new ValidationException(
          'Une commande doit garder au moins une ligne. Si le client ne veut plus rien, enregistrez un refus.',
          { details: { orderId: input.orderId } },
        );
      }

      const removed = order.items.filter((item) => (wanted.get(item.id) ?? item.quantity) === 0);

      // --- Recalcul, ligne par ligne ---------------------------------------
      const recomputed = kept.map((item) => {
        const quantity = wanted.get(item.id) ?? item.quantity;
        const lineTotal = quantity * item.unitPriceCentimes - item.discountCentimes;

        if (lineTotal < 0) {
          // Une remise fixe posee sur une quantite plus grande peut depasser
          // le montant de la ligne reduite. On refuse plutot que d'inventer
          // une regle de proratisation que personne n'a decidee.
          throw new ValidationException(
            'La remise de cette ligne depasse son nouveau montant. Ajustez la remise depuis la fiche commande.',
            {
              details: {
                orderItemId: item.id,
                quantity,
                unitPriceCentimes: item.unitPriceCentimes,
                discountCentimes: item.discountCentimes,
              },
            },
          );
        }

        return { id: item.id, quantity, lineTotalCentimes: lineTotal, previous: item.quantity };
      });

      const itemsTotal = recomputed.reduce((total, line) => total + line.lineTotalCentimes, 0);
      const total = computeOrderTotal({
        itemsTotalCentimes: itemsTotal,
        discountCentimes: order.discountCentimes,
        deliveryFeeCentimes: order.deliveryFeeCentimes,
        exchangeAmountCentimes: order.exchangeAmountCentimes,
      });

      // --- Ecriture ---------------------------------------------------------
      if (removed.length > 0) {
        await tx.orderItem.deleteMany({ where: { id: { in: removed.map((item) => item.id) } } });
      }

      for (const line of recomputed) {
        if (line.quantity === line.previous) continue;
        await tx.orderItem.update({
          where: { id: line.id },
          data: { quantity: line.quantity, lineTotalCentimes: line.lineTotalCentimes },
        });
      }

      await tx.order.update({
        where: { id: input.orderId },
        data: { itemsTotalCentimes: itemsTotal, totalCentimes: total },
      });

      // Trace atomique : le montant a encaisser vient de changer, et l'on doit
      // pouvoir dire plus tard qui l'a change, quand, et depuis quel ecran.
      await this.audit.recordInTransaction(tx, {
        action: 'ORDER_UPDATED',
        entityType: 'order',
        entityId: input.orderId,
        tenantId: input.tenantId,
        metadata: {
          source: 'confirmation-center',
          removedLines: removed.map((item) => ({
            sku: item.skuSnapshot,
            productName: item.productNameSnapshot,
            quantity: item.quantity,
          })),
          changedLines: recomputed
            .filter((line) => line.quantity !== line.previous)
            .map((line) => ({
              orderItemId: line.id,
              from: line.previous,
              to: line.quantity,
            })),
          itemsTotalCentimes: itemsTotal,
          totalCentimes: total,
        },
      });

      return {
        itemsTotalCentimes: itemsTotal,
        discountCentimes: order.discountCentimes,
        deliveryFeeCentimes: order.deliveryFeeCentimes,
        exchangeAmountCentimes: order.exchangeAmountCentimes,
        totalCentimes: total,
      };
    });
  }

  /**
   * Corrige les coordonnees de livraison pendant l'appel.
   *
   * POURQUOI CES CHAMPS SONT MODIFIABLES ICI
   *   L'appel de confirmation EST le moment ou l'on decouvre que l'adresse est
   *   fausse. « Ce n'est pas Setif, c'est Bordj », « mon nom s'ecrit avec deux
   *   L », « livrez plutot au bureau » : jusqu'ici l'agent notait tout cela
   *   dans la note libre, et le colis partait avec les donnees d'origine.
   *
   *   Les champs modifies sont les SNAPSHOTS de la commande, pas la fiche
   *   client. C'est deliberé : le snapshot est ce qui part chez le
   *   transporteur, et corriger une commande ne doit pas reecrire l'historique
   *   des commandes precedentes du meme client (voir le commentaire du
   *   modele). La fiche client se corrige depuis son propre ecran.
   *
   * BORNEE A LA FILE, comme `updateItems` : une commande deja confiee a un
   * transporteur ne peut plus changer d'adresse ici — le colis est parti avec
   * l'ancienne, et seul le transporteur peut encore la modifier.
   */
  async updateCustomerDetails(input: {
    tenantId: string;
    orderId: string;
    membershipId: string;
    customerName?: string;
    phoneE164?: string;
    wilayaCode?: number;
    commune?: string;
    address?: string;
    deliveryType?: 'HOME' | 'PICKUP_POINT';
  }): Promise<void> {
    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId },
        select: {
          id: true,
          status: true,
          customerNameSnapshot: true,
          phoneSnapshot: true,
          wilayaCodeSnapshot: true,
          communeSnapshot: true,
          addressSnapshot: true,
          deliveryType: true,
        },
      });

      if (!order) {
        throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.', {
          details: { orderId: input.orderId },
        });
      }

      if (!CONFIRMATION_QUEUE_STATUSES.includes(order.status)) {
        throw new ConflictException(
          ERROR_CODES.ORDER_INVALID_TRANSITION,
          'Cette commande n est plus dans la file de confirmation : ses coordonnees ne peuvent plus etre modifiees ici.',
          { details: { status: order.status } },
        );
      }

      if (input.wilayaCode !== undefined && !getWilayaByCode(input.wilayaCode)) {
        throw new ValidationException('Code de wilaya inconnu.', {
          details: { wilayaCode: input.wilayaCode },
        });
      }

      const data: Prisma.OrderUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      /** N'ecrit un champ que s'il change REELLEMENT de valeur. */
      function set<T>(field: string, current: T, next: T | undefined): void {
        if (next === undefined || next === current) return;
        before[field] = current;
        after[field] = next;
        (data as Record<string, unknown>)[field] = next;
      }

      set('customerNameSnapshot', order.customerNameSnapshot, input.customerName);
      set('phoneSnapshot', order.phoneSnapshot, input.phoneE164);
      set('wilayaCodeSnapshot', order.wilayaCodeSnapshot, input.wilayaCode);
      set('communeSnapshot', order.communeSnapshot, input.commune);
      set('addressSnapshot', order.addressSnapshot, input.address);
      set('deliveryType', order.deliveryType, input.deliveryType);

      // Rien n'a change : on n'ecrit pas une ligne d'audit pour un formulaire
      // reenvoye tel quel.
      if (Object.keys(data).length === 0) return;

      await tx.order.update({ where: { id: input.orderId }, data });

      await this.audit.recordInTransaction(tx, {
        action: 'ORDER_UPDATED',
        entityType: 'Order',
        entityId: input.orderId,
        tenantId: input.tenantId,
        metadata: { source: 'confirmation-center', field: 'delivery-details', before, after },
      });
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
    maxCallAttempts: number;
  }> {
    const now = this.clock.now();
    const base: Prisma.OrderWhereInput = {
      tenantId,
      archivedAt: null,
      status: { in: [...CONFIRMATION_QUEUE_STATUSES] },
    };

    const [total, dueNow, unassigned, grouped, settings] = await Promise.all([
      this.prisma.order.count({ where: base }),
      this.prisma.order.count({
        where: { ...base, OR: [{ nextCallbackAt: null }, { nextCallbackAt: { lte: now } }] },
      }),
      this.prisma.order.count({ where: { ...base, assignedMembershipId: null } }),
      this.prisma.order.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      // Le seuil d'abandon est renvoye ICI, et non lu sur `/tenants/settings` :
      // cette route exige `settings.manage`, que l'agent de confirmation n'a
      // pas. Sans cela l'ecran ne saurait pas quand desactiver le bouton
      // « Tentative » et le proposerait indefiniment.
      this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { maxCallAttempts: true },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of grouped) byStatus[row.status] = row._count._all;

    return {
      total,
      dueNow,
      scheduled: total - dueNow,
      unassigned,
      byStatus,
      maxCallAttempts: settings?.maxCallAttempts ?? 3,
    };
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

    if (filters.productSku) {
      // `some` : la commande est retenue des qu'UNE de ses lignes porte ce SKU.
      where.items = { some: { skuSnapshot: filters.productSku } };
    }

    if (filters.orderedFrom || filters.orderedTo) {
      // Bornes etendues aux EXTREMITES DE JOURNEE : l'agent choisit « du 1er
      // au 9 », pas « du 1er 00:00:00 au 9 00:00:00 ». Sans cela, les
      // commandes du dernier jour seraient exclues — le bord le plus
      // recent, donc celui qui compte le plus.
      const range: Prisma.DateTimeFilter = {};
      if (filters.orderedFrom) {
        const start = new Date(filters.orderedFrom);
        start.setHours(0, 0, 0, 0);
        range.gte = start;
      }
      if (filters.orderedTo) {
        const end = new Date(filters.orderedTo);
        end.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() + 1);
        range.lt = end;
      }
      where.orderedAt = range;
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
  deliveryType: true,
  totalCentimes: true,
  deliveryFeeCentimes: true,
  notes: true,
  callAttemptsCount: true,
  nextCallbackAt: true,
  createdAt: true,
  confirmationChannel: true,
  whatsappState: true,
  source: true,
  assignee: { select: { user: { select: { fullName: true } } } },
  customer: {
    select: {
      reliabilityScore: true,
      reliabilityTier: true,
      ordersCount: true,
      deliveredCount: true,
      refusedCount: true,
    },
  },
  items: {
    select: {
      id: true,
      skuSnapshot: true,
      productNameSnapshot: true,
      variantLabelSnapshot: true,
      quantity: true,
      unitPriceCentimes: true,
      discountCentimes: true,
      variant: { select: { level: { select: { onHand: true, reserved: true } } } },
    },
  },
  callAttempts: {
    orderBy: { attemptNumber: 'desc' as const },
    take: 10,
    select: {
      attemptNumber: true,
      outcome: true,
      note: true,
      createdAt: true,
      membership: { select: { user: { select: { fullName: true } } } },
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
  deliveryType: string;
  totalCentimes: number;
  deliveryFeeCentimes: number;
  notes: string | null;
  callAttemptsCount: number;
  nextCallbackAt: Date | null;
  createdAt: Date;
  confirmationChannel: string;
  whatsappState: string;
  source: string;
  assignee: { user: { fullName: string } } | null;
  customer: {
    reliabilityScore: number | null;
    reliabilityTier: string;
    ordersCount: number;
    deliveredCount: number;
    refusedCount: number;
  };
  items: {
    id: string;
    skuSnapshot: string;
    productNameSnapshot: string;
    variantLabelSnapshot: string | null;
    quantity: number;
    unitPriceCentimes: number;
    discountCentimes: number;
    variant: { level: { onHand: number; reserved: number } | null } | null;
  }[];
  callAttempts: {
    attemptNumber: number;
    outcome: string;
    note: string | null;
    createdAt: Date;
    membership: { user: { fullName: string } } | null;
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
    deliveryType: row.deliveryType,
    totalCentimes: row.totalCentimes,
    deliveryFeeCentimes: row.deliveryFeeCentimes,
    items: row.items.map((item) => ({
      id: item.id,
      sku: item.skuSnapshot,
      productName: item.productNameSnapshot,
      variantLabel: item.variantLabelSnapshot,
      quantity: item.quantity,
      unitPriceCentimes: item.unitPriceCentimes,
      discountCentimes: item.discountCentimes,
      // « Disponible » et non « physique » : le stock deja engage sur d'autres
      // commandes n'est plus vendable, meme s'il est encore au depot.
      availableStock: item.variant?.level
        ? item.variant.level.onHand - item.variant.level.reserved
        : null,
    })),
    notes: row.notes,
    callAttemptsCount: row.callAttemptsCount,
    nextCallbackAt: row.nextCallbackAt,
    assigneeName: row.assignee?.user.fullName ?? null,
    createdAt: row.createdAt,
    source: row.source,
    customerHistory: {
      ordersCount: row.customer.ordersCount,
      deliveredCount: row.customer.deliveredCount,
      refusedCount: row.customer.refusedCount,
    },
    attempts: row.callAttempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      note: attempt.note,
      agentName: attempt.membership?.user.fullName ?? null,
      createdAt: attempt.createdAt,
    })),
    reliabilityScore: row.customer.reliabilityScore,
    reliabilityTier: row.customer.reliabilityTier,
    confirmationChannel: row.confirmationChannel,
    whatsappState: row.whatsappState,
    pendingDuplicateFlags: row._count.duplicateFlagsAsSubject,
  };
}
