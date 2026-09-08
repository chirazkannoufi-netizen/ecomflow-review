/**
 * Confirmation semi-automatisee par WhatsApp — Addendum §31.
 *
 * PRINCIPE
 *   Des qu'une commande passe A CONFIRMER, un message WhatsApp recapitulatif
 *   est envoye au client avec trois boutons : Confirmer / Modifier / Annuler.
 *   L'objectif est de retirer de la file d'appel les commandes faciles, pour
 *   que les agents se concentrent sur celles qui exigent une conversation.
 *
 * GARANTIE NON NEGOCIABLE : LE CANAL WHATSAPP N'EST JAMAIS UN POINT DE PERTE.
 *
 *   Quatre situations ramenent la commande a un agent humain :
 *     1. absence de reponse apres le delai configure (2 a 4 h) ;
 *     2. demande de modification par le client ;
 *     3. echec d'envoi (numero sans WhatsApp, quota Meta, panne) ;
 *     4. passerelle non configuree — la commande n'entre alors meme pas dans
 *        le filtre.
 *   Dans TOUS ces cas, la commande revient en file d'appel classique avec son
 *   historique WhatsApp attache. Elle ne disparait jamais.
 *
 * ELIGIBILITE
 *   Le filtre est OPTIONNEL et desactive par defaut. Une boutique l'active
 *   explicitement. Un plafond de montant peut etre defini : au-dela, la
 *   commande part directement chez un agent — on ne confie pas une commande de
 *   50 000 DA a un bouton.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { WhatsappFilterState } from '@prisma/client';
import { formatCentimes, resolveLocale, type Locale } from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { isUniqueConstraintError } from '../../infra/prisma/prisma.service';
import { OutboxService, DOMAIN_EVENTS } from '../events/outbox.service';
import { OrderWorkflowService } from '../orders/workflow/order-workflow.service';
import { WHATSAPP_BUTTON_IDS, WhatsappGateway } from './whatsapp.gateway';

export interface FilterAttemptResult {
  readonly orderId: string;
  readonly state: WhatsappFilterState;
  readonly handedOver: boolean;
  readonly reason: string;
}

@Injectable()
export class WhatsappFilterService {
  private readonly logger = new Logger(WhatsappFilterService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly gateway: WhatsappGateway,
    private readonly workflow: OrderWorkflowService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // DECLENCHEMENT
  // ==========================================================================

  /**
   * Lance le filtre WhatsApp sur une commande a confirmer.
   *
   * Ne leve jamais d'exception : un echec du filtre doit degrader vers l'agent
   * humain, jamais interrompre le flux de commandes.
   */
  async attemptFilter(tenantId: string, orderId: string): Promise<FilterAttemptResult> {
    const eligibility = await this.checkEligibility(tenantId, orderId);

    if (!eligibility.eligible) {
      await this.markNotEligible(tenantId, orderId, eligibility.reason);
      return {
        orderId,
        state: 'NOT_ELIGIBLE',
        handedOver: false,
        reason: eligibility.reason,
      };
    }

    const order = eligibility.order;

    // --- Fil de conversation ------------------------------------------------
    // Contrainte UNIQUE sur `order_id` : un job rejoue ne cree pas deux fils
    // et n'envoie donc pas deux messages au client.
    let threadId: string;
    try {
      const thread = await this.prisma.whatsappThread.create({
        data: {
          tenantId,
          orderId,
          phoneE164: order.phoneSnapshot,
          state: 'PENDING',
          timeoutAt: this.clock.inHours(eligibility.timeoutHours),
        },
        select: { id: true },
      });
      threadId = thread.id;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.whatsappThread.findFirst({
          where: { tenantId, orderId },
          select: { id: true, state: true },
        });
        if (existing) {
          this.logger.debug(`Fil WhatsApp deja ouvert pour la commande ${orderId}.`);
          return {
            orderId,
            state: existing.state,
            handedOver: false,
            reason: 'Fil deja ouvert.',
          };
        }
      }
      throw error;
    }

    // --- Envoi --------------------------------------------------------------
    const result = await this.gateway.sendOrderConfirmation({
      phoneE164: order.phoneSnapshot,
      orderReference: order.reference,
      customerName: order.customerNameSnapshot,
      productSummary: order.items
        .map((item) => item.productNameSnapshot)
        .join(', ')
        .slice(0, 120),
      quantity: order.items.reduce((total, item) => total + item.quantity, 0),
      totalLabel: formatCentimes(order.totalCentimes),
      addressLabel: [order.communeSnapshot, order.addressSnapshot].filter(Boolean).join(', '),
      storeName: eligibility.storeName,
      locale: eligibility.customerLocale,
    });

    if (!result.sent) {
      // Echec d'envoi : bascule immediate vers un agent humain.
      await this.handOver(
        tenantId,
        orderId,
        threadId,
        `Envoi WhatsApp impossible (${result.errorCode ?? 'erreur'}) : ${result.errorMessage ?? ''}`,
        'FAILED',
      );

      return {
        orderId,
        state: 'HANDED_OVER',
        handedOver: true,
        reason: 'Echec d envoi : la commande repart en file d appel.',
      };
    }

    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      await tx.whatsappThread.update({
        where: { id: threadId },
        data: { state: 'SENT' },
      });

      await tx.whatsappMessage.create({
        data: {
          threadId,
          direction: 'OUTBOUND',
          providerMessageId: result.providerMessageId ?? null,
          body: 'Demande de confirmation de commande.',
          status: 'SENT',
          sentAt: this.clock.now(),
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { confirmationChannel: 'WHATSAPP_AUTO', whatsappState: 'SENT' },
      });
    });

    this.logger.log(
      `Demande de confirmation WhatsApp envoyee pour la commande ${order.reference}.`,
    );

    return {
      orderId,
      state: 'SENT',
      handedOver: false,
      reason: 'Message envoye, en attente de reponse du client.',
    };
  }

  // ==========================================================================
  // REPONSES DU CLIENT
  // ==========================================================================

  /**
   * Traite la reponse d'un client a un message de confirmation.
   *
   * @param providerMessageId identifiant du message entrant, cle d'idempotence :
   *        Meta reessaye ses webhooks, un meme appui de bouton peut arriver
   *        plusieurs fois.
   */
  async handleCustomerReply(
    phoneE164: string,
    buttonPayload: string,
    providerMessageId: string,
  ): Promise<FilterAttemptResult | null> {
    const thread = await RequestContextStore.runUnscoped('WEBHOOK_DISPATCH', () =>
      this.prisma.whatsappThread.findFirst({
        where: { phoneE164, state: { in: ['SENT', 'PENDING'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, tenantId: true, orderId: true },
      }),
    );

    if (!thread) {
      this.logger.debug(
        `Reponse WhatsApp recue d un numero sans fil actif : ignoree.`,
      );
      return null;
    }

    return RequestContextStore.runWithTenant(thread.tenantId, async () => {
      // --- Idempotence du message entrant ----------------------------------
      try {
        await this.prisma.whatsappMessage.create({
          data: {
            threadId: thread.id,
            direction: 'INBOUND',
            providerMessageId,
            buttonPayload,
            status: 'RECEIVED',
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          this.logger.debug(`Message WhatsApp ${providerMessageId} deja traite.`);
          return null;
        }
        throw error;
      }

      switch (buttonPayload) {
        case WHATSAPP_BUTTON_IDS.CONFIRM:
          return this.applyCustomerConfirmation(thread.tenantId, thread.orderId, thread.id);

        case WHATSAPP_BUTTON_IDS.CANCEL:
          return this.applyCustomerCancellation(thread.tenantId, thread.orderId, thread.id);

        case WHATSAPP_BUTTON_IDS.MODIFY:
          // Une demande de modification exige une conversation : c'est
          // precisement le cas ou un humain apporte de la valeur.
          await this.handOver(
            thread.tenantId,
            thread.orderId,
            thread.id,
            'Le client souhaite modifier sa commande.',
            'MODIFICATION_REQUESTED',
          );
          return {
            orderId: thread.orderId,
            state: 'HANDED_OVER',
            handedOver: true,
            reason: 'Demande de modification : transfert a un agent.',
          };

        default:
          // Reponse libre : on ne tente pas d'interpreter du texte, on
          // transfere. Deviner l'intention d'un client sur une commande
          // reelle serait imprudent.
          await this.handOver(
            thread.tenantId,
            thread.orderId,
            thread.id,
            `Reponse non structuree du client : « ${buttonPayload.slice(0, 100)} »`,
            'HANDED_OVER',
          );
          return {
            orderId: thread.orderId,
            state: 'HANDED_OVER',
            handedOver: true,
            reason: 'Reponse libre : transfert a un agent.',
          };
      }
    });
  }

  private async applyCustomerConfirmation(
    tenantId: string,
    orderId: string,
    threadId: string,
  ): Promise<FilterAttemptResult> {
    try {
      await this.prisma.$transaction(async (rawTx) => {
        const tx = rawTx as PrismaTransactionClient;

        await this.workflow.transitionWithin(tx, {
          tenantId,
          orderId,
          to: 'CONFIRMED',
          actorKind: 'SYSTEM',
          source: 'whatsapp-filter',
          note: 'Confirmee par le client via WhatsApp.',
          metadata: { channel: 'WHATSAPP_AUTO' },
        });

        await tx.whatsappThread.update({
          where: { id: threadId },
          data: { state: 'CONFIRMED', timeoutAt: null },
        });

        await tx.order.update({
          where: { id: orderId },
          data: { whatsappState: 'CONFIRMED', confirmationChannel: 'WHATSAPP_AUTO' },
        });
      });

      this.logger.log(`Commande ${orderId} confirmee par le client via WhatsApp.`);

      return {
        orderId,
        state: 'CONFIRMED',
        handedOver: false,
        reason: 'Commande confirmee par le client.',
      };
    } catch (error) {
      // La confirmation automatique peut echouer sur une garde metier :
      // stock insuffisant, abonnement expire. Ce n'est PAS une perte de
      // commande — elle repart vers un agent qui verra le motif exact.
      const message = (error as Error).message;
      this.logger.warn(
        `Confirmation WhatsApp refusee pour la commande ${orderId} : ${message}. ` +
          'Transfert a un agent humain.',
      );

      await this.handOver(
        tenantId,
        orderId,
        threadId,
        `Confirmation automatique impossible : ${message}`,
        'HANDED_OVER',
      );

      return {
        orderId,
        state: 'HANDED_OVER',
        handedOver: true,
        reason: `Confirmation automatique refusee : ${message}`,
      };
    }
  }

  private async applyCustomerCancellation(
    tenantId: string,
    orderId: string,
    threadId: string,
  ): Promise<FilterAttemptResult> {
    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      await this.workflow.transitionWithin(tx, {
        tenantId,
        orderId,
        to: 'CANCELLED',
        actorKind: 'SYSTEM',
        source: 'whatsapp-filter',
        reason: 'Refus client (annulation via WhatsApp)',
        metadata: { channel: 'WHATSAPP_AUTO' },
      });

      await tx.whatsappThread.update({
        where: { id: threadId },
        data: { state: 'CANCELLED_BY_CUSTOMER', timeoutAt: null },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { whatsappState: 'CANCELLED_BY_CUSTOMER', confirmationChannel: 'WHATSAPP_AUTO' },
      });
    });

    return {
      orderId,
      state: 'CANCELLED_BY_CUSTOMER',
      handedOver: false,
      reason: 'Commande annulee par le client.',
    };
  }

  // ==========================================================================
  // EXPIRATION
  // ==========================================================================

  /**
   * Ramene en file d'appel humaine les commandes restees sans reponse.
   * Execute par un job periodique.
   */
  async processTimeouts(limit = 200): Promise<{ handedOver: number }> {
    const expired = await RequestContextStore.runUnscoped('BACKGROUND_JOB', () =>
      this.prisma.whatsappThread.findMany({
        where: {
          state: { in: ['PENDING', 'SENT'] },
          timeoutAt: { lte: this.clock.now() },
        },
        select: { id: true, tenantId: true, orderId: true },
        take: limit,
      }),
    );

    let handedOver = 0;

    for (const thread of expired) {
      try {
        await RequestContextStore.runWithTenant(thread.tenantId, () =>
          this.handOver(
            thread.tenantId,
            thread.orderId,
            thread.id,
            'Aucune reponse du client dans le delai imparti.',
            'NO_RESPONSE',
          ),
        );
        handedOver += 1;
      } catch (error) {
        // Un echec sur un fil ne doit pas empecher de traiter les autres.
        this.logger.error(
          `Transfert du fil WhatsApp ${thread.id} impossible : ${(error as Error).message}`,
        );
      }
    }

    if (handedOver > 0) {
      this.logger.log(
        `${handedOver} commande(s) sans reponse WhatsApp ramenee(s) en file d appel.`,
      );
    }

    return { handedOver };
  }

  // ==========================================================================
  // TRANSFERT VERS UN AGENT
  // ==========================================================================

  /**
   * Rend la commande a la file d'appel humaine.
   *
   * L'HISTORIQUE WHATSAPP EST CONSERVE : l'agent voit ce qui a ete tente, ce
   * que le client a repondu et pourquoi le transfert a eu lieu. C'est ce qui
   * distingue un transfert d'une perte (Addendum §31).
   */
  private async handOver(
    tenantId: string,
    orderId: string,
    threadId: string,
    reason: string,
    finalState: WhatsappFilterState,
  ): Promise<void> {
    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      await tx.whatsappThread.update({
        where: { id: threadId },
        data: {
          state: finalState === 'HANDED_OVER' ? 'HANDED_OVER' : finalState,
          handedOverAt: this.clock.now(),
          handoverReason: reason.slice(0, 500),
          timeoutAt: null,
        },
      });

      const order = await tx.order.findFirst({
        where: { tenantId, id: orderId },
        select: { status: true },
      });

      // La commande repasse en file d'appel si elle n'a pas deja avance.
      if (order && ['TO_CONFIRM', 'NO_ANSWER', 'CALL_BACK', 'POSTPONED'].includes(order.status)) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            confirmationChannel: 'HUMAN_AGENT',
            whatsappState: finalState,
            // Priorite haute : une commande passee par WhatsApp sans succes a
            // deja perdu plusieurs heures. Elle ne doit pas repartir en fin
            // de file.
            queuePriority: 0,
          },
        });
      }

      await this.outbox.publish(tx, {
        tenantId,
        eventType: DOMAIN_EVENTS.WHATSAPP_HANDOVER,
        payload: { orderId, threadId, reason, finalState },
      });
    });

    this.logger.log(`Commande ${orderId} rendue a un agent humain : ${reason}`);
  }

  // ==========================================================================
  // ELIGIBILITE
  // ==========================================================================

  private async checkEligibility(
    tenantId: string,
    orderId: string,
  ): Promise<
    | { eligible: false; reason: string }
    | {
        eligible: true;
        reason: string;
        timeoutHours: number;
        storeName: string;
        /** Langue dans laquelle ECRIRE AU CLIENT (Addendum §31). */
        customerLocale: Locale;
        order: {
          reference: string;
          phoneSnapshot: string;
          customerNameSnapshot: string;
          communeSnapshot: string | null;
          addressSnapshot: string | null;
          totalCentimes: number;
          items: { productNameSnapshot: string; quantity: number }[];
        };
      }
  > {
    if (!this.gateway.isConfigured()) {
      return {
        eligible: false,
        reason: 'Passerelle WhatsApp non configuree sur cette installation.',
      };
    }

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: {
        whatsappFilterEnabled: true,
        whatsappTimeoutHours: true,
        whatsappMaxAmountCentimes: true,
        // `null` = ecrire a chaque client dans SA langue. Renseigne = la
        // boutique impose une langue unique a toute sa clientele.
        customerMessageLocale: true,
        defaultLocale: true,
        tenant: { select: { name: true } },
      },
    });

    if (!settings?.whatsappFilterEnabled) {
      return { eligible: false, reason: 'Filtre WhatsApp desactive pour cette boutique.' };
    }

    const order = await this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: {
        reference: true,
        status: true,
        phoneSnapshot: true,
        customerNameSnapshot: true,
        communeSnapshot: true,
        addressSnapshot: true,
        totalCentimes: true,
        whatsappState: true,
        items: { select: { productNameSnapshot: true, quantity: true } },
        customer: { select: { reliabilityTier: true, locale: true } },
      },
    });

    if (!order) {
      return { eligible: false, reason: 'Commande introuvable.' };
    }

    if (order.status !== 'TO_CONFIRM') {
      return {
        eligible: false,
        reason: `Le filtre ne s applique qu aux commandes A CONFIRMER (statut : ${order.status}).`,
      };
    }

    if (order.whatsappState !== 'NOT_ELIGIBLE' && order.whatsappState !== 'PENDING') {
      return { eligible: false, reason: 'Le filtre WhatsApp a deja ete applique.' };
    }

    // Un numero fixe ne recevra pas de message WhatsApp : inutile d'essayer.
    if (!/^\+2136|^\+2135|^\+2137/.test(order.phoneSnapshot)) {
      return {
        eligible: false,
        reason: 'Numero non mobile : WhatsApp inapplicable.',
      };
    }

    // Plafond de montant : une commande importante merite un vrai appel.
    if (
      settings.whatsappMaxAmountCentimes !== null &&
      order.totalCentimes > settings.whatsappMaxAmountCentimes
    ) {
      return {
        eligible: false,
        reason:
          `Montant superieur au plafond du filtre automatique ` +
          `(${formatCentimes(settings.whatsappMaxAmountCentimes)}).`,
      };
    }

    return {
      eligible: true,
      reason: 'Commande eligible au filtre WhatsApp.',
      timeoutHours: settings.whatsappTimeoutHours,
      storeName: settings.tenant.name,
      // Ordre de priorite : langue imposee par la boutique, sinon langue
      // connue du client, sinon langue par defaut de la boutique. Le reglage
      // de la boutique passe AVANT celle du client parce qu'il traduit une
      // decision commerciale explicite (« notre boutique ecrit en arabe »),
      // alors que la langue du client peut n'etre qu'une observation.
      customerLocale: resolveLocale(
        settings.customerMessageLocale,
        order.customer?.locale,
        settings.defaultLocale,
      ),
      order,
    };
  }

  private async markNotEligible(
    tenantId: string,
    orderId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.order.updateMany({
      where: { tenantId, id: orderId },
      data: { whatsappState: 'NOT_ELIGIBLE', confirmationChannel: 'HUMAN_AGENT' },
    });
    this.logger.debug(`Commande ${orderId} hors filtre WhatsApp : ${reason}`);
  }

  // ==========================================================================
  // LECTURE
  // ==========================================================================

  /** Historique WhatsApp d'une commande, affiche dans la fiche de confirmation. */
  async getThread(tenantId: string, orderId: string) {
    return this.prisma.whatsappThread.findFirst({
      where: { tenantId, orderId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** Statistiques d'adoption du filtre (Addendum §31). */
  async getAdoptionStats(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<{
    total: number;
    byChannel: Record<string, number>;
    byWhatsappState: Record<string, number>;
    autoConfirmationRate: number;
  }> {
    const [byChannel, byState, total] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['confirmationChannel'],
        where: { tenantId, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['whatsappState'],
        where: { tenantId, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      this.prisma.order.count({ where: { tenantId, createdAt: { gte: from, lte: to } } }),
    ]);

    const channels: Record<string, number> = {};
    for (const row of byChannel) channels[row.confirmationChannel] = row._count._all;

    const states: Record<string, number> = {};
    for (const row of byState) states[row.whatsappState] = row._count._all;

    const sent = (states.SENT ?? 0) + (states.CONFIRMED ?? 0) + (states.HANDED_OVER ?? 0) +
      (states.NO_RESPONSE ?? 0) + (states.CANCELLED_BY_CUSTOMER ?? 0) +
      (states.MODIFICATION_REQUESTED ?? 0);

    return {
      total,
      byChannel: channels,
      byWhatsappState: states,
      // Taux de confirmation automatique : la mesure qui dit si le filtre
      // allege reellement la charge du centre d'appel.
      autoConfirmationRate: sent === 0 ? 0 : ((states.CONFIRMED ?? 0) / sent) * 100,
    };
  }
}
