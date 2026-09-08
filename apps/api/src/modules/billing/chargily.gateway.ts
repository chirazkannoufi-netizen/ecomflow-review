/**
 * Passerelle de paiement Chargily Pay — Addendum §35.
 *
 * POURQUOI CHARGILY
 *   L'Addendum le retient explicitement : passerelle algerienne acceptant les
 *   cartes CIB et Edahabia, avec une API developpeur accessible sans contrat
 *   bancaire direct avec la SATIM. C'est aujourd'hui la voie la plus courte
 *   vers un paiement en ligne reellement fonctionnel pour un editeur SaaS
 *   algerien.
 *
 * ARCHITECTURE IMPOSEE (cahier de mission §33)
 *   EcomFlow -> Chargily -> WEBHOOK -> Backend -> Abonnement
 *
 *   Le retour du navigateur vers l'URL de succes n'est JAMAIS une preuve de
 *   paiement : un utilisateur peut l'ouvrir a la main. Seul le webhook signe,
 *   verifie cote serveur, active un abonnement. Cette passerelle ne fait donc
 *   que deux choses : creer un lien de paiement, et verifier une signature.
 *
 * VERACITE (cahier de mission §5)
 *   Cette passerelle appelle la VRAIE API Chargily v2. Tant que
 *   `CHARGILY_ENABLED=false` ou que la cle secrete manque, `isConfigured()`
 *   retourne `false` : la creation de lien echoue explicitement et seul le
 *   paiement manuel reste disponible. Rien n'est simule.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../config/configuration';

const REQUEST_TIMEOUT_MS = 15_000;

export interface CheckoutRequest {
  /** Montant en centimes de dinar. */
  readonly amountCentimes: number;
  readonly description: string;
  /** Identifiant du paiement EcomFlow, renvoye tel quel par le webhook. */
  readonly paymentId: string;
  readonly tenantId: string;
  readonly customerEmail?: string | null;
  readonly customerName?: string | null;
  readonly successUrl: string;
  readonly failureUrl: string;
  readonly webhookUrl: string;
}

export type CheckoutResult =
  | {
      readonly ok: true;
      readonly checkoutId: string;
      readonly checkoutUrl: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/** Evenement de paiement recu par webhook. */
export interface ChargilyWebhookEvent {
  readonly eventId: string;
  readonly type: string;
  readonly checkoutId: string;
  /** Metadonnee `paymentId` transmise a la creation. */
  readonly paymentId: string | null;
  readonly tenantId: string | null;
  readonly amountCentimes: number;
  readonly status: 'paid' | 'failed' | 'canceled' | 'expired' | 'pending';
  readonly paidAt: Date | null;
}

@Injectable()
export class ChargilyGateway {
  private readonly logger = new Logger(ChargilyGateway.name);

  constructor(private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    const chargily = this.config.chargily;
    return Boolean(chargily.enabled && chargily.secretKey && chargily.webhookSecret);
  }

  /**
   * Cree un lien de paiement.
   *
   * Le montant est envoye en DINARS : Chargily raisonne en unite principale,
   * alors qu'EcomFlow stocke en centimes. La conversion est faite ici, une
   * seule fois, plutot que dispersee dans le code appelant.
   */
  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message:
          'Le paiement par carte n est pas active sur cette installation. ' +
          'Utilisez le paiement par virement ou BaridiMob.',
        retryable: false,
      };
    }

    const amountDinars = Math.round(request.amountCentimes / 100);
    if (amountDinars <= 0) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: 'Le montant a payer doit etre strictement positif.',
        retryable: false,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.config.chargily.baseUrl}/checkouts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.chargily.secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountDinars,
          currency: 'dzd',
          description: request.description.slice(0, 255),
          success_url: request.successUrl,
          failure_url: request.failureUrl,
          webhook_endpoint: request.webhookUrl,
          // Les metadonnees reviennent telles quelles dans le webhook : c'est
          // ce qui permet de rattacher le paiement sans faire confiance a une
          // quelconque donnee fournie par le navigateur.
          metadata: [
            { paymentId: request.paymentId },
            { tenantId: request.tenantId },
          ],
          customer_name: request.customerName ?? undefined,
          customer_email: request.customerEmail ?? undefined,
        }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        checkout_url?: string;
        message?: string;
        errors?: unknown;
      };

      if (!response.ok || !body.id || !body.checkout_url) {
        const message = body.message ?? `Chargily a repondu ${response.status}.`;
        this.logger.warn(`Creation de paiement Chargily refusee : ${message}`);
        return {
          ok: false,
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          message,
          retryable: response.status >= 500 || response.status === 429,
        };
      }

      return { ok: true, checkoutId: body.id, checkoutUrl: body.checkout_url };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      this.logger.warn(
        `Appel Chargily impossible : ${aborted ? 'delai depasse' : (error as Error).message}`,
      );
      return {
        ok: false,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'Le service de paiement est momentanement injoignable. Reessayez.',
        retryable: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Verifie la signature `signature` d'un webhook Chargily.
   *
   * HMAC-SHA-256 du corps BRUT avec le secret de webhook, compare a temps
   * constant. Sans cette verification, n'importe qui pourrait activer un
   * abonnement gratuitement en appelant l'endpoint public — c'est l'attaque la
   * plus evidente contre un SaaS payant.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    const secret = this.config.chargily.webhookSecret;

    if (!secret) {
      this.logger.error(
        'Webhook Chargily recu alors que CHARGILY_WEBHOOK_SECRET n est pas configure : rejete.',
      );
      return false;
    }

    if (!signatureHeader) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(signatureHeader.trim(), 'utf8');

    if (expectedBuffer.length !== providedBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, providedBuffer);
  }

  /**
   * Analyse un webhook.
   *
   * @returns `null` si la charge utile est inexploitable. On ne devine JAMAIS :
   *          un webhook mal forme ne doit pas activer un abonnement.
   */
  parseWebhook(rawBody: Buffer): ChargilyWebhookEvent | null {
    try {
      const payload = JSON.parse(rawBody.toString('utf8')) as {
        id?: string;
        type?: string;
        data?: {
          id?: string;
          amount?: number;
          status?: string;
          metadata?: Record<string, string>[] | Record<string, string>;
          created_at?: number;
        };
      };

      const data = payload.data;
      if (!data?.id || !data.status) return null;

      const metadata = normalizeMetadata(data.metadata);

      return {
        eventId: payload.id ?? data.id,
        type: payload.type ?? 'checkout.updated',
        checkoutId: data.id,
        paymentId: metadata.paymentId ?? null,
        tenantId: metadata.tenantId ?? null,
        // Chargily renvoie des dinars : reconversion en centimes, unite
        // interne unique.
        amountCentimes: Math.round((data.amount ?? 0) * 100),
        status: normalizeStatus(data.status),
        paidAt:
          data.status === 'paid' && data.created_at
            ? new Date(data.created_at * 1000)
            : data.status === 'paid'
              ? new Date()
              : null,
      };
    } catch (error) {
      this.logger.warn(`Webhook Chargily illisible : ${(error as Error).message}`);
      return null;
    }
  }
}

/** Chargily envoie les metadonnees soit en objet, soit en tableau d'objets. */
function normalizeMetadata(
  metadata: Record<string, string>[] | Record<string, string> | undefined,
): Record<string, string> {
  if (!metadata) return {};
  if (Array.isArray(metadata)) {
    return metadata.reduce<Record<string, string>>(
      (accumulator, entry) => ({ ...accumulator, ...entry }),
      {},
    );
  }
  return metadata;
}

function normalizeStatus(status: string): ChargilyWebhookEvent['status'] {
  const normalized = status.toLowerCase();
  if (normalized === 'paid') return 'paid';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'canceled' || normalized === 'cancelled') return 'canceled';
  if (normalized === 'expired') return 'expired';
  return 'pending';
}
