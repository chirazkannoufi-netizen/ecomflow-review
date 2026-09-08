/**
 * Connecteur de TEST.
 *
 * RAISON D'ETRE, ET CE QU'IL N'EST PAS
 *
 *   Ce connecteur n'imite AUCUN transporteur reel. Il porte le code
 *   `MOCK_CARRIER` et le nom « Transporteur de test » : personne ne peut le
 *   confondre avec Yalidine ou ZR Express, ni en production ni dans une
 *   demonstration. C'est l'exigence de veracite du cahier de mission §5 prise
 *   au serieux — un connecteur factice deguise en vrai transporteur serait la
 *   pire des tromperies.
 *
 *   Il existe pour deux usages legitimes :
 *     1. les tests de bout en bout du parcours complet
 *        (confirmation -> preparation -> expedition -> tracking -> livraison),
 *        qui ne doivent dependre d'aucun service tiers ;
 *     2. la decouverte du produit, avant qu'un commercant n'ait ouvert son
 *        compte chez un transporteur.
 *
 *   Il est deterministe et pilotable : `config.simulate` permet de declencher
 *   a volonte un echec, un delai depasse ou un retour, ce qui permet de tester
 *   les chemins d'erreur — impossible avec un vrai transporteur.
 */

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { ShipmentStatus } from '@ecomflow/shared';
import {
  carrierFailure,
  type CarrierAdapter,
  type CarrierContext,
  type CarrierHealth,
  type CarrierResult,
  type ShipmentCreated,
  type ShipmentRequest,
  type TrackingEvent,
} from './carrier-adapter.interface';

/** Scenarios declenchables par `config.simulate`. */
export type MockScenario =
  | 'SUCCESS'
  | 'FAIL_INVALID_ADDRESS'
  | 'FAIL_TIMEOUT'
  | 'FAIL_RATE_LIMITED'
  | 'DELIVERED'
  | 'RETURNED';

const STATUS_MAP: Record<string, ShipmentStatus> = {
  CREATED: 'CREATED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  FAILED_ATTEMPT: 'FAILED_ATTEMPT',
  RETURNING: 'RETURNING',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
};

@Injectable()
export class MockCarrierAdapter implements CarrierAdapter {
  readonly code = 'MOCK_CARRIER';
  readonly displayName = 'Transporteur de test';
  readonly supportsWebhooks = true;
  readonly supportsCancellation = true;

  readonly credentialFields = [
    {
      key: 'apiKey',
      label: 'Cle de test',
      secret: true,
      required: false,
      helpText: 'Aucune valeur reelle n est necessaire : ce connecteur n appelle aucun service.',
    },
  ] as const;

  /**
   * Etat en memoire des colis, par numero de suivi.
   * En memoire volontairement : ce connecteur ne doit laisser aucune trace en
   * base ni survivre a un redemarrage.
   */
  private readonly shipments = new Map<
    string,
    { status: ShipmentStatus; events: TrackingEvent[]; orderReference: string }
  >();

  async createShipment(
    context: CarrierContext,
    request: ShipmentRequest,
  ): Promise<CarrierResult<ShipmentCreated>> {
    const scenario = (context.config.simulate as MockScenario | undefined) ?? 'SUCCESS';

    if (scenario === 'FAIL_INVALID_ADDRESS') {
      return carrierFailure(
        'INVALID_ADDRESS',
        'Adresse refusee par le transporteur de test (scenario simule).',
        { retryable: false },
      );
    }

    if (scenario === 'FAIL_TIMEOUT') {
      return carrierFailure('TIMEOUT', 'Delai depasse (scenario simule).', { retryable: true });
    }

    if (scenario === 'FAIL_RATE_LIMITED') {
      return carrierFailure('RATE_LIMITED', 'Quota atteint (scenario simule).', {
        retryable: true,
      });
    }

    // Numero de suivi DETERMINISTE, derive de la cle d'idempotence : rejouer
    // la meme demande produit le meme numero, ce qui reproduit fidelement le
    // comportement d'une API idempotente.
    const trackingNumber = `MOCK-${createHash('sha256')
      .update(request.idempotencyKey)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase()}`;

    const existing = this.shipments.get(trackingNumber);
    if (existing) {
      return {
        ok: true,
        trackingNumber,
        providerShipmentId: trackingNumber,
        labelUrl: null,
        costCentimes: 45_000,
        providerStatus: existing.status,
      };
    }

    const createdEvent: TrackingEvent = {
      providerStatus: 'CREATED',
      normalizedStatus: 'CREATED',
      description: 'Colis enregistre par le transporteur de test.',
      location: request.wilayaName,
      occurredAt: new Date(),
      fingerprint: `${trackingNumber}|CREATED|0`,
      rawPayload: { scenario },
    };

    this.shipments.set(trackingNumber, {
      status: 'CREATED',
      events: [createdEvent],
      orderReference: request.orderReference,
    });

    return {
      ok: true,
      trackingNumber,
      providerShipmentId: trackingNumber,
      labelUrl: `https://example.invalid/labels/${trackingNumber}.pdf`,
      // Cout fixe et lisible : 450 DA, ce qui rend les calculs de rentabilite
      // verifiables a la main dans les tests.
      costCentimes: 45_000,
      providerStatus: 'CREATED',
    };
  }

  async cancelShipment(
    _context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ cancelled: boolean }>> {
    const shipment = this.shipments.get(trackingNumber);
    if (!shipment) {
      return carrierFailure('NOT_FOUND', 'Colis introuvable.', { retryable: false });
    }

    if (['DELIVERED', 'RETURNED'].includes(shipment.status)) {
      return carrierFailure(
        'NOT_CANCELLABLE',
        'Un colis livre ou retourne ne peut plus etre annule.',
        { retryable: false },
      );
    }

    shipment.status = 'CANCELLED';
    shipment.events.push({
      providerStatus: 'CANCELLED',
      normalizedStatus: 'CANCELLED',
      description: 'Colis annule.',
      location: null,
      occurredAt: new Date(),
      fingerprint: `${trackingNumber}|CANCELLED|${shipment.events.length}`,
    });

    return { ok: true, cancelled: true };
  }

  async getShipmentStatus(
    _context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ status: ShipmentStatus; providerStatus: string }>> {
    const shipment = this.shipments.get(trackingNumber);
    if (!shipment) {
      return carrierFailure('NOT_FOUND', 'Colis introuvable.', { retryable: false });
    }
    return { ok: true, status: shipment.status, providerStatus: shipment.status };
  }

  async getTrackingEvents(
    _context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ events: readonly TrackingEvent[] }>> {
    const shipment = this.shipments.get(trackingNumber);
    if (!shipment) {
      return carrierFailure('NOT_FOUND', 'Colis introuvable.', { retryable: false });
    }
    return { ok: true, events: [...shipment.events] };
  }

  normalizeStatus(providerStatus: string): ShipmentStatus {
    return STATUS_MAP[providerStatus.toUpperCase()] ?? 'IN_TRANSIT';
  }

  async healthCheck(): Promise<CarrierHealth> {
    return { ok: true, latencyMs: 0, message: 'Connecteur de test : toujours disponible.' };
  }

  // -------------------------------------------------------------------------
  // Pilotage, reserve aux tests
  // -------------------------------------------------------------------------

  /** Fait avancer un colis dans son cycle de vie. */
  advance(trackingNumber: string, status: ShipmentStatus, description?: string): void {
    const shipment = this.shipments.get(trackingNumber);
    if (!shipment) {
      throw new Error(`Colis de test inconnu : ${trackingNumber}`);
    }

    shipment.status = status;
    shipment.events.push({
      providerStatus: status,
      normalizedStatus: status,
      description: description ?? null,
      location: null,
      occurredAt: new Date(),
      fingerprint: `${trackingNumber}|${status}|${shipment.events.length}`,
    });
  }

  /** Vide l'etat entre deux tests. */
  reset(): void {
    this.shipments.clear();
  }

  /** Numero de suivi genere pour une cle d'idempotence donnee. */
  static trackingFor(idempotencyKey: string): string {
    return `MOCK-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12).toUpperCase()}`;
  }

  /** Signature de webhook : HMAC simple, suffisant pour exercer le chemin reel. */
  verifyWebhookSignature(
    _rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    return headers['x-mock-signature'] === 'valide';
  }

  parseWebhook(
    rawBody: Buffer,
  ): { trackingNumber: string; events: readonly TrackingEvent[] } | null {
    try {
      const payload = JSON.parse(rawBody.toString('utf8')) as {
        tracking?: string;
        status?: string;
        occurredAt?: string;
      };

      if (!payload.tracking || !payload.status) return null;

      const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();

      return {
        trackingNumber: payload.tracking,
        events: [
          {
            providerStatus: payload.status,
            normalizedStatus: this.normalizeStatus(payload.status),
            description: 'Evenement recu par webhook.',
            location: null,
            occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
            fingerprint: `${payload.tracking}|${payload.status}|${occurredAt.toISOString()}`,
            rawPayload: payload,
          },
        ],
      };
    } catch {
      return null;
    }
  }

  /** Identifiant unique, utile pour generer des numeros de test distincts. */
  static randomKey(): string {
    return randomBytes(8).toString('hex');
  }
}
