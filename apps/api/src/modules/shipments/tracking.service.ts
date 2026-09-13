/**
 * Synchronisation du suivi transporteur — V1 §13, V2 §17.
 *
 * DEUX SOURCES D'EVENEMENTS, un seul chemin d'application :
 *   - WEBHOOK, quand le transporteur en publie : temps reel, economique ;
 *   - SONDAGE periodique sinon, pour les transporteurs qui n'en ont pas.
 * Les deux aboutissent a `applyEvents`, ce qui garantit un traitement
 * identique et une seule logique a tester.
 *
 * IDEMPOTENCE (V2 §30)
 *   Chaque evenement porte une empreinte calculee par le connecteur. Un index
 *   UNIQUE `(shipment_id, fingerprint)` rend le rejeu d'un webhook — cas
 *   courant, les transporteurs reessayent — strictement inoffensif.
 *
 * DEUX STATUTS CONSERVES (V2 §17)
 *   `providerStatus` : le libelle brut du transporteur, indispensable au
 *   diagnostic quand un statut inattendu apparait.
 *   `normalizedStatus` : le statut EcomFlow, seul utilise par le metier.
 *   Ecraser le premier par le second rendrait impossible toute investigation.
 *
 * PROPAGATION VERS LA COMMANDE
 *   Un evenement transporteur peut faire avancer la commande (EXPEDIEE ->
 *   EN LIVRAISON -> LIVREE). La transition passe par `OrderWorkflowService`
 *   avec l'acteur `SYSTEM` : les gardes metier et l'historique s'appliquent
 *   exactement comme pour une action humaine.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { OrderStatus, ShipmentStatus } from '@ecomflow/shared';
import { ERROR_CODES } from '@ecomflow/shared';
import { NotFoundException } from '../../common/errors/business.exception';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { EncryptionService } from '../../infra/crypto/encryption.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { isUniqueConstraintError } from '../../infra/prisma/prisma.service';
import { OutboxService, DOMAIN_EVENTS } from '../events/outbox.service';
import { OrderWorkflowService } from '../orders/workflow/order-workflow.service';
import { ReturnsService } from '../returns/returns.service';
import { CarrierRegistry } from './carriers/carrier.registry';
import type { TrackingEvent } from './carriers/carrier-adapter.interface';

/**
 * Statut de colis -> statut de commande a appliquer.
 *
 * `null` signifie « aucun changement cote commande » : un colis pris en charge
 * ou en centre de tri n'a aucune raison de modifier le statut visible par le
 * commercant, qui reste EXPEDIEE.
 */
const ORDER_STATUS_BY_SHIPMENT_STATUS: Record<ShipmentStatus, OrderStatus | null> = {
  DRAFT: null,
  CREATION_PENDING: null,
  CREATED: null,
  PICKED_UP: null,
  IN_TRANSIT: null,
  OUT_FOR_DELIVERY: 'IN_DELIVERY',
  DELIVERED: 'DELIVERED',
  FAILED_ATTEMPT: null,
  RETURNING: null,
  RETURNED: 'RETURNED',
  CANCELLED: null,
  ERROR: null,
};

export interface ApplyEventsResult {
  readonly shipmentId: string;
  readonly newEvents: number;
  readonly duplicateEvents: number;
  readonly shipmentStatus: ShipmentStatus;
  readonly orderTransition: { from: OrderStatus; to: OrderStatus } | null;
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly registry: CarrierRegistry,
    private readonly workflow: OrderWorkflowService,
    private readonly returns: ReturnsService,
    private readonly outbox: OutboxService,
    private readonly encryption: EncryptionService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // SONDAGE
  // ==========================================================================

  /**
   * Interroge le transporteur et applique les nouveaux evenements.
   * Utilise par le job de suivi pour les transporteurs sans webhook.
   */
  async pollShipment(tenantId: string, shipmentId: string): Promise<ApplyEventsResult> {
    const shipment = await this.loadShipment(tenantId, shipmentId);

    if (!shipment.trackingNumber) {
      throw new NotFoundException(
        ERROR_CODES.TRACKING_NOT_AVAILABLE,
        'Ce colis ne possede pas encore de numero de suivi.',
      );
    }

    const adapter = this.registry.get(shipment.carrierCode);
    const credentials = shipment.credentialsEncrypted
      ? this.encryption.decryptJson<Record<string, string>>(
          shipment.credentialsEncrypted,
          tenantId,
        )
      : {};

    const result = await adapter.getTrackingEvents(
      { credentials, config: shipment.config },
      shipment.trackingNumber,
    );

    if (!result.ok) {
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          lastSyncedAt: this.clock.now(),
          errorCode: result.code,
          errorMessage: result.message,
        },
      });

      this.logger.warn(
        `Suivi indisponible pour ${shipment.trackingNumber} (${shipment.carrierCode}) : ` +
          `${result.code} — ${result.message}`,
      );

      return {
        shipmentId,
        newEvents: 0,
        duplicateEvents: 0,
        shipmentStatus: shipment.status,
        orderTransition: null,
      };
    }

    return this.applyEvents(tenantId, shipmentId, result.events, 'polling');
  }

  /**
   * Colis a sonder : ceux en vol, non synchronises depuis un delai donne.
   *
   * L'intervalle s'allonge avec l'anciennete du colis : un colis cree il y a
   * une heure merite un suivi rapproche, un colis en transit depuis huit jours
   * n'a pas besoin d'etre interroge toutes les dix minutes. Cela divise par
   * plusieurs le nombre d'appels sans degrader l'experience.
   */
  async findShipmentsToPoll(limit = 100): Promise<
    readonly { tenantId: string; shipmentId: string; carrierCode: string }[]
  > {
    return RequestContextStore.runUnscoped('BACKGROUND_JOB', async () => {
      const rows = await this.prisma.$queryRaw<
        { tenant_id: string; id: string; code: string }[]
      >`
        SELECT s.tenant_id, s.id, c.code
        FROM shipments s
        JOIN carriers c ON c.id = s.carrier_id
        WHERE s.status IN (
            'CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
            'FAILED_ATTEMPT', 'RETURNING'
          )
          AND s.tracking_number IS NOT NULL
          AND (
            s.last_synced_at IS NULL
            OR s.last_synced_at < NOW() - (
              CASE
                WHEN s.created_at > NOW() - INTERVAL '2 days'  THEN INTERVAL '30 minutes'
                WHEN s.created_at > NOW() - INTERVAL '7 days'  THEN INTERVAL '3 hours'
                ELSE INTERVAL '12 hours'
              END
            )
          )
        ORDER BY s.last_synced_at ASC NULLS FIRST
        LIMIT ${limit}
      `;

      return rows.map((row) => ({
        tenantId: row.tenant_id,
        shipmentId: row.id,
        carrierCode: row.code,
      }));
    });
  }

  // ==========================================================================
  // WEBHOOK
  // ==========================================================================

  /**
   * Traite un webhook transporteur.
   *
   * La signature est verifiee AVANT tout traitement : sans elle, n'importe qui
   * pourrait marquer des commandes comme livrees (V2 §30).
   *
   * @returns `null` si la charge utile ne correspond a aucun colis connu.
   */
  async handleWebhook(
    carrierCode: string,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<ApplyEventsResult | null> {
    const adapter = this.registry.get(carrierCode);

    if (!adapter.parseWebhook) {
      this.logger.warn(`Webhook recu pour ${carrierCode}, qui n en publie pas. Ignore.`);
      return null;
    }

    // Le colis doit etre resolu AVANT la verification de signature, car les
    // identifiants necessaires a celle-ci appartiennent au compte du tenant.
    const preliminary = adapter.parseWebhook(rawBody, headers, { credentials: {}, config: {} });
    if (!preliminary) return null;

    const shipment = await RequestContextStore.runUnscoped('WEBHOOK_DISPATCH', () =>
      this.prisma.shipment.findFirst({
        where: { trackingNumber: preliminary.trackingNumber },
        select: {
          id: true,
          tenantId: true,
          carrierAccount: { select: { credentialsEncrypted: true, config: true } },
        },
      }),
    );

    if (!shipment) {
      this.logger.warn(
        `Webhook ${carrierCode} pour un numero de suivi inconnu : ` +
          `${preliminary.trackingNumber}. Ignore.`,
      );
      return null;
    }

    const credentials = shipment.carrierAccount.credentialsEncrypted
      ? this.encryption.decryptJson<Record<string, string>>(
          shipment.carrierAccount.credentialsEncrypted,
          shipment.tenantId,
        )
      : {};

    const context = {
      credentials,
      config: shipment.carrierAccount.config as Record<string, unknown>,
    };

    if (adapter.verifyWebhookSignature && !adapter.verifyWebhookSignature(rawBody, headers, context)) {
      this.logger.error(
        `SIGNATURE DE WEBHOOK INVALIDE pour ${carrierCode}, colis ` +
          `${preliminary.trackingNumber}. Rejete.`,
      );
      return null;
    }

    const parsed = adapter.parseWebhook(rawBody, headers, context);
    if (!parsed) return null;

    return RequestContextStore.runWithTenant(shipment.tenantId, () =>
      this.applyEvents(shipment.tenantId, shipment.id, parsed.events, `webhook:${carrierCode}`),
    );
  }

  // ==========================================================================
  // APPLICATION DES EVENEMENTS
  // ==========================================================================

  /**
   * Enregistre les evenements et propage le statut a la commande.
   *
   * Les evenements deja connus sont silencieusement ignores : c'est le
   * comportement attendu d'un webhook rejoue.
   */
  async applyEvents(
    tenantId: string,
    shipmentId: string,
    events: readonly TrackingEvent[],
    source: string,
  ): Promise<ApplyEventsResult> {
    const shipment = await this.loadShipment(tenantId, shipmentId);

    let newEvents = 0;
    let duplicateEvents = 0;

    // Traites du plus ancien au plus recent : l'historique reste coherent meme
    // si le transporteur renvoie ses evenements dans le desordre.
    const ordered = [...events].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );

    for (const event of ordered) {
      try {
        await this.prisma.shipmentEvent.create({
          data: {
            tenantId,
            shipmentId,
            providerStatus: event.providerStatus,
            normalizedStatus: event.normalizedStatus,
            description: event.description ?? null,
            location: event.location ?? null,
            occurredAt: event.occurredAt,
            fingerprint: event.fingerprint,
            rawPayload: (event.rawPayload ?? undefined) as object | undefined,
          },
        });
        newEvents += 1;
      } catch (error) {
        // L'index UNIQUE (shipment_id, fingerprint) a joue son role : le
        // webhook a ete rejoue, il n'y a rien a faire.
        if (isUniqueConstraintError(error, 'fingerprint')) {
          duplicateEvents += 1;
          continue;
        }
        throw error;
      }
    }

    if (newEvents === 0) {
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: { lastSyncedAt: this.clock.now() },
      });

      return {
        shipmentId,
        newEvents: 0,
        duplicateEvents,
        shipmentStatus: shipment.status,
        orderTransition: null,
      };
    }

    // Le statut courant est celui de l'evenement le PLUS RECENT, pas du
    // dernier recu : un transporteur peut livrer un evenement en retard.
    const latest = ordered[ordered.length - 1];
    const latestStatus = latest.normalizedStatus;

    let orderTransition: { from: OrderStatus; to: OrderStatus } | null = null;

    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      // L'ENCAISSEMENT VIENT DU DERNIER EVENEMENT QUI EN PORTE UN, pas du
      // dernier evenement tout court : le reversement est souvent annonce
      // AVANT une mise a jour de statut sans rapport, et prendre le dernier
      // evenement effacerait le montant deja connu.
      const collection = [...ordered].reverse().find((event) => event.collection)?.collection;

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: latestStatus,
          normalizedStatus: latestStatus,
          providerStatus: latest.providerStatus,
          lastSyncedAt: this.clock.now(),
          errorCode: null,
          errorMessage: null,
          ...(collection
            ? {
                collectedCentimes: collection.amountCentimes,
                collectedAt: collection.collectedAt,
                remittanceReference: collection.reference ?? null,
              }
            : {}),
        },
      });

      const targetOrderStatus = ORDER_STATUS_BY_SHIPMENT_STATUS[latestStatus];

      if (targetOrderStatus) {
        const order = await tx.order.findFirst({
          where: { tenantId, id: shipment.orderId },
          select: { status: true },
        });

        if (order && order.status !== targetOrderStatus) {
          try {
            const transition = await this.workflow.transitionWithin(tx, {
              tenantId,
              orderId: shipment.orderId,
              to: targetOrderStatus,
              actorKind: 'SYSTEM',
              source: `tracking:${source}`,
              reason:
                targetOrderStatus === 'RETURNED'
                  ? `Retour signale par ${shipment.carrierCode} : ${latest.providerStatus}`
                  : null,
              metadata: {
                shipmentId,
                trackingNumber: shipment.trackingNumber,
                providerStatus: latest.providerStatus,
              },
            });
            orderTransition = { from: transition.from, to: transition.to };

            // UN RETOUR SIGNALE PAR LE TRANSPORTEUR DOIT EXISTER COMME RETOUR.
            //   Jusqu'ici, l'evenement faisait passer la commande en RETOURNEE
            //   et s'arretait la : l'ecran /retours restait vide pendant que la
            //   commande affichait « retournee ». La marchandise revenait
            //   physiquement sans que personne n'ait a decider de son sort —
            //   remise en vente ou quarantaine — parce qu'aucun dossier ne le
            //   demandait.
            //
            //   `createReturn` est idempotent : il rend le retour ouvert
            //   existant plutot que d'en creer un second. Un webhook rejoue,
            //   ou un sondage qui repasse sur le meme evenement, reste donc
            //   inoffensif.
            if (transition.to === 'RETURNED') {
              await this.returns.createReturn(
                {
                  tenantId,
                  orderId: shipment.orderId,
                  shipmentId,
                  // `OTHER` et non un motif precis : le transporteur signale
                  // QU'IL rend le colis, rarement POURQUOI. Choisir
                  // « client absent » ou « client a refuse » a sa place
                  // inventerait une cause, et fausserait la repartition des
                  // motifs de retour — que le commercant lit pour decider quoi
                  // corriger. Le libelle brut du transporteur est conserve, et
                  // un humain affinera au controle.
                  reason: 'OTHER',
                  reasonDetail: `Signale par ${shipment.carrierCode} : ${latest.providerStatus}`,
                  membershipId: null,
                },
                tx,
              );
            }
          } catch (error) {
            // Une transition refusee n'est pas une anomalie : le transporteur
            // peut annoncer « livre » sur une commande deja annulee cote
            // boutique. On journalise et on conserve l'evenement, qui reste
            // visible dans la timeline.
            this.logger.warn(
              `Statut transporteur ${latest.providerStatus} non applique a la commande ` +
                `${shipment.orderId} : ${(error as Error).message}`,
            );
          }
        }
      }

      await this.outbox.publish(tx, {
        tenantId,
        eventType: DOMAIN_EVENTS.TRACKING_UPDATED,
        payload: {
          shipmentId,
          orderId: shipment.orderId,
          trackingNumber: shipment.trackingNumber,
          status: latestStatus,
          providerStatus: latest.providerStatus,
          newEvents,
        },
      });
    });

    this.logger.log(
      `Suivi ${shipment.trackingNumber ?? shipmentId} : ${newEvents} evenement(s), ` +
        `statut ${latestStatus} (source ${source}).`,
    );

    return {
      shipmentId,
      newEvents,
      duplicateEvents,
      shipmentStatus: latestStatus,
      orderTransition,
    };
  }

  // -------------------------------------------------------------------------

  private async loadShipment(tenantId: string, shipmentId: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { tenantId, id: shipmentId },
      select: {
        id: true,
        orderId: true,
        status: true,
        trackingNumber: true,
        carrier: { select: { code: true } },
        carrierAccount: { select: { credentialsEncrypted: true, config: true } },
      },
    });

    if (!shipment) {
      throw new NotFoundException(ERROR_CODES.SHIPMENT_NOT_FOUND, 'Colis introuvable.');
    }

    return {
      id: shipment.id,
      orderId: shipment.orderId,
      status: shipment.status,
      trackingNumber: shipment.trackingNumber,
      carrierCode: shipment.carrier.code,
      credentialsEncrypted: shipment.carrierAccount.credentialsEncrypted,
      config: shipment.carrierAccount.config as Record<string, unknown>,
    };
  }
}
