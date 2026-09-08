/**
 * Traitements planifies — V2 §30, Addendum §39.
 *
 * POURQUOI `@nestjs/schedule` ET NON BULLMQ ICI
 *   Ces taches sont des BALAYAGES PERIODIQUES : elles interrogent la base pour
 *   trouver du travail, et le travail lui-meme est deja rendu idempotent et
 *   reprenable par sa conception (curseur de synchronisation, boite d'envoi,
 *   verrous `SKIP LOCKED`). Une file de messages n'apporterait rien de plus,
 *   et imposerait Redis en developpement.
 *   BullMQ reste pertinent pour du travail declenche a l'unite et long
 *   (generation d'export volumineux) ; c'est documente dans le README.
 *
 * EXECUTION CONCURRENTE
 *   Chaque tache porte un verrou en memoire : si une execution deborde sur la
 *   suivante, la seconde est sautee plutot que de doubler la charge. Pour un
 *   deploiement multi-instances, les requetes de selection utilisent
 *   `FOR UPDATE SKIP LOCKED`, ce qui rend le travail naturellement partageable.
 *
 * TOLERANCE AUX PANNES
 *   Une tache qui echoue est journalisee et NE FAIT PAS tomber le processus.
 *   Une boutique en erreur n'empeche jamais le traitement des autres : la
 *   boucle capture l'erreur par element.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfigService } from '../../config/configuration';
import { RequestContextStore } from '../../infra/context/request-context';
import { BillingService } from '../billing/billing.service';
import { OutboxService } from '../events/outbox.service';
import { SheetSyncService } from '../integrations/google/sheet-sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrackingService } from '../shipments/tracking.service';
import { TokenService } from '../auth/token.service';
import { OtpService } from '../auth/otp.service';
import { WhatsappFilterService } from '../whatsapp/whatsapp-filter.service';

@Injectable()
export class ScheduledJobsService {
  private readonly logger = new Logger(ScheduledJobsService.name);

  /** Verrous en memoire, un par tache. */
  private readonly running = new Set<string>();

  constructor(
    private readonly sheetSync: SheetSyncService,
    private readonly tracking: TrackingService,
    private readonly billing: BillingService,
    private readonly whatsappFilter: WhatsappFilterService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly config: AppConfigService,
  ) {}

  // ==========================================================================
  // SYNCHRONISATION GOOGLE SHEETS
  // ==========================================================================

  /**
   * Toutes les 2 minutes, traite les feuilles arrivees a echeance.
   *
   * La selection tient compte du decalage de planification propre a chaque
   * feuille : cent boutiques reglees sur 10 minutes ne declenchent pas cent
   * lectures a la meme seconde (Addendum §39).
   */
  @Cron('0 */2 * * * *', { name: 'sheet-sync' })
  async runSheetSync(): Promise<void> {
    await this.guard('sheet-sync', async () => {
      const due = await this.sheetSync.findDueConfigs(25);
      if (due.length === 0) return;

      let succeeded = 0;
      let rateLimited = 0;

      for (const entry of due) {
        try {
          const result = await RequestContextStore.runWithTenant(entry.tenantId, () =>
            this.sheetSync.sync(entry.tenantId, entry.configId, 'SCHEDULED'),
          );
          if (result.status === 'RATE_LIMITED') rateLimited += 1;
          else succeeded += 1;
        } catch (error) {
          // Une feuille en echec ne doit pas bloquer les autres boutiques.
          this.logger.error(
            `Synchronisation ${entry.configId} en echec : ${(error as Error).message}`,
          );
        }
      }

      this.logger.log(
        `Synchronisation planifiee : ${due.length} feuille(s), ${succeeded} traitee(s), ` +
          `${rateLimited} differee(s) pour quota.`,
      );
    });
  }

  // ==========================================================================
  // SUIVI TRANSPORTEUR
  // ==========================================================================

  /**
   * Toutes les 5 minutes, interroge les colis en vol.
   *
   * L'intervalle de sondage s'allonge avec l'anciennete du colis : un colis
   * cree il y a une heure merite un suivi rapproche, pas un colis en transit
   * depuis huit jours.
   */
  @Cron('0 */5 * * * *', { name: 'tracking-poll' })
  async runTrackingPoll(): Promise<void> {
    await this.guard('tracking-poll', async () => {
      const shipments = await this.tracking.findShipmentsToPoll(50);
      if (shipments.length === 0) return;

      let updated = 0;

      for (const shipment of shipments) {
        try {
          const result = await RequestContextStore.runWithTenant(shipment.tenantId, () =>
            this.tracking.pollShipment(shipment.tenantId, shipment.shipmentId),
          );
          if (result.newEvents > 0) updated += 1;
        } catch (error) {
          this.logger.warn(
            `Suivi du colis ${shipment.shipmentId} impossible : ${(error as Error).message}`,
          );
        }
      }

      if (updated > 0) {
        this.logger.log(
          `Suivi transporteur : ${shipments.length} colis interroges, ${updated} mis a jour.`,
        );
      }
    });
  }

  // ==========================================================================
  // FILTRE WHATSAPP
  // ==========================================================================

  /**
   * Toutes les 10 minutes, ramene en file d'appel les commandes restees sans
   * reponse WhatsApp (Addendum §31 : « le canal WhatsApp est un premier filtre,
   * jamais un point de perte de commande »).
   */
  @Cron('0 */10 * * * *', { name: 'whatsapp-timeouts' })
  async runWhatsappTimeouts(): Promise<void> {
    await this.guard('whatsapp-timeouts', async () => {
      const result = await this.whatsappFilter.processTimeouts(200);
      if (result.handedOver > 0) {
        this.logger.log(
          `${result.handedOver} commande(s) sans reponse WhatsApp rendue(s) a un agent.`,
        );
      }
    });
  }

  // ==========================================================================
  // ABONNEMENTS
  // ==========================================================================

  /**
   * Toutes les heures, recalcule les abonnements arrives a echeance et envoie
   * les rappels d'expiration (J-3, J-1, jour meme).
   *
   * L'etat d'abonnement etant deja recalcule a la volee a chaque requete, ce
   * job ne fait qu'aligner les statuts persistes et declencher les rappels :
   * il n'est jamais sur le chemin critique d'un blocage d'acces.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'subscription-expiration' })
  async runSubscriptionExpiration(): Promise<void> {
    await this.guard('subscription-expiration', async () => {
      const result = await this.billing.processExpirations();
      if (result.expired > 0 || result.reminders > 0) {
        this.logger.log(
          `Abonnements : ${result.evaluated} evalues, ${result.expired} expires, ` +
            `${result.reminders} rappels.`,
        );
      }
    });
  }

  // ==========================================================================
  // BOITE D'ENVOI
  // ==========================================================================

  /**
   * Toutes les 30 secondes, depile les evenements metier et les transforme en
   * notifications.
   *
   * Cadence rapide : c'est ce qui rend les notifications quasi temps reel
   * malgre l'asynchronisme. Le lot est borne pour ne jamais monopoliser le
   * processus.
   */
  @Cron('*/30 * * * * *', { name: 'outbox-dispatch' })
  async runOutboxDispatch(): Promise<void> {
    await this.guard('outbox-dispatch', async () => {
      const events = await this.outbox.claimBatch(50);
      if (events.length === 0) return;

      let processed = 0;
      let failed = 0;

      for (const event of events) {
        try {
          await this.notifications.handleEvent(event);
          await this.outbox.markProcessed(event.id);
          processed += 1;
        } catch (error) {
          await this.outbox.markFailed(
            event.id,
            event.attempts,
            (error as Error).message,
          );
          failed += 1;
        }
      }

      if (failed > 0) {
        this.logger.warn(
          `Boite d envoi : ${processed} evenement(s) traite(s), ${failed} en echec.`,
        );
      }
    });
  }

  // ==========================================================================
  // MENAGE
  // ==========================================================================

  /**
   * Chaque nuit, purge les donnees techniques perimees.
   *
   * Ne touche JAMAIS aux donnees metier : commandes, clients et historiques
   * relevent de la politique de conservation, pas d'un menage technique.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'nightly-cleanup' })
  async runNightlyCleanup(): Promise<void> {
    await this.guard('nightly-cleanup', async () => {
      const [tokens, otps, outbox] = await Promise.all([
        this.tokens.purgeExpiredTokens(),
        this.otp.purgeExpired(),
        this.outbox.purgeProcessed(),
      ]);

      this.logger.log(
        `Menage nocturne : ${tokens} jeton(s), ${otps} code(s) OTP, ` +
          `${outbox} evenement(s) traite(s) supprimes.`,
      );
    });
  }

  // ==========================================================================

  /**
   * Execute une tache sous verrou, en absorbant toute erreur.
   *
   * Une exception non capturee dans un `@Cron` remonte au gestionnaire global
   * de rejets non geres et peut, selon la configuration, arreter le processus.
   * Un incident sur une tache de fond ne doit jamais couper l'API.
   */
  private async guard(name: string, task: () => Promise<void>): Promise<void> {
    if (this.config.isTest) return;

    if (this.running.has(name)) {
      this.logger.debug(`Tache ${name} deja en cours : execution sautee.`);
      return;
    }

    this.running.add(name);
    const startedAt = Date.now();

    try {
      await RequestContextStore.runUnscoped('BACKGROUND_JOB', task);
    } catch (error) {
      this.logger.error(
        `Tache ${name} en echec : ${(error as Error).message}`,
        (error as Error).stack,
      );
    } finally {
      this.running.delete(name);
      const durationMs = Date.now() - startedAt;
      if (durationMs > 30_000) {
        this.logger.warn(`Tache ${name} terminee en ${Math.round(durationMs / 1000)} s.`);
      }
    }
  }
}
