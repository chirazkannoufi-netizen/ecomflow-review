/**
 * Passerelle WhatsApp Business Cloud API (Meta).
 *
 * Support de l'Addendum §31 (confirmation semi-automatisee) et §36
 * (notifications critiques multicanales).
 *
 * VERACITE DE L'INTEGRATION (prompt produit §5)
 *   Cette passerelle parle au VRAI endpoint Meta (`graph.facebook.com`). Elle
 *   ne simule rien. Tant que `WHATSAPP_ENABLED=false` ou que les identifiants
 *   manquent, `isConfigured()` retourne `false` et tout envoi echoue de facon
 *   explicite. Le filtre de confirmation se replie alors integralement sur la
 *   file d'appel humaine : aucune commande n'est perdue, et rien n'est
 *   presente comme fonctionnel sans l'etre.
 *
 * CONTRAINTE METIER DE WHATSAPP
 *   Un message envoye a un client qui n'a pas ecrit dans les 24 dernieres
 *   heures DOIT utiliser un modele (« template ») approuve par Meta. C'est le
 *   cas de la confirmation de commande, qui est toujours a l'initiative du
 *   commercant. Les noms de modeles sont donc configurables par boutique, car
 *   chaque compte Meta Business approuve les siens.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_LOCALE,
  ERROR_CODES,
  orderConfirmationBody,
  verificationCodeBody,
  whatsappButtonLabels,
  type Locale,
} from '@ecomflow/shared';
import { AppConfigService } from '../../config/configuration';

/** Delai maximal d'un appel a l'API Meta. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface WhatsappSendResult {
  readonly sent: boolean;
  readonly providerMessageId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Vrai si une nouvelle tentative a du sens (panne passagere, quota). */
  readonly retryable: boolean;
}

/** Identifiants de reponse renvoyes par les boutons interactifs. */
export const WHATSAPP_BUTTON_IDS = {
  CONFIRM: 'ecomflow_confirm',
  MODIFY: 'ecomflow_modify',
  CANCEL: 'ecomflow_cancel',
} as const;

export type WhatsappButtonId = (typeof WHATSAPP_BUTTON_IDS)[keyof typeof WHATSAPP_BUTTON_IDS];

export interface OrderConfirmationMessage {
  readonly phoneE164: string;
  readonly orderReference: string;
  readonly customerName: string;
  readonly productSummary: string;
  readonly quantity: number;
  readonly totalLabel: string;
  readonly addressLabel: string;
  readonly storeName: string;
  /**
   * Langue du CLIENT FINAL, pas celle de l'agent.
   *
   * En Algerie, un agent travaille couramment en francais tout en ecrivant a
   * ses clients en arabe. La langue du message a un effet direct sur le taux
   * de confirmation (Addendum §31) : c'est une donnee metier a part entiere,
   * pas un reglage d'affichage.
   */
  readonly locale: Locale;
}

@Injectable()
export class WhatsappGateway {
  private readonly logger = new Logger(WhatsappGateway.name);

  constructor(private readonly config: AppConfigService) {}

  /** La passerelle peut-elle reellement envoyer un message ? */
  isConfigured(): boolean {
    const whatsapp = this.config.whatsapp;
    return Boolean(whatsapp.enabled && whatsapp.phoneNumberId && whatsapp.accessToken);
  }

  /**
   * Envoie la demande de confirmation d'une commande, avec trois boutons
   * interactifs : Confirmer / Modifier / Annuler.
   */
  async sendOrderConfirmation(message: OrderConfirmationMessage): Promise<WhatsappSendResult> {
    // Le texte et les libelles viennent du paquet partage : ce sont des regles
    // metier versionnees et testees, pas de la mise en forme de client HTTP.
    const body = orderConfirmationBody(message.locale, {
      customerName: message.customerName,
      orderReference: message.orderReference,
      storeName: message.storeName,
      productSummary: message.productSummary,
      quantity: message.quantity,
      totalLabel: message.totalLabel,
      addressLabel: message.addressLabel,
    });
    const labels = whatsappButtonLabels(message.locale);

    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.toRecipient(message.phoneE164),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: [
            // Les IDENTIFIANTS de bouton restent stables quelle que soit la
            // langue : c'est eux que le webhook entrant renvoie. Traduire un
            // identifiant casserait le traitement de la reponse du client.
            {
              type: 'reply',
              reply: { id: WHATSAPP_BUTTON_IDS.CONFIRM, title: labels.confirm },
            },
            {
              type: 'reply',
              reply: { id: WHATSAPP_BUTTON_IDS.MODIFY, title: labels.modify },
            },
            {
              type: 'reply',
              reply: { id: WHATSAPP_BUTTON_IDS.CANCEL, title: labels.cancel },
            },
          ],
        },
      },
    });
  }

  /** Message texte simple, utilise dans une fenetre de conversation ouverte. */
  async sendText(phoneE164: string, text: string): Promise<WhatsappSendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.toRecipient(phoneE164),
      type: 'text',
      text: { body: text, preview_url: false },
    });
  }

  /** Code de verification de numero (Addendum §38). */
  async sendVerificationCode(
    phoneE164: string,
    code: string,
    locale: Locale = DEFAULT_LOCALE,
  ): Promise<WhatsappSendResult> {
    return this.sendText(phoneE164, verificationCodeBody(locale, code));
  }

  /**
   * Verifie la signature `X-Hub-Signature-256` d'un webhook Meta.
   *
   * Sans cette verification, n'importe qui pourrait confirmer des commandes en
   * appelant l'endpoint public. La comparaison est a temps constant.
   *
   * @param rawBody corps BRUT de la requete. Utiliser le corps deja parse puis
   *                re-serialise produirait une signature differente.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    const appSecret = this.config.whatsapp.appSecret;
    if (!appSecret) {
      this.logger.error(
        'Webhook WhatsApp recu alors que WHATSAPP_APP_SECRET n est pas configure : rejete.',
      );
      return false;
    }

    if (!signatureHeader?.startsWith('sha256=')) return false;

    const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const provided = signatureHeader.slice('sha256='.length);

    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(provided, 'utf8');
    if (expectedBuffer.length !== providedBuffer.length) return false;

    return timingSafeEqual(expectedBuffer, providedBuffer);
  }

  /** Repond au defi de verification d'abonnement au webhook (GET Meta). */
  verifySubscription(mode: string, token: string): boolean {
    const expected = this.config.whatsapp.webhookVerifyToken;
    if (!expected) return false;
    return mode === 'subscribe' && token === expected;
  }

  // -------------------------------------------------------------------------

  /** Meta attend le numero sans le `+`. */
  private toRecipient(phoneE164: string): string {
    return phoneE164.replace(/^\+/, '');
  }

  private async post(payload: Record<string, unknown>): Promise<WhatsappSendResult> {
    if (!this.isConfigured()) {
      return {
        sent: false,
        errorCode: ERROR_CODES.WHATSAPP_NOT_CONFIGURED,
        errorMessage:
          'La passerelle WhatsApp n est pas configuree pour cette installation.',
        retryable: false,
      };
    }

    const whatsapp = this.config.whatsapp;
    const url = `${whatsapp.baseUrl}/${whatsapp.phoneNumberId}/messages`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${whatsapp.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = (await response.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
        error?: { code?: number; message?: string; error_subcode?: number };
      };

      if (!response.ok) {
        const errorMessage = raw.error?.message ?? `HTTP ${response.status}`;
        this.logger.warn(`Envoi WhatsApp refuse (${response.status}) : ${errorMessage}`);
        return {
          sent: false,
          errorCode: String(raw.error?.code ?? response.status),
          errorMessage,
          // 4xx = probleme de contenu ou de droits : reessayer ne changera rien.
          // 429 et 5xx = passager.
          retryable: response.status === 429 || response.status >= 500,
        };
      }

      return {
        sent: true,
        providerMessageId: raw.messages?.[0]?.id,
        retryable: false,
      };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      const message = aborted ? 'Delai depasse' : (error as Error).message;
      this.logger.warn(`Envoi WhatsApp en echec : ${message}`);
      return {
        sent: false,
        errorCode: ERROR_CODES.WHATSAPP_SEND_FAILED,
        errorMessage: message,
        retryable: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
