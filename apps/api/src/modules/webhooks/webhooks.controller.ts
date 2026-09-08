/**
 * Webhooks entrants — `/webhooks/*` (V2 §28, §30).
 *
 * TROIS REGLES COMMUNES A TOUS LES WEBHOOKS
 *
 *  1. SIGNATURE VERIFIEE AVANT TOUT TRAITEMENT. Ces routes sont publiques par
 *     necessite. Sans verification, n'importe qui pourrait marquer des
 *     commandes comme livrees ou confirmer a la place des clients.
 *
 *  2. CORPS BRUT. La signature porte sur les octets exacts recus : un JSON
 *     re-serialise produirait une empreinte differente. D'ou `rawBody: true`
 *     au demarrage de l'application.
 *
 *  3. REPONSE 200 MEME EN CAS DE REJET. Les fournisseurs rejouent
 *     indefiniment les webhooks non acquittes. Renvoyer une erreur sur une
 *     charge utile inexploitable creerait une boucle sans fin. Le motif du
 *     rejet est journalise et retourne dans le corps.
 */

import { Controller, Get, HttpCode, HttpStatus, Post, Param, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Logger } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { TrackingService } from '../shipments/tracking.service';
import { WhatsappGateway } from '../whatsapp/whatsapp.gateway';
import { WhatsappFilterService } from '../whatsapp/whatsapp-filter.service';

@ApiTags('Webhooks')
@ApiExcludeController()
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly tracking: TrackingService,
    private readonly whatsapp: WhatsappGateway,
    private readonly whatsappFilter: WhatsappFilterService,
  ) {}

  // -------------------------------------------------------------------------
  // Transporteurs
  // -------------------------------------------------------------------------

  @Public()
  @Post('carriers/:carrierCode')
  @HttpCode(HttpStatus.OK)
  // Limite genereuse : un transporteur peut envoyer des rafales legitimes lors
  // d'une tournee. Elle protege surtout contre un envoi massif malveillant.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: 'Evenement de suivi transporteur' })
  async carrierWebhook(
    @Param('carrierCode') carrierCode: string,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: true; applied: boolean; reason?: string }> {
    const rawBody = request.rawBody ?? Buffer.from('');
    const headers = this.collectHeaders(request);

    try {
      const result = await this.tracking.handleWebhook(
        carrierCode.toUpperCase(),
        rawBody,
        headers,
      );

      if (!result) {
        return { received: true, applied: false, reason: 'IGNORED' };
      }

      return { received: true, applied: result.newEvents > 0 };
    } catch (error) {
      // Une exception ici serait rejouee en boucle par le transporteur.
      this.logger.error(
        `Webhook ${carrierCode} en echec : ${(error as Error).message}`,
        (error as Error).stack,
      );
      return { received: true, applied: false, reason: 'INTERNAL_ERROR' };
    }
  }

  // -------------------------------------------------------------------------
  // WhatsApp Business Cloud
  // -------------------------------------------------------------------------

  @Public()
  @Get('whatsapp')
  @ApiOperation({
    summary: 'Verification d abonnement au webhook Meta',
    description:
      'Meta appelle cette route en GET lors de la configuration et attend que ' +
      'le `hub.challenge` lui soit renvoye tel quel.',
  })
  verifyWhatsappSubscription(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    if (this.whatsapp.verifySubscription(mode ?? '', token ?? '')) {
      return challenge ?? '';
    }

    this.logger.warn('Tentative de verification de webhook WhatsApp avec un jeton invalide.');
    // Une chaine vide fait echouer la verification cote Meta, sans rien
    // divulguer sur la raison.
    return '';
  }

  @Public()
  @Post('whatsapp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reponses des clients au filtre de confirmation' })
  async whatsappWebhook(
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: true; handled: number }> {
    const rawBody = request.rawBody ?? Buffer.from('');
    const signature = request.get('x-hub-signature-256');

    if (!this.whatsapp.verifyWebhookSignature(rawBody, signature)) {
      this.logger.error('SIGNATURE DE WEBHOOK WHATSAPP INVALIDE : evenement rejete.');
      return { received: true, handled: 0 };
    }

    const replies = this.parseWhatsappReplies(rawBody);
    let handled = 0;

    for (const reply of replies) {
      try {
        const result = await this.whatsappFilter.handleCustomerReply(
          reply.phoneE164,
          reply.payload,
          reply.messageId,
        );
        if (result) handled += 1;
      } catch (error) {
        this.logger.error(
          `Traitement d une reponse WhatsApp impossible : ${(error as Error).message}`,
        );
      }
    }

    return { received: true, handled };
  }

  /**
   * Extrait les reponses exploitables d'une charge utile Meta.
   *
   * La structure est profondement imbriquee et volontairement lue de facon
   * defensive : Meta fait evoluer son format, et un champ manquant ne doit
   * jamais faire echouer tout le lot.
   */
  private parseWhatsappReplies(rawBody: Buffer): {
    phoneE164: string;
    payload: string;
    messageId: string;
  }[] {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as {
        entry?: {
          changes?: {
            value?: {
              messages?: {
                id?: string;
                from?: string;
                type?: string;
                interactive?: { button_reply?: { id?: string }; type?: string };
                button?: { payload?: string; text?: string };
                text?: { body?: string };
              }[];
            };
          }[];
        }[];
      };

      const replies: { phoneE164: string; payload: string; messageId: string }[] = [];

      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const message of change.value?.messages ?? []) {
            if (!message.id || !message.from) continue;

            const payload =
              message.interactive?.button_reply?.id ??
              message.button?.payload ??
              message.text?.body ??
              '';

            if (payload.length === 0) continue;

            // Meta renvoie le numero sans le `+` : on le retablit pour
            // retrouver le fil ouvert, stocke en E.164.
            const phoneE164 = message.from.startsWith('+') ? message.from : `+${message.from}`;

            replies.push({ phoneE164, payload, messageId: message.id });
          }
        }
      }

      return replies;
    } catch (error) {
      this.logger.warn(`Charge utile WhatsApp illisible : ${(error as Error).message}`);
      return [];
    }
  }

  private collectHeaders(request: Request): Record<string, string | undefined> {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    return headers;
  }
}
