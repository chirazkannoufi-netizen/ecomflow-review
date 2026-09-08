/**
 * Etat d'abonnement d'une boutique — source de verite SERVEUR.
 *
 * Exigence centrale (V2 §7, §38, prompt produit §32) :
 *   « Le systeme doit avoir une source de verite cote serveur pour la periode
 *     d'essai et l'etat de l'abonnement. L'interface ne doit jamais decider
 *     seule qu'un compte est actif. »
 *
 * Ce service est le SEUL endroit ou l'on decide si une boutique peut utiliser
 * les fonctionnalites operationnelles payantes. Il est consulte :
 *  - par `SubscriptionGuard`, en amont des routes operationnelles ;
 *  - par la garde `REQUIRE_SUBSCRIPTION_OPERATIONAL` du workflow de commande,
 *    afin qu'un job ou un webhook ne puisse pas contourner le blocage.
 *
 * Le statut persiste est recalcule a la volee : meme si le job d'expiration
 * n'a pas encore tourne, une boutique dont l'essai est termine est bloquee
 * a la milliseconde pres.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  deriveSubscriptionState,
  type SubscriptionSnapshot,
  type SubscriptionState,
} from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';

/**
 * Cache tres court. L'etat ne change qu'aux frontieres de periode ou lors d'un
 * paiement ; 10 secondes de retard sont sans consequence, et le cache est
 * invalide explicitement des qu'un paiement aboutit.
 */
const STATE_CACHE_TTL_MS = 10_000;

interface CacheEntry {
  readonly state: SubscriptionState;
  readonly expiresAt: number;
}

@Injectable()
export class SubscriptionStateService {
  private readonly logger = new Logger(SubscriptionStateService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly clock: ClockService,
  ) {}

  /**
   * Etat courant de l'abonnement d'une boutique.
   *
   * Retourne un etat non operationnel plutot que de lever une exception quand
   * aucun abonnement n'existe : l'absence d'abonnement est un etat metier
   * legitime (boutique jamais initialisee), pas une erreur technique.
   */
  async getState(tenantId: string): Promise<SubscriptionState> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > this.clock.timestamp()) {
      return cached.state;
    }

    const subscription = await RequestContextStore.runWithTenant(tenantId, () =>
      this.prisma.subscription.findUnique({
        where: { tenantId },
        select: {
          status: true,
          trialStartAt: true,
          trialEndAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelledAt: true,
          suspendedAt: true,
          pastDueSince: true,
        },
      }),
    );

    if (!subscription) {
      const state: SubscriptionState = {
        status: 'EXPIRED',
        operational: false,
        trialDaysRemaining: null,
        periodDaysRemaining: null,
        reason: 'Aucun abonnement n est associe a cette boutique.',
      };
      this.cache.set(tenantId, {
        state,
        expiresAt: this.clock.timestamp() + STATE_CACHE_TTL_MS,
      });
      return state;
    }

    const snapshot: SubscriptionSnapshot = {
      trialStartAt: subscription.trialStartAt,
      trialEndAt: subscription.trialEndAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelledAt: subscription.cancelledAt,
      suspendedAt: subscription.suspendedAt,
      pastDueSince: subscription.pastDueSince,
    };

    const state = deriveSubscriptionState(snapshot, this.clock.now());

    // Le statut persiste est aligne de facon opportuniste. Il n'est jamais
    // la source de verite : il sert au reporting, aux filtres et a l'affichage.
    if (state.status !== subscription.status) {
      await this.persistStatus(tenantId, state.status, subscription.status);
    }

    this.cache.set(tenantId, {
      state,
      expiresAt: this.clock.timestamp() + STATE_CACHE_TTL_MS,
    });
    return state;
  }

  /** Raccourci : la boutique peut-elle utiliser l'operationnel payant ? */
  async isOperational(tenantId: string): Promise<boolean> {
    return (await this.getState(tenantId)).operational;
  }

  /** Invalide le cache d'une boutique (paiement valide, suspension, reprise). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async persistStatus(
    tenantId: string,
    nextStatus: SubscriptionState['status'],
    previousStatus: string,
  ): Promise<void> {
    try {
      await RequestContextStore.runWithTenant(tenantId, () =>
        this.prisma.subscription.update({
          where: { tenantId },
          data: { status: nextStatus, lastEvaluatedAt: this.clock.now() },
        }),
      );
      this.logger.log(
        `Abonnement recalcule pour la boutique ${tenantId} : ${previousStatus} -> ${nextStatus}`,
      );
    } catch (error) {
      // L'alignement du statut persiste est une commodite. S'il echoue, l'etat
      // calcule reste correct et fait autorite : on ne bloque pas la requete.
      this.logger.warn(
        `Impossible d aligner le statut d abonnement de ${tenantId} : ${(error as Error).message}`,
      );
    }
  }
}
