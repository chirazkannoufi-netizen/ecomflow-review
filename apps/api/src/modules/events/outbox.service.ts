/**
 * Boite d'envoi transactionnelle (« transactional outbox »).
 *
 * PROBLEME RESOLU
 *   Une notification envoyee juste apres un changement de statut peut partir
 *   alors que la transaction est finalement annulee : le client recoit
 *   « votre commande est expediee » pour une expedition qui n'a pas eu lieu.
 *   Inversement, un envoi place apres le commit peut etre perdu si le
 *   processus tombe entre les deux.
 *
 * SOLUTION
 *   L'evenement est ecrit dans la MEME transaction que le changement d'etat.
 *   Il est donc valide si et seulement si le changement l'est. Un consommateur
 *   asynchrone le depile ensuite, avec reprise sur erreur.
 *
 * GARANTIE : « au moins une fois ». Les consommateurs doivent donc etre
 * idempotents — ce qui est exige de toute facon par le cahier des charges
 * (V2 §30).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';

/** Evenements metier publies par le domaine. */
export const DOMAIN_EVENTS = {
  ORDER_CREATED: 'order.created',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_DUPLICATE_DETECTED: 'order.duplicate_detected',
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_FAILED: 'shipment.failed',
  TRACKING_UPDATED: 'tracking.updated',
  RETURN_CREATED: 'return.created',
  STOCK_LOW: 'stock.low',
  SYNC_FAILED: 'sync.failed',
  SYNC_RATE_LIMITED: 'sync.rate_limited',
  TRIAL_ENDING: 'trial.ending',
  TRIAL_ENDED: 'trial.ended',
  PAYMENT_SETTLED: 'payment.settled',
  PAYMENT_REJECTED: 'payment.rejected',
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_SUSPENDED: 'subscription.suspended',
  WHATSAPP_HANDOVER: 'whatsapp.handover',
} as const;

export type DomainEventType = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface PublishEventInput {
  readonly tenantId: string | null;
  readonly eventType: DomainEventType | (string & {});
  readonly payload: Record<string, unknown>;
  /** Retarde la publication (rappel d'essai a J-3, par exemple). */
  readonly availableAt?: Date;
}

export interface PendingEvent {
  readonly id: string;
  readonly tenantId: string | null;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/** Au-dela, l'evenement est marque en echec definitif et signale. */
const MAX_ATTEMPTS = 5;

/** Progression du delai de reprise : 1 min, 5 min, 15 min, 1 h, 6 h. */
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly clock: ClockService,
  ) {}

  /**
   * Publie un evenement DANS une transaction en cours.
   *
   * C'est la seule methode a utiliser depuis le domaine : publier hors
   * transaction reintroduirait le probleme que ce mecanisme resout.
   */
  async publish(tx: PrismaTransactionClient, input: PublishEventInput): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        eventType: input.eventType,
        payload: input.payload as object,
        status: 'PENDING',
        availableAt: input.availableAt ?? this.clock.now(),
      },
    });
  }

  /**
   * Reserve un lot d'evenements a traiter.
   *
   * `FOR UPDATE SKIP LOCKED` permet a plusieurs instances de l'API de depiler
   * en parallele sans se marcher dessus ni se bloquer : chaque worker prend
   * les lignes libres et ignore celles deja verrouillees par un autre.
   */
  async claimBatch(limit = 50): Promise<readonly PendingEvent[]> {
    return RequestContextStore.runUnscoped('BACKGROUND_JOB', async () => {
      const rows = await this.prisma.$queryRaw<
        {
          id: string;
          tenant_id: string | null;
          event_type: string;
          payload: Record<string, unknown>;
          attempts: number;
        }[]
      >`
        WITH claimed AS (
          SELECT id
          FROM outbox_events
          WHERE status IN ('PENDING', 'FAILED')
            AND available_at <= NOW()
            AND attempts < ${MAX_ATTEMPTS}
          ORDER BY available_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events e
        SET status = 'PROCESSING', attempts = e.attempts + 1
        FROM claimed
        WHERE e.id = claimed.id
        RETURNING e.id, e.tenant_id, e.event_type, e.payload, e.attempts
      `;

      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts,
      }));
    });
  }

  /** Marque un evenement traite avec succes. */
  async markProcessed(eventId: string): Promise<void> {
    await RequestContextStore.runUnscoped('BACKGROUND_JOB', () =>
      this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: { status: 'PROCESSED', processedAt: this.clock.now(), lastError: null },
      }),
    );
  }

  /**
   * Marque un echec et programme la reprise avec un delai croissant.
   *
   * Au-dela du nombre maximal de tentatives, l'evenement reste en `FAILED`
   * sans nouvelle reprise : il devient visible dans le centre d'incidents
   * plutot que de boucler indefiniment et de masquer le probleme.
   */
  async markFailed(eventId: string, attempts: number, error: string): Promise<void> {
    const exhausted = attempts >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 0;

    await RequestContextStore.runUnscoped('BACKGROUND_JOB', () =>
      this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: {
          status: 'FAILED',
          lastError: error.slice(0, 1_000),
          availableAt: exhausted
            ? new Date(this.clock.timestamp() + 365 * 86_400_000)
            : new Date(this.clock.timestamp() + delay),
        },
      }),
    );

    if (exhausted) {
      this.logger.error(
        `Evenement ${eventId} abandonne apres ${attempts} tentatives : ${error}. ` +
          'Il reste consultable dans le centre d incidents.',
      );
    }
  }

  /** Evenements definitivement en echec, pour le centre d'incidents. */
  async listDeadLetters(tenantId: string | null, limit = 50): Promise<readonly PendingEvent[]> {
    const rows = await RequestContextStore.runUnscoped('BACKGROUND_JOB', () =>
      this.prisma.outboxEvent.findMany({
        where: { status: 'FAILED', attempts: { gte: MAX_ATTEMPTS }, ...(tenantId ? { tenantId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, tenantId: true, eventType: true, payload: true, attempts: true },
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      eventType: row.eventType,
      payload: row.payload as Record<string, unknown>,
      attempts: row.attempts,
    }));
  }

  /** Remet un evenement abandonne en file (action d'administration). */
  async replay(eventId: string): Promise<void> {
    await RequestContextStore.runUnscoped('PLATFORM_ADMIN', () =>
      this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: { status: 'PENDING', attempts: 0, availableAt: this.clock.now(), lastError: null },
      }),
    );
  }

  /** Supprime les evenements traites depuis plus de 30 jours. */
  async purgeProcessed(): Promise<number> {
    const cutoff = this.clock.addDays(this.clock.now(), -30);
    const result = await RequestContextStore.runUnscoped('BACKGROUND_JOB', () =>
      this.prisma.outboxEvent.deleteMany({
        where: { status: 'PROCESSED', processedAt: { lt: cutoff } },
      }),
    );
    return result.count;
  }
}
