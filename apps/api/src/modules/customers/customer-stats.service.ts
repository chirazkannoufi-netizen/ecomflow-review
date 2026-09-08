/**
 * Compteurs et score de fiabilite des clients — V2 §13, Addendum §32.
 *
 * POURQUOI DES COMPTEURS MATERIALISES
 *   Le score de fiabilite est affiche dans la file de confirmation, c'est-a-dire
 *   sur l'ecran le plus sollicite de la plateforme. Le recalculer par agregation
 *   sur l'historique complet a chaque affichage produirait, des quelques
 *   milliers de commandes, une file d'attente lente — donc inutilisee.
 *   Les compteurs sont donc maintenus a l'ecriture, DANS la transaction qui
 *   change le statut : ils ne peuvent pas diverger de l'historique.
 *
 * RECONCILIATION
 *   `recomputeFromHistory` recalcule tout depuis les commandes reelles. Il sert
 *   au job de verification periodique et a la reprise apres un incident.
 *   Le score reste ainsi toujours fonde sur des donnees reelles (prompt §20).
 */

import { Injectable } from '@nestjs/common';
import {
  DEFAULT_RELIABILITY_POLICY,
  assessCustomerReliability,
  type CustomerOrderStats,
  type OrderStatus,
  type ReliabilityAssessment,
  type ReliabilityPolicy,
} from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';

/** Issues qui comptent comme un echec consecutif du point de vue client. */
const NEGATIVE_OUTCOMES: readonly OrderStatus[] = ['CANCELLED', 'REFUSED', 'RETURNED'];

@Injectable()
export class CustomerStatsService {
  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly clock: ClockService,
  ) {}

  /**
   * Applique l'issue d'une commande aux compteurs du client, puis recalcule
   * son score. Appele DANS la transaction de changement de statut.
   */
  async applyOutcome(
    tx: PrismaTransactionClient,
    tenantId: string,
    customerId: string,
    outcome: OrderStatus,
  ): Promise<void> {
    const isNegative = NEGATIVE_OUTCOMES.includes(outcome);

    const increments: Record<string, { increment: number }> = {};
    switch (outcome) {
      case 'DELIVERED':
        increments.deliveredCount = { increment: 1 };
        break;
      case 'CANCELLED':
        increments.cancelledCount = { increment: 1 };
        break;
      case 'REFUSED':
        increments.refusedCount = { increment: 1 };
        break;
      case 'RETURNED':
        increments.returnedCount = { increment: 1 };
        break;
      default:
        return;
    }

    const customer = await tx.customer.update({
      where: { id: customerId },
      data: {
        ...increments,
        // Une livraison reussie remet le compteur d'echecs consecutifs a zero :
        // c'est ce qui permet a un client de « se racheter » et evite qu'un
        // incident ancien le penalise indefiniment.
        consecutiveFailures: isNegative ? { increment: 1 } : { set: 0 },
        lastOrderAt: this.clock.now(),
      },
      select: {
        id: true,
        ordersCount: true,
        deliveredCount: true,
        cancelledCount: true,
        refusedCount: true,
        returnedCount: true,
        unreachableCount: true,
        consecutiveFailures: true,
        lastOrderAt: true,
      },
    });

    const policy = await this.loadPolicy(tx, tenantId);
    const assessment = assessCustomerReliability(
      {
        totalOrders: customer.ordersCount,
        confirmedOrders: 0,
        deliveredOrders: customer.deliveredCount,
        refusedOrders: customer.refusedCount,
        returnedOrders: customer.returnedCount,
        cancelledOrders: customer.cancelledCount,
        unreachableOrders: customer.unreachableCount,
        consecutiveFailures: customer.consecutiveFailures,
        lastOrderAt: customer.lastOrderAt,
      },
      policy,
      this.clock.now(),
    );

    await this.persistAssessment(tx, customerId, assessment);
  }

  /** Incremente le compteur de commandes a la creation. */
  async registerNewOrder(
    tx: PrismaTransactionClient,
    customerId: string,
    orderedAt: Date,
  ): Promise<void> {
    await tx.customer.update({
      where: { id: customerId },
      data: { ordersCount: { increment: 1 }, lastOrderAt: orderedAt },
    });
  }

  /** Comptabilise un client demeure injoignable (numero incorrect, sans reponse). */
  async registerUnreachable(
    tx: PrismaTransactionClient,
    tenantId: string,
    customerId: string,
  ): Promise<void> {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data: { unreachableCount: { increment: 1 }, consecutiveFailures: { increment: 1 } },
      select: {
        ordersCount: true,
        deliveredCount: true,
        cancelledCount: true,
        refusedCount: true,
        returnedCount: true,
        unreachableCount: true,
        consecutiveFailures: true,
        lastOrderAt: true,
      },
    });

    const policy = await this.loadPolicy(tx, tenantId);
    const assessment = assessCustomerReliability(
      {
        totalOrders: customer.ordersCount,
        confirmedOrders: 0,
        deliveredOrders: customer.deliveredCount,
        refusedOrders: customer.refusedCount,
        returnedOrders: customer.returnedCount,
        cancelledOrders: customer.cancelledCount,
        unreachableOrders: customer.unreachableCount,
        consecutiveFailures: customer.consecutiveFailures,
        lastOrderAt: customer.lastOrderAt,
      },
      policy,
      this.clock.now(),
    );

    await this.persistAssessment(tx, customerId, assessment);
  }

  /**
   * Recalcule integralement les compteurs et le score d'un client depuis son
   * historique reel de commandes.
   *
   * Sert au job de reconciliation et apres toute correction manuelle. C'est la
   * garantie que le score reste fonde sur des donnees verifiables : en cas de
   * doute, on peut toujours le reconstruire.
   */
  async recomputeFromHistory(tenantId: string, customerId: string): Promise<ReliabilityAssessment> {
    const orders = await this.prisma.order.findMany({
      where: { tenantId, customerId, archivedAt: null },
      select: { status: true, orderedAt: true },
      orderBy: { orderedAt: 'desc' },
    });

    const count = (status: OrderStatus): number =>
      orders.filter((order) => order.status === status).length;

    // Serie d'echecs la plus recente : on parcourt du plus recent au plus
    // ancien et on s'arrete a la premiere issue positive.
    let consecutiveFailures = 0;
    for (const order of orders) {
      const status = order.status;
      if (NEGATIVE_OUTCOMES.includes(status)) {
        consecutiveFailures += 1;
        continue;
      }
      if (status === 'DELIVERED') break;
      // Les commandes encore en cours n'interrompent pas la serie : elles
      // n'ont pas encore d'issue.
    }

    const stats: CustomerOrderStats = {
      totalOrders: orders.length,
      confirmedOrders: 0,
      deliveredOrders: count('DELIVERED'),
      refusedOrders: count('REFUSED'),
      returnedOrders: count('RETURNED'),
      cancelledOrders: count('CANCELLED'),
      unreachableOrders: count('WRONG_NUMBER'),
      consecutiveFailures,
      lastOrderAt: orders[0]?.orderedAt ?? null,
    };

    const policy = await this.loadPolicy(this.prisma, tenantId);
    const assessment = assessCustomerReliability(stats, policy, this.clock.now());

    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        ordersCount: stats.totalOrders,
        deliveredCount: stats.deliveredOrders,
        refusedCount: stats.refusedOrders,
        returnedCount: stats.returnedOrders,
        cancelledCount: stats.cancelledOrders,
        unreachableCount: stats.unreachableOrders,
        consecutiveFailures: stats.consecutiveFailures,
        lastOrderAt: stats.lastOrderAt,
        reliabilityScore: assessment.score,
        reliabilityTier: assessment.tier,
        reliabilityFactors: assessment.factors as unknown as object,
        reliabilityUpdatedAt: this.clock.now(),
      },
    });

    return assessment;
  }

  /** Evaluation lisible d'un client, pour la fiche et la file de confirmation. */
  async getAssessment(tenantId: string, customerId: string): Promise<ReliabilityAssessment> {
    const customer = await this.prisma.customer.findFirst({
      where: { tenantId, id: customerId },
      select: {
        ordersCount: true,
        deliveredCount: true,
        cancelledCount: true,
        refusedCount: true,
        returnedCount: true,
        unreachableCount: true,
        consecutiveFailures: true,
        lastOrderAt: true,
      },
    });

    if (!customer) {
      return {
        score: null,
        tier: 'UNKNOWN',
        factors: [],
        recommendedActions: [],
        consideredOutcomes: 0,
      };
    }

    const policy = await this.loadPolicy(this.prisma, tenantId);
    return assessCustomerReliability(
      {
        totalOrders: customer.ordersCount,
        confirmedOrders: 0,
        deliveredOrders: customer.deliveredCount,
        refusedOrders: customer.refusedCount,
        returnedOrders: customer.returnedCount,
        cancelledOrders: customer.cancelledCount,
        unreachableOrders: customer.unreachableCount,
        consecutiveFailures: customer.consecutiveFailures,
        lastOrderAt: customer.lastOrderAt,
      },
      policy,
      this.clock.now(),
    );
  }

  // -------------------------------------------------------------------------

  private async persistAssessment(
    tx: PrismaTransactionClient,
    customerId: string,
    assessment: ReliabilityAssessment,
  ): Promise<void> {
    await tx.customer.update({
      where: { id: customerId },
      data: {
        reliabilityScore: assessment.score,
        reliabilityTier: assessment.tier,
        reliabilityFactors: assessment.factors as unknown as object,
        reliabilityUpdatedAt: this.clock.now(),
      },
    });
  }

  /** Seuils configures par la boutique, ou politique par defaut. */
  private async loadPolicy(
    client: PrismaClientExtended | PrismaTransactionClient,
    tenantId: string,
  ): Promise<ReliabilityPolicy> {
    const settings = await client.tenantSettings.findUnique({
      where: { tenantId },
      select: {
        reliabilityMinHistory: true,
        reliabilityReliableThreshold: true,
        reliabilityWatchThreshold: true,
        reliabilityFailureLimit: true,
        reliabilityAtRiskActions: true,
      },
    });

    if (!settings) return DEFAULT_RELIABILITY_POLICY;

    return {
      minHistory: settings.reliabilityMinHistory,
      reliableThreshold: settings.reliabilityReliableThreshold,
      watchThreshold: settings.reliabilityWatchThreshold,
      consecutiveFailureLimit: settings.reliabilityFailureLimit,
      stalenessDays: DEFAULT_RELIABILITY_POLICY.stalenessDays,
      atRiskActions: settings.reliabilityAtRiskActions as ReliabilityPolicy['atRiskActions'],
    };
  }
}
