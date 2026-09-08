/**
 * Abonnements et paiements — V1 §21/§22, V2 §7/§8, Addendum §35.
 *
 * REGLE ABSOLUE : SEUL UN PAIEMENT VERIFIE ACTIVE UN ABONNEMENT.
 *
 *   Trois chemins mènent a l'activation, et un seul point d'entree la realise
 *   (`settlePayment`) :
 *     1. WEBHOOK CHARGILY signe et verifie cote serveur ;
 *     2. VALIDATION MANUELLE par un Super Admin, apres examen du justificatif ;
 *     3. ACTIVATION ADMINISTRATIVE explicite (geste commercial, tracee).
 *
 *   Le retour du navigateur sur l'URL de succes n'active RIEN. Une capture
 *   d'ecran n'active RIEN — les deux cahiers des charges le disent
 *   explicitement (V1 §21, V2 §8). Un justificatif televerse cree un paiement
 *   « en attente de verification », jamais un abonnement actif.
 *
 * PROLONGATION PLUTOT QUE REMPLACEMENT
 *   Payer avant la fin d'une periode en cours AJOUTE la nouvelle periode a la
 *   suite, au lieu de l'ecraser. Un commercant prevoyant ne doit jamais perdre
 *   les jours qu'il a deja payes.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { PaymentStatus } from '@prisma/client';
import {
  BILLING_PERIOD_MONTHS,
  ERROR_CODES,
  deriveSubscriptionState,
} from '@ecomflow/shared';
import { HttpStatus } from '@nestjs/common';
import {
  BusinessException,
  ConflictException,
  NotFoundException,
  ValidationException,
} from '../../common/errors/business.exception';
import { AppConfigService } from '../../config/configuration';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { isUniqueConstraintError } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService, DOMAIN_EVENTS } from '../events/outbox.service';
import { ChargilyGateway } from './chargily.gateway';
import { SubscriptionStateService } from './subscription-state.service';

export interface StartCheckoutInput {
  readonly tenantId: string;
  readonly planId: string;
  readonly membershipId: string;
  readonly customerEmail?: string | null;
  readonly customerName?: string | null;
}

export interface StartCheckoutResult {
  readonly paymentId: string;
  readonly checkoutUrl: string;
  readonly amountCentimes: number;
}

export interface SubmitManualPaymentInput {
  readonly tenantId: string;
  readonly planId: string;
  readonly membershipId: string;
  readonly provider: 'MANUAL_TRANSFER' | 'MANUAL_BARIDIMOB';
  /** URL du justificatif televerse (recu de virement, capture BaridiMob). */
  readonly proofUrl: string;
  readonly note?: string | null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly chargily: ChargilyGateway,
    private readonly subscriptionState: SubscriptionStateService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // CONSULTATION
  // ==========================================================================

  /** Plans publics, avec leurs limites et fonctionnalites. */
  async listPlans() {
    return RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.plan.findMany({
        where: { isActive: true, isPublic: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          priceCentimes: true,
          billingPeriod: true,
          limits: true,
          features: true,
        },
      }),
    );
  }

  /** Etat d'abonnement de la boutique, tel qu'affiche dans le bandeau. */
  async getSubscription(tenantId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: {
        plan: {
          select: { id: true, code: true, name: true, priceCentimes: true, billingPeriod: true },
        },
      },
    });

    if (!subscription) {
      throw new NotFoundException(
        ERROR_CODES.NOT_FOUND,
        'Aucun abonnement associe a cette boutique.',
      );
    }

    const state = await this.subscriptionState.getState(tenantId);

    return {
      status: state.status,
      operational: state.operational,
      reason: state.reason,
      trialDaysRemaining: state.trialDaysRemaining,
      periodDaysRemaining: state.periodDaysRemaining,
      trialStartAt: subscription.trialStartAt,
      trialEndAt: subscription.trialEndAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelledAt: subscription.cancelledAt,
      plan: subscription.plan,
      paymentMethodsAvailable: {
        card: this.chargily.isConfigured(),
        manualTransfer: true,
        baridimob: true,
      },
    };
  }

  /** Historique des paiements de la boutique. */
  async listPayments(tenantId: string, limit = 50) {
    return this.prisma.payment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        provider: true,
        status: true,
        amountCentimes: true,
        currency: true,
        checkoutUrl: true,
        proofUrl: true,
        reviewNote: true,
        paidAt: true,
        createdAt: true,
      },
    });
  }

  // ==========================================================================
  // PAIEMENT PAR CARTE (Chargily)
  // ==========================================================================

  async startCheckout(input: StartCheckoutInput): Promise<StartCheckoutResult> {
    const plan = await this.loadPlan(input.planId);

    if (!this.chargily.isConfigured()) {
      throw new BusinessException(
        ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
        'Le paiement par carte n est pas disponible sur cette installation. ' +
          'Utilisez le virement bancaire ou BaridiMob.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Le paiement est cree AVANT l'appel a Chargily : son identifiant part
    // dans les metadonnees et revient par le webhook. Sans cette anteriorite,
    // un webhook pourrait arriver avant que nous sachions a quoi le rattacher.
    const payment = await this.prisma.payment.create({
      data: {
        tenantId: input.tenantId,
        planId: plan.id,
        provider: 'CHARGILY',
        status: 'PENDING',
        amountCentimes: plan.priceCentimes,
        currency: 'DZD',
        metadata: { planCode: plan.code, initiatedBy: input.membershipId },
      },
      select: { id: true },
    });

    const appUrl = this.config.app.appUrl;
    const apiUrl = this.config.app.apiUrl;
    const prefix = `${this.config.app.apiPrefix}/${this.config.app.apiVersion}`;

    const checkout = await this.chargily.createCheckout({
      amountCentimes: plan.priceCentimes,
      description: `EcomFlow — abonnement ${plan.name}`,
      paymentId: payment.id,
      tenantId: input.tenantId,
      customerEmail: input.customerEmail ?? null,
      customerName: input.customerName ?? null,
      successUrl: `${appUrl}/abonnement/paiement/succes?payment=${payment.id}`,
      failureUrl: `${appUrl}/abonnement/paiement/echec?payment=${payment.id}`,
      webhookUrl: `${apiUrl}/${prefix}/payments/webhook/chargily`,
    });

    if (!checkout.ok) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', errorMessage: checkout.message, failedAt: this.clock.now() },
      });

      throw new BusinessException(
        ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
        checkout.message,
        checkout.retryable ? HttpStatus.BAD_GATEWAY : HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'PROCESSING',
        externalPaymentId: checkout.checkoutId,
        checkoutUrl: checkout.checkoutUrl,
      },
    });

    await this.audit.record({
      action: 'PAYMENT_SUBMITTED',
      entityType: 'Payment',
      entityId: payment.id,
      tenantId: input.tenantId,
      metadata: { provider: 'CHARGILY', planCode: plan.code, amount: plan.priceCentimes },
    });

    return {
      paymentId: payment.id,
      checkoutUrl: checkout.checkoutUrl,
      amountCentimes: plan.priceCentimes,
    };
  }

  /**
   * Traite un webhook Chargily.
   *
   * Ordre des controles, non negociable :
   *   1. signature ;
   *   2. deduplication de l'evenement ;
   *   3. rattachement au paiement ;
   *   4. activation.
   *
   * @returns `true` si l'evenement a ete traite, `false` s'il a ete rejete ou
   *          ignore. La reponse HTTP reste 200 dans les deux cas : renvoyer une
   *          erreur ferait rejouer indefiniment un webhook inexploitable.
   */
  async handleChargilyWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ handled: boolean; reason?: string }> {
    if (!this.chargily.verifyWebhookSignature(rawBody, signature)) {
      this.logger.error('SIGNATURE DE WEBHOOK CHARGILY INVALIDE : evenement rejete.');
      await this.recordWebhook('CHARGILY', hashBody(rawBody), null, false, 401, 'Signature invalide');
      return { handled: false, reason: 'SIGNATURE_INVALID' };
    }

    const event = this.chargily.parseWebhook(rawBody);
    if (!event) {
      await this.recordWebhook('CHARGILY', hashBody(rawBody), null, true, 400, 'Charge utile illisible');
      return { handled: false, reason: 'UNPARSEABLE' };
    }

    // --- Deduplication ------------------------------------------------------
    // La table est GLOBALE et l'insertion sert de verrou : un webhook rejoue
    // echoue sur la contrainte UNIQUE et s'arrete ici.
    const firstTime = await this.recordWebhook(
      'CHARGILY',
      event.eventId,
      event.tenantId,
      true,
      200,
      null,
    );

    if (!firstTime) {
      this.logger.debug(`Webhook Chargily ${event.eventId} deja traite : ignore.`);
      return { handled: true, reason: 'ALREADY_PROCESSED' };
    }

    if (!event.paymentId) {
      this.logger.warn(`Webhook Chargily ${event.eventId} sans identifiant de paiement.`);
      return { handled: false, reason: 'MISSING_PAYMENT_ID' };
    }

    const payment = await RequestContextStore.runUnscoped('WEBHOOK_DISPATCH', () =>
      this.prisma.payment.findUnique({
        where: { id: event.paymentId as string },
        select: { id: true, tenantId: true, status: true, planId: true, amountCentimes: true },
      }),
    );

    if (!payment) {
      this.logger.warn(`Webhook Chargily pour un paiement inconnu : ${event.paymentId}.`);
      return { handled: false, reason: 'PAYMENT_NOT_FOUND' };
    }

    // Le montant annonce doit correspondre : une divergence signale soit une
    // erreur de configuration, soit une manipulation.
    if (event.amountCentimes !== payment.amountCentimes) {
      this.logger.error(
        `Montant incoherent sur le paiement ${payment.id} : ` +
          `attendu ${payment.amountCentimes}, recu ${event.amountCentimes}. Rejete.`,
      );
      return { handled: false, reason: 'AMOUNT_MISMATCH' };
    }

    if (event.status === 'paid') {
      await this.settlePayment(payment.tenantId, payment.id, {
        source: 'chargily-webhook',
        externalEventId: event.eventId,
        paidAt: event.paidAt ?? this.clock.now(),
      });
      return { handled: true };
    }

    if (['failed', 'canceled', 'expired'].includes(event.status)) {
      await this.markPaymentFailed(payment.tenantId, payment.id, event.status);
      return { handled: true };
    }

    return { handled: true, reason: 'PENDING' };
  }

  // ==========================================================================
  // PAIEMENT MANUEL (Addendum §35)
  // ==========================================================================

  /**
   * Enregistre un justificatif de paiement manuel.
   *
   * Le paiement passe en `AWAITING_VERIFICATION` — un statut EXPLICITE, comme
   * le demande l'Addendum. L'abonnement n'est PAS active : un Super Admin doit
   * confronter le justificatif au relevé bancaire.
   */
  async submitManualPayment(input: SubmitManualPaymentInput): Promise<{ paymentId: string }> {
    const plan = await this.loadPlan(input.planId);

    if (!input.proofUrl.trim()) {
      throw new ValidationException(
        'Un justificatif de paiement est obligatoire (recu de virement ou capture BaridiMob).',
      );
    }

    const pending = await this.prisma.payment.findFirst({
      where: {
        tenantId: input.tenantId,
        status: 'AWAITING_VERIFICATION',
      },
      select: { id: true },
    });

    if (pending) {
      throw new ConflictException(
        ERROR_CODES.CONFLICT,
        'Un justificatif est deja en attente de verification pour cette boutique.',
        { details: { pendingPaymentId: pending.id } },
      );
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId: input.tenantId,
        planId: plan.id,
        provider: input.provider,
        status: 'AWAITING_VERIFICATION',
        amountCentimes: plan.priceCentimes,
        currency: 'DZD',
        proofUrl: input.proofUrl,
        proofUploadedAt: this.clock.now(),
        metadata: { planCode: plan.code, note: input.note ?? null },
      },
      select: { id: true },
    });

    await this.audit.record({
      action: 'PAYMENT_SUBMITTED',
      entityType: 'Payment',
      entityId: payment.id,
      tenantId: input.tenantId,
      metadata: { provider: input.provider, planCode: plan.code },
    });

    this.logger.log(
      `Justificatif de paiement soumis par la boutique ${input.tenantId} ` +
        `(${input.provider}, plan ${plan.code}). En attente de verification.`,
    );

    return { paymentId: payment.id };
  }

  /** File de verification du Super Admin. */
  async listPaymentsAwaitingReview(limit = 50) {
    return RequestContextStore.runUnscoped('PLATFORM_ADMIN', () =>
      this.prisma.payment.findMany({
        where: { status: 'AWAITING_VERIFICATION' },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: {
          id: true,
          tenantId: true,
          provider: true,
          amountCentimes: true,
          proofUrl: true,
          proofUploadedAt: true,
          createdAt: true,
          metadata: true,
          tenant: { select: { name: true, slug: true } },
        },
      }),
    );
  }

  /** Approbation d'un paiement manuel par le Super Admin. */
  async approveManualPayment(
    paymentId: string,
    reviewerUserId: string,
    note?: string,
  ): Promise<void> {
    const payment = await RequestContextStore.runUnscoped('PLATFORM_ADMIN', () =>
      this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, tenantId: true, status: true },
      }),
    );

    if (!payment) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Paiement introuvable.');
    }

    if (payment.status !== 'AWAITING_VERIFICATION') {
      throw new ConflictException(
        ERROR_CODES.PAYMENT_ALREADY_SETTLED,
        `Ce paiement n est pas en attente de verification (statut : ${payment.status}).`,
      );
    }

    await this.settlePayment(payment.tenantId, payment.id, {
      source: 'manual-review',
      reviewerUserId,
      reviewNote: note ?? null,
      paidAt: this.clock.now(),
    });
  }

  /** Refus d'un paiement manuel. */
  async rejectManualPayment(
    paymentId: string,
    reviewerUserId: string,
    reason: string,
  ): Promise<void> {
    if (!reason.trim()) {
      throw new ValidationException(
        'Un motif est obligatoire pour refuser un paiement : le commercant doit ' +
          'savoir quoi corriger.',
      );
    }

    const payment = await RequestContextStore.runUnscoped('PLATFORM_ADMIN', () =>
      this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, tenantId: true, status: true },
      }),
    );

    if (!payment) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Paiement introuvable.');
    }

    if (payment.status !== 'AWAITING_VERIFICATION') {
      throw new ConflictException(
        ERROR_CODES.PAYMENT_ALREADY_SETTLED,
        'Ce paiement a deja ete traite.',
      );
    }

    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'REJECTED',
          reviewedByUserId: reviewerUserId,
          reviewedAt: this.clock.now(),
          reviewNote: reason.slice(0, 500),
          failedAt: this.clock.now(),
        },
      });

      await this.outbox.publish(tx, {
        tenantId: payment.tenantId,
        eventType: DOMAIN_EVENTS.PAYMENT_REJECTED,
        payload: { paymentId, reason },
      });
    });

    await this.audit.record({
      action: 'PAYMENT_REJECTED',
      entityType: 'Payment',
      entityId: paymentId,
      tenantId: payment.tenantId,
      actorUserId: reviewerUserId,
      metadata: { reason },
    });
  }

  // ==========================================================================
  // ACTIVATION — point d'entree UNIQUE
  // ==========================================================================

  /**
   * Marque un paiement comme regle et active l'abonnement.
   *
   * C'est la SEULE methode qui active un abonnement. Elle est idempotente :
   * un webhook rejoue apres une validation manuelle ne prolonge pas la periode
   * une seconde fois.
   */
  async settlePayment(
    tenantId: string,
    paymentId: string,
    context: {
      source: string;
      externalEventId?: string;
      reviewerUserId?: string;
      reviewNote?: string | null;
      paidAt: Date;
    },
  ): Promise<void> {
    await RequestContextStore.runWithTenant(tenantId, async () => {
      await this.prisma.$transaction(async (rawTx) => {
        const tx = rawTx as PrismaTransactionClient;

        const payment = await tx.payment.findUnique({
          where: { id: paymentId },
          select: { id: true, status: true, planId: true, amountCentimes: true, provider: true },
        });

        if (!payment) {
          throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Paiement introuvable.');
        }

        // Idempotence : un paiement deja regle ne prolonge jamais deux fois.
        if (payment.status === 'PAID') {
          this.logger.debug(`Paiement ${paymentId} deja regle : activation ignoree.`);
          return;
        }

        const plan = payment.planId
          ? await tx.plan.findUnique({
              where: { id: payment.planId },
              select: { id: true, code: true, billingPeriod: true },
            })
          : null;

        if (!plan) {
          throw new BusinessException(
            ERROR_CODES.NOT_FOUND,
            'Le plan associe a ce paiement est introuvable.',
            HttpStatus.CONFLICT,
          );
        }

        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: 'PAID',
            paidAt: context.paidAt,
            lastWebhookEventId: context.externalEventId ?? null,
            reviewedByUserId: context.reviewerUserId ?? null,
            reviewedAt: context.reviewerUserId ? this.clock.now() : null,
            reviewNote: context.reviewNote ?? null,
          },
        });

        const subscription = await tx.subscription.findUnique({
          where: { tenantId },
          select: { id: true, currentPeriodEnd: true, planId: true },
        });

        if (!subscription) {
          throw new BusinessException(
            ERROR_CODES.NOT_FOUND,
            'Aucun abonnement a activer pour cette boutique.',
            HttpStatus.CONFLICT,
          );
        }

        // PROLONGATION : si une periode payee court encore, la nouvelle
        // demarre a sa fin. Payer en avance ne fait jamais perdre de jours.
        const now = this.clock.now();
        const periodStart =
          subscription.currentPeriodEnd && subscription.currentPeriodEnd > now
            ? subscription.currentPeriodEnd
            : now;

        const months = BILLING_PERIOD_MONTHS[plan.billingPeriod];
        const periodEnd = addMonths(periodStart, months);

        await tx.subscription.update({
          where: { tenantId },
          data: {
            planId: plan.id,
            status: 'ACTIVE',
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            pastDueSince: null,
            suspendedAt: null,
            cancelledAt: null,
            lastEvaluatedAt: now,
            remindersSent: [],
          },
        });

        await tx.tenant.update({
          where: { id: tenantId },
          data: { status: 'ACTIVE', suspendedAt: null },
        });

        await this.outbox.publish(tx, {
          tenantId,
          eventType: DOMAIN_EVENTS.SUBSCRIPTION_ACTIVATED,
          payload: {
            paymentId,
            planCode: plan.code,
            periodEnd: periodEnd.toISOString(),
            source: context.source,
          },
        });

        await this.audit.recordInTransaction(tx, {
          action: 'SUBSCRIPTION_ACTIVATED',
          entityType: 'Subscription',
          entityId: subscription.id,
          tenantId,
          actorUserId: context.reviewerUserId ?? null,
          actorKind: context.reviewerUserId ? 'USER' : 'SYSTEM',
          metadata: {
            paymentId,
            provider: payment.provider,
            planCode: plan.code,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            source: context.source,
          },
        });

        this.logger.log(
          `Abonnement active pour la boutique ${tenantId} : plan ${plan.code}, ` +
            `periode jusqu au ${periodEnd.toISOString().slice(0, 10)} (source : ${context.source}).`,
        );
      });
    });

    // Le cache doit tomber immediatement : le commercant vient de payer, il
    // doit retrouver son acces sans attendre.
    this.subscriptionState.invalidate(tenantId);
  }

  private async markPaymentFailed(
    tenantId: string,
    paymentId: string,
    reason: string,
  ): Promise<void> {
    const status: PaymentStatus =
      reason === 'expired' ? 'EXPIRED' : reason === 'canceled' ? 'FAILED' : 'FAILED';

    await RequestContextStore.runWithTenant(tenantId, () =>
      this.prisma.$transaction(async (rawTx) => {
        const tx = rawTx as PrismaTransactionClient;

        await tx.payment.update({
          where: { id: paymentId },
          data: { status, failedAt: this.clock.now(), errorMessage: `Chargily : ${reason}` },
        });

        await this.outbox.publish(tx, {
          tenantId,
          eventType: DOMAIN_EVENTS.PAYMENT_REJECTED,
          payload: { paymentId, reason },
        });
      }),
    );

    this.logger.log(`Paiement ${paymentId} en echec (${reason}).`);
  }

  // ==========================================================================
  // ADMINISTRATION
  // ==========================================================================

  /** Suspend une boutique (impaye persistant, abus avere). */
  async suspendTenant(tenantId: string, reason: string, actorUserId: string): Promise<void> {
    await RequestContextStore.runWithTenant(tenantId, () =>
      this.prisma.$transaction(async (rawTx) => {
        const tx = rawTx as PrismaTransactionClient;
        const now = this.clock.now();

        await tx.subscription.update({
          where: { tenantId },
          data: { status: 'SUSPENDED', suspendedAt: now },
        });

        await tx.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED', suspendedAt: now } });

        await this.outbox.publish(tx, {
          tenantId,
          eventType: DOMAIN_EVENTS.SUBSCRIPTION_SUSPENDED,
          payload: { reason },
        });
      }),
    );

    this.subscriptionState.invalidate(tenantId);

    await this.audit.record({
      action: 'SUBSCRIPTION_SUSPENDED',
      entityType: 'Subscription',
      entityId: tenantId,
      tenantId,
      actorUserId,
      metadata: { reason },
    });
  }

  /** Resiliation demandee par le commercant. */
  async cancelSubscription(tenantId: string, membershipId: string): Promise<{ effectiveAt: Date | null }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { id: true, currentPeriodEnd: true, status: true },
    });

    if (!subscription) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Aucun abonnement a resilier.');
    }

    await this.prisma.subscription.update({
      where: { tenantId },
      data: { cancelledAt: this.clock.now() },
    });

    this.subscriptionState.invalidate(tenantId);

    await this.audit.record({
      action: 'SUBSCRIPTION_CANCELLED',
      entityType: 'Subscription',
      entityId: subscription.id,
      tenantId,
      metadata: { membershipId, effectiveAt: subscription.currentPeriodEnd?.toISOString() ?? null },
    });

    // La resiliation prend effet a la fin de la periode deja payee : le
    // commercant conserve ce qu'il a achete.
    return { effectiveAt: subscription.currentPeriodEnd };
  }

  // ==========================================================================
  // JOBS
  // ==========================================================================

  /**
   * Recalcule les abonnements arrives a echeance et envoie les rappels
   * d'expiration a J-3, J-1 et le jour meme (V1 §21).
   */
  async processExpirations(): Promise<{ evaluated: number; expired: number; reminders: number }> {
    return RequestContextStore.runUnscoped('BACKGROUND_JOB', async () => {
      const now = this.clock.now();
      const horizon = this.clock.addDays(now, 4);

      const subscriptions = await this.prisma.subscription.findMany({
        where: {
          OR: [
            { status: { in: ['TRIAL_ACTIVE', 'TRIAL_ENDING'] }, trialEndAt: { lte: horizon } },
            { status: { in: ['ACTIVE', 'PAST_DUE'] }, currentPeriodEnd: { lte: horizon } },
          ],
        },
        select: {
          id: true,
          tenantId: true,
          status: true,
          trialStartAt: true,
          trialEndAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelledAt: true,
          suspendedAt: true,
          pastDueSince: true,
          remindersSent: true,
        },
        take: 500,
      });

      let expired = 0;
      let reminders = 0;

      for (const subscription of subscriptions) {
        const state = deriveSubscriptionState(subscription, now);

        if (state.status !== subscription.status) {
          await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: state.status, lastEvaluatedAt: now },
          });
          this.subscriptionState.invalidate(subscription.tenantId);

          if (!state.operational) {
            expired += 1;
            await this.prisma.$transaction(async (rawTx) => {
              const tx = rawTx as PrismaTransactionClient;
              await this.outbox.publish(tx, {
                tenantId: subscription.tenantId,
                eventType: DOMAIN_EVENTS.TRIAL_ENDED,
                payload: { status: state.status, reason: state.reason },
              });
            });

            await this.audit.record({
              action: 'TRIAL_EXPIRED',
              entityType: 'Subscription',
              entityId: subscription.id,
              tenantId: subscription.tenantId,
              actorKind: 'SYSTEM',
              metadata: { status: state.status },
            });
          }
        }

        // --- Rappels d'expiration -------------------------------------------
        const daysRemaining = state.trialDaysRemaining ?? state.periodDaysRemaining;
        if (daysRemaining !== null && [3, 1, 0].includes(daysRemaining)) {
          const already = subscription.remindersSent.includes(daysRemaining);
          if (!already) {
            await this.prisma.$transaction(async (rawTx) => {
              const tx = rawTx as PrismaTransactionClient;
              await this.outbox.publish(tx, {
                tenantId: subscription.tenantId,
                eventType: DOMAIN_EVENTS.TRIAL_ENDING,
                payload: { daysRemaining, status: state.status },
              });
              await tx.subscription.update({
                where: { id: subscription.id },
                data: { remindersSent: { push: daysRemaining } },
              });
            });
            reminders += 1;
          }
        }
      }

      if (expired > 0 || reminders > 0) {
        this.logger.log(
          `Abonnements evalues : ${subscriptions.length}, expires : ${expired}, ` +
            `rappels envoyes : ${reminders}.`,
        );
      }

      return { evaluated: subscriptions.length, expired, reminders };
    });
  }

  // -------------------------------------------------------------------------

  private async loadPlan(planId: string) {
    const plan = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.plan.findFirst({
        where: { id: planId, isActive: true },
        select: { id: true, code: true, name: true, priceCentimes: true, billingPeriod: true },
      }),
    );

    if (!plan) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Plan tarifaire introuvable.');
    }

    return plan;
  }

  /**
   * Enregistre un webhook recu.
   * @returns `true` si c'est la premiere reception, `false` si c'est un rejeu.
   */
  private async recordWebhook(
    provider: string,
    eventId: string,
    tenantId: string | null,
    signatureOk: boolean,
    statusCode: number,
    errorMessage: string | null,
  ): Promise<boolean> {
    try {
      await RequestContextStore.runUnscoped('WEBHOOK_DISPATCH', () =>
        this.prisma.processedWebhook.create({
          data: { provider, eventId, tenantId, signatureOk, statusCode, errorMessage },
        }),
      );
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }
}

/**
 * Ajoute des mois a une date en gerant les fins de mois.
 * Le 31 janvier + 1 mois donne le 28 (ou 29) fevrier, et non le 3 mars comme
 * le produirait un simple debordement.
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const targetMonth = result.getUTCMonth() + months;
  const day = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(targetMonth);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();

  result.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return result;
}

function hashBody(body: Buffer): string {
  // Empreinte de secours quand l'evenement n'a pas d'identifiant exploitable :
  // permet malgre tout de dedupliquer un rejeu a l'identique.
  return `raw:${body.length}:${body.subarray(0, 64).toString('base64')}`;
}
