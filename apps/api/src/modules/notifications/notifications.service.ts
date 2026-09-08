/**
 * Notifications et centre d'incidents — V1 §18, V2 §21, Addendum §36.
 *
 * ARCHITECTURE MULTICANALE, DECOUPLEE DU METIER
 *   Le domaine ne connait pas les canaux : il publie un evenement dans la boite
 *   d'envoi transactionnelle. Ce service le consomme, decide QUI doit etre
 *   prevenu et PAR QUEL CANAL, puis cree une notification et ses tentatives
 *   d'acheminement.
 *
 *   Consequence pratique : ajouter un canal (SMS, webhook sortant) ne touche
 *   aucun service metier — exigence explicite du cahier de mission §36.
 *
 * PREFERENCES
 *   Chaque boutique, et chaque membre, peut couper un type de notification sur
 *   un canal. Le canal `IN_APP` reste toujours actif : sans lui, un incident
 *   pourrait passer totalement inapercu.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, NotificationSeverity } from '@prisma/client';
import { formatCentimes } from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { AppConfigService } from '../../config/configuration';
import { MailService } from './mail/mail.service';
import { WhatsappGateway } from '../whatsapp/whatsapp.gateway';
import type { PendingEvent } from '../events/outbox.service';
import { text } from '../../common/utils/text';

/** Description d'un type de notification : titre, gravite, canaux par defaut. */
interface NotificationTemplate {
  readonly severity: NotificationSeverity;
  readonly title: (payload: Record<string, unknown>) => string;
  readonly body: (payload: Record<string, unknown>) => string;
  readonly channels: readonly NotificationChannel[];
  readonly resourceType?: string;
  /** Permission requise pour voir la notification dans l'interface. */
  readonly requiredPermission?: string;
}

const TEMPLATES: Record<string, NotificationTemplate> = {
  'order.created': {
    severity: 'INFO',
    title: () => 'Nouvelle commande',
    body: (p) => `Commande ${text(p.reference, 'sans reference')} recue (${formatMoney(p.totalCentimes)}).`,
    channels: ['IN_APP'],
    resourceType: 'Order',
  },
  'order.duplicate_detected': {
    severity: 'WARNING',
    title: () => 'Doublon potentiel detecte',
    body: (p) =>
      `Une commande ressemble fortement a ${countMatches(p)} commande(s) recente(s). ` +
      'Aucune n a ete supprimee : verifiez avant de confirmer.',
    channels: ['IN_APP'],
    resourceType: 'Order',
  },
  'shipment.failed': {
    severity: 'ERROR',
    title: () => 'Echec de creation de colis',
    body: (p) => `Le transporteur ${text(p.carrier, 'selectionne')} a refuse la commande : ` +
      `${text(p.message, 'motif non communique')}`,
    channels: ['IN_APP', 'EMAIL'],
    resourceType: 'Order',
  },
  'tracking.updated': {
    severity: 'INFO',
    title: () => 'Suivi mis a jour',
    body: (p) => `Colis ${text(p.trackingNumber, 'sans numero')} : ${text(p.status, 'statut inconnu')}.`,
    channels: [],
    resourceType: 'Shipment',
  },
  'return.created': {
    severity: 'WARNING',
    title: () => 'Retour enregistre',
    body: (p) => `Retour cree pour la commande ${text(p.orderReference, 'concernee')} ` +
      `(${text(p.reason, 'motif non precise')}).`,
    channels: ['IN_APP'],
    resourceType: 'Return',
  },
  'stock.low': {
    severity: 'WARNING',
    title: () => 'Stock faible',
    body: (p) => `${text(p.sku, 'Un produit')} passe sous son seuil d alerte.`,
    channels: ['IN_APP', 'EMAIL'],
    resourceType: 'ProductVariant',
  },
  'sync.failed': {
    severity: 'ERROR',
    title: () => 'Echec de synchronisation Google Sheets',
    body: (p) => text(p.errorMessage, 'La synchronisation a echoue.'),
    channels: ['IN_APP', 'EMAIL'],
    resourceType: 'SheetSyncConfig',
  },
  'sync.rate_limited': {
    severity: 'WARNING',
    title: () => 'Quota Google atteint',
    body: (p) =>
      'La synchronisation reprendra automatiquement a ' +
      `${formatDate(p.retryAt)}. Aucune commande n est perdue.`,
    channels: ['IN_APP'],
    resourceType: 'SheetSyncConfig',
  },
  'trial.ending': {
    severity: 'WARNING',
    title: (p) =>
      p.daysRemaining === 0
        ? 'Votre essai gratuit se termine aujourd hui'
        : `Votre essai gratuit se termine dans ${p.daysRemaining} jour(s)`,
    body: () =>
      'Souscrivez un abonnement pour conserver l acces aux fonctionnalites ' +
      'operationnelles. Vos donnees restent accessibles dans tous les cas.',
    channels: ['IN_APP', 'EMAIL', 'WHATSAPP'],
  },
  'trial.ended': {
    severity: 'CRITICAL',
    title: () => 'Essai gratuit termine',
    body: () =>
      'Les fonctionnalites operationnelles sont suspendues. La consultation et ' +
      "l'export de vos donnees restent disponibles.",
    channels: ['IN_APP', 'EMAIL'],
  },
  'payment.settled': {
    severity: 'INFO',
    title: () => 'Paiement confirme',
    body: () => 'Votre abonnement est actif. Merci de votre confiance.',
    channels: ['IN_APP', 'EMAIL'],
  },
  'payment.rejected': {
    severity: 'ERROR',
    title: () => 'Paiement refuse',
    body: (p) => `Motif : ${text(p.reason, 'non precise')}.`,
    channels: ['IN_APP', 'EMAIL'],
  },
  'subscription.activated': {
    severity: 'INFO',
    title: () => 'Abonnement active',
    body: (p) => `Votre abonnement court jusqu au ${formatDate(p.periodEnd)}.`,
    channels: ['IN_APP', 'EMAIL'],
  },
  'subscription.suspended': {
    severity: 'CRITICAL',
    title: () => 'Boutique suspendue',
    body: (p) => `Motif : ${text(p.reason, 'non precise')}. Contactez le support.`,
    channels: ['IN_APP', 'EMAIL'],
  },
  'whatsapp.handover': {
    severity: 'INFO',
    title: () => 'Commande rendue a un agent',
    body: (p) => text(p.reason, 'Transfert automatique vers la file d appel.'),
    channels: ['IN_APP'],
    resourceType: 'Order',
  },
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly mail: MailService,
    private readonly whatsapp: WhatsappGateway,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // CONSOMMATION DES EVENEMENTS
  // ==========================================================================

  /**
   * Transforme un evenement metier en notification, puis l'achemine.
   *
   * @returns `true` si l'evenement a ete traite (meme sans notification a
   *          creer : tous les evenements ne sont pas notifiables).
   */
  async handleEvent(event: PendingEvent): Promise<boolean> {
    const template = TEMPLATES[event.eventType];

    // Un evenement sans modele n'est pas une erreur : beaucoup servent
    // uniquement a l'audit ou a d'autres consommateurs.
    if (!template || template.channels.length === 0) return true;
    if (!event.tenantId) return true;

    await RequestContextStore.runWithTenant(event.tenantId, async () => {
      const notification = await this.prisma.notification.create({
        data: {
          tenantId: event.tenantId as string,
          type: event.eventType,
          severity: template.severity,
          title: template.title(event.payload),
          body: template.body(event.payload),
          resourceType: template.resourceType ?? null,
          resourceId: this.extractResourceId(event.payload),
          metadata: event.payload as object,
        },
        select: { id: true, title: true, body: true },
      });

      const channels = await this.resolveChannels(
        event.tenantId as string,
        event.eventType,
        template.channels,
      );

      for (const channel of channels) {
        await this.deliver(
          event.tenantId as string,
          notification.id,
          channel,
          notification.title,
          notification.body,
        );
      }
    });

    return true;
  }

  /**
   * Achemine une notification sur un canal.
   *
   * L'echec d'un canal n'empeche jamais les autres : une panne SMTP ne doit
   * pas priver le commercant de sa notification dans l'application.
   */
  private async deliver(
    tenantId: string,
    notificationId: string,
    channel: NotificationChannel,
    title: string,
    body: string,
  ): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.create({
      data: { notificationId, channel, status: 'PENDING' },
      select: { id: true },
    });

    // Le canal in-app est deja satisfait par la creation de la notification.
    if (channel === 'IN_APP') {
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'DELIVERED', sentAt: this.clock.now() },
      });
      return;
    }

    try {
      if (channel === 'EMAIL') {
        const recipients = await this.resolveEmailRecipients(tenantId);
        if (recipients.length === 0) {
          await this.prisma.notificationDelivery.update({
            where: { id: delivery.id },
            data: { status: 'SKIPPED', errorMessage: 'Aucun destinataire.' },
          });
          return;
        }

        const result = await this.mail.send({
          to: recipients.join(', '),
          subject: `EcomFlow — ${title}`,
          text: `${body}\n\n${this.config.app.appUrl}/notifications`,
        });

        await this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: result.sent ? 'SENT' : 'FAILED',
            target: recipients.join(', '),
            errorMessage: result.error ?? null,
            sentAt: result.sent ? this.clock.now() : null,
            attempt: 1,
          },
        });
        return;
      }

      if (channel === 'WHATSAPP') {
        if (!this.whatsapp.isConfigured()) {
          await this.prisma.notificationDelivery.update({
            where: { id: delivery.id },
            data: { status: 'SKIPPED', errorMessage: 'Passerelle WhatsApp non configuree.' },
          });
          return;
        }

        const phone = await this.resolveOwnerPhone(tenantId);
        if (!phone) {
          await this.prisma.notificationDelivery.update({
            where: { id: delivery.id },
            data: { status: 'SKIPPED', errorMessage: 'Aucun numero verifie.' },
          });
          return;
        }

        const result = await this.whatsapp.sendText(phone, `${title}\n\n${body}`);
        await this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: result.sent ? 'SENT' : 'FAILED',
            target: phone,
            errorMessage: result.errorMessage ?? null,
            sentAt: result.sent ? this.clock.now() : null,
            attempt: 1,
          },
        });
      }
    } catch (error) {
      this.logger.warn(
        `Acheminement ${channel} de la notification ${notificationId} en echec : ` +
          (error as Error).message,
      );
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', errorMessage: (error as Error).message.slice(0, 500) },
      });
    }
  }

  // ==========================================================================
  // LECTURE
  // ==========================================================================

  async list(
    tenantId: string,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ) {
    return this.prisma.notification.findMany({
      where: { tenantId, ...(options.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 50,
      select: {
        id: true,
        type: true,
        severity: true,
        title: true,
        body: true,
        resourceType: true,
        resourceId: true,
        readAt: true,
        createdAt: true,
      },
    });
  }

  async countUnread(tenantId: string): Promise<number> {
    return this.prisma.notification.count({ where: { tenantId, readAt: null } });
  }

  async markRead(tenantId: string, notificationIds: readonly string[]): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { tenantId, id: { in: [...notificationIds] }, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return result.count;
  }

  async markAllRead(tenantId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { tenantId, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return result.count;
  }

  /** Preferences de notification de la boutique. */
  async listPreferences(tenantId: string) {
    return this.prisma.notificationPreference.findMany({
      where: { tenantId },
      select: { id: true, type: true, channel: true, enabled: true, membershipId: true },
    });
  }

  async setPreference(
    tenantId: string,
    type: string,
    channel: NotificationChannel,
    enabled: boolean,
    membershipId: string | null = null,
  ): Promise<void> {
    await this.prisma.notificationPreference.upsert({
      where: {
        tenantId_membershipId_type_channel: {
          tenantId,
          membershipId: membershipId as string,
          type,
          channel,
        },
      },
      create: { tenantId, membershipId, type, channel, enabled },
      update: { enabled },
    });
  }

  // ==========================================================================
  // Utilitaires
  // ==========================================================================

  /**
   * Canaux effectivement actifs pour ce type d'evenement.
   * `IN_APP` ne peut pas etre desactive : sans lui, un incident critique
   * pourrait passer totalement inapercu.
   */
  private async resolveChannels(
    tenantId: string,
    type: string,
    defaults: readonly NotificationChannel[],
  ): Promise<readonly NotificationChannel[]> {
    const preferences = await this.prisma.notificationPreference.findMany({
      where: { tenantId, type, membershipId: null },
      select: { channel: true, enabled: true },
    });

    const disabled = new Set(
      preferences.filter((entry) => !entry.enabled).map((entry) => entry.channel),
    );

    return defaults.filter((channel) => channel === 'IN_APP' || !disabled.has(channel));
  }

  private async resolveEmailRecipients(tenantId: string): Promise<string[]> {
    const owners = await this.prisma.membership.findMany({
      where: { tenantId, status: 'ACTIVE', role: { code: { in: ['OWNER', 'ADMIN'] } } },
      select: { user: { select: { email: true, anonymizedAt: true } } },
      take: 5,
    });

    return owners
      .filter((entry) => entry.user.anonymizedAt === null)
      .map((entry) => entry.user.email);
  }

  private async resolveOwnerPhone(tenantId: string): Promise<string | null> {
    const owner = await this.prisma.membership.findFirst({
      where: { tenantId, status: 'ACTIVE', role: { code: 'OWNER' } },
      select: { user: { select: { phoneE164: true, phoneVerifiedAt: true } } },
    });

    // Un numero non verifie n'est pas utilisable : on n'ecrit pas a un
    // numero dont on ignore s'il appartient bien au commercant.
    if (!owner?.user.phoneE164 || !owner.user.phoneVerifiedAt) return null;
    return owner.user.phoneE164;
  }

  private extractResourceId(payload: Record<string, unknown>): string | null {
    for (const key of ['orderId', 'shipmentId', 'returnId', 'configId', 'variantId', 'paymentId']) {
      const value = payload[key];
      if (typeof value === 'string') return value;
    }
    return null;
  }
}

function formatMoney(value: unknown): string {
  return typeof value === 'number' ? formatCentimes(value) : '';
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string') return 'une date proche';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'une date proche' : date.toISOString().slice(0, 16).replace('T', ' ');
}

function countMatches(payload: Record<string, unknown>): number {
  return Array.isArray(payload.matches) ? payload.matches.length : 1;
}
