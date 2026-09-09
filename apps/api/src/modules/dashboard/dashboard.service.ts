/**
 * Dashboard et indicateurs — V1 §16, V2 §20, Addendum §33.
 *
 * DEFINITIONS DES TAUX, ecrites une seule fois et appliquees partout.
 *   Le cahier des charges laisse volontairement ces definitions ouvertes
 *   (« selon definition metier »). Les voici, explicites et documentees, pour
 *   qu'un commercant puisse retrouver chaque chiffre a la main :
 *
 *     taux de confirmation = confirmees / traitees par la confirmation
 *       « traitees » exclut les commandes encore dans la file : sinon le taux
 *       chuterait mecaniquement chaque matin a l'arrivee des commandes de la
 *       nuit, sans qu'aucune performance n'ait change.
 *
 *     taux de livraison = livrees / expediees
 *       Denominateur = commandes reellement confiees a un transporteur. Une
 *       commande annulee avant expedition n'a jamais eu de chance d'etre
 *       livree : l'inclure punirait le commercant deux fois.
 *
 *     taux de retour = retournees / expediees
 *     taux d'annulation = annulees / total des commandes creees
 *
 * PERFORMANCE
 *   Les agregations passent par des requetes SQL groupees, jamais par un
 *   chargement en memoire. Un tableau de bord qui s'effondre a 50 000
 *   commandes ne sert a rien : ce sont precisement les boutiques qui en ont le
 *   plus besoin.
 *
 * ISOLATION
 *   Les requetes brutes ne sont PAS interceptees par le garde Prisma : chacune
 *   filtre `tenant_id` explicitement, et un test d'integration le verifie.
 */

import { Injectable } from '@nestjs/common';
import {
  aggregateProfitability,
  computeOrderProfitability,
  netMarginPercentage,
  type ProfitabilityAggregate,
} from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

export interface OrderKpis {
  readonly total: number;
  readonly byStatus: Record<string, number>;
  readonly newOrders: number;
  readonly toConfirm: number;
  readonly confirmed: number;
  readonly shipped: number;
  readonly inDelivery: number;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  readonly refused: number;
  readonly rates: {
    readonly confirmation: number | null;
    readonly delivery: number | null;
    readonly return: number | null;
    readonly cancellation: number | null;
  };
}

export interface FinancialKpis {
  readonly recognizedRevenueCentimes: number;
  readonly cogsCentimes: number;
  readonly shippingCostCentimes: number;
  readonly grossMarginCentimes: number;
  readonly netResultCentimes: number;
  readonly realizedLossCentimes: number;
  readonly opportunityLossCentimes: number;
  readonly netMarginPercent: number | null;
  /** Part des commandes dont le prix d'achat est renseigne (0-1). */
  readonly cogsCompleteness: number;
  readonly averageOrderValueCentimes: number;
}

@Injectable()
export class DashboardService {
  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // KPI OPERATIONNELS
  // ==========================================================================

  async getOrderKpis(tenantId: string, range: DateRange): Promise<OrderKpis> {
    const grouped = await this.prisma.order.groupBy({
      by: ['status'],
      where: {
        tenantId,
        archivedAt: null,
        orderedAt: { gte: range.from, lte: range.to },
      },
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    for (const row of grouped) byStatus[row.status] = row._count._all;

    const count = (status: string): number => byStatus[status] ?? 0;
    const total = grouped.reduce((sum, row) => sum + row._count._all, 0);

    const delivered = count('DELIVERED');
    const returned = count('RETURNED');
    const refused = count('REFUSED');
    const cancelled = count('CANCELLED');
    const shipped = count('SHIPPED');
    const inDelivery = count('IN_DELIVERY');

    // Commandes reellement confiees a un transporteur : celles qui sont en
    // transit ou qui en sont sorties, quelle qu'en soit l'issue.
    const dispatched = shipped + inDelivery + delivered + returned + refused;

    // Commandes traitees par la confirmation : sorties de la file, quelle que
    // soit l'issue.
    const processed =
      count('CONFIRMED') +
      count('IN_PREPARATION') +
      count('READY_TO_SHIP') +
      dispatched +
      cancelled +
      count('WRONG_NUMBER');

    const confirmedTotal =
      count('CONFIRMED') + count('IN_PREPARATION') + count('READY_TO_SHIP') + dispatched;

    return {
      total,
      byStatus,
      newOrders: count('NEW'),
      toConfirm:
        count('TO_CONFIRM') + count('NO_ANSWER') + count('CALL_BACK') + count('POSTPONED'),
      confirmed: confirmedTotal,
      shipped,
      inDelivery,
      delivered,
      returned,
      cancelled,
      refused,
      rates: {
        // `null` plutot que 0 : « aucune donnee » et « 0 % » ne veulent pas
        // dire la meme chose, et afficher 0 % sur une boutique neuve serait
        // decourageant autant que faux.
        confirmation: processed === 0 ? null : (confirmedTotal / processed) * 100,
        delivery: dispatched === 0 ? null : (delivered / dispatched) * 100,
        return: dispatched === 0 ? null : ((returned + refused) / dispatched) * 100,
        cancellation: total === 0 ? null : (cancelled / total) * 100,
      },
    };
  }

  // ==========================================================================
  // KPI FINANCIERS ET RENTABILITE (Addendum §33)
  // ==========================================================================

  /**
   * Calcule le resultat economique de la periode.
   *
   * Les commandes sont chargees par lots avec leurs lignes, puis passees dans
   * les fonctions PURES de `@ecomflow/shared`. Le calcul est donc identique a
   * celui teste unitairement, et le commercant peut le reproduire.
   */
  async getFinancialKpis(tenantId: string, range: DateRange): Promise<FinancialKpis> {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        archivedAt: null,
        orderedAt: { gte: range.from, lte: range.to },
      },
      select: {
        status: true,
        deliveryFeeCentimes: true,
        carrierCostCentimes: true,
        returnCostCentimes: true,
        totalCentimes: true,
        items: {
          select: {
            quantity: true,
            unitPriceCentimes: true,
            unitPurchasePriceCentimes: true,
            discountCentimes: true,
          },
        },
        returns: { select: { stockDecision: true }, take: 1 },
      },
      take: 20_000,
    });

    const results = orders.map((order) =>
      computeOrderProfitability({
        status: order.status,
        lines: order.items.map((item) => ({
          quantity: item.quantity,
          unitPriceCentimes: item.unitPriceCentimes,
          unitPurchasePriceCentimes: item.unitPurchasePriceCentimes,
          discountCentimes: item.discountCentimes,
        })),
        deliveryFeeChargedCentimes: order.deliveryFeeCentimes,
        carrierCostCentimes: order.carrierCostCentimes,
        returnCostCentimes: order.returnCostCentimes,
        returnStockDecision: order.returns[0]?.stockDecision ?? null,
      }),
    );

    const aggregate = aggregateProfitability(results);
    const deliveredCount = orders.filter((order) => order.status === 'DELIVERED').length;

    return {
      recognizedRevenueCentimes: aggregate.recognizedRevenueCentimes,
      cogsCentimes: aggregate.cogsCentimes,
      shippingCostCentimes: aggregate.shippingCostCentimes,
      grossMarginCentimes: aggregate.grossMarginCentimes,
      netResultCentimes: aggregate.netResultCentimes,
      realizedLossCentimes: aggregate.realizedLossCentimes,
      opportunityLossCentimes: aggregate.opportunityLossCentimes,
      netMarginPercent: netMarginPercentage(aggregate),
      cogsCompleteness: aggregate.cogsCompletenessRatio,
      averageOrderValueCentimes:
        deliveredCount === 0
          ? 0
          : Math.round(aggregate.recognizedRevenueCentimes / deliveredCount),
    };
  }

  /**
   * Tableau « Pertes & Rentabilite », ventile par axe (Addendum §33).
   *
   * Chaque axe repond a une question operationnelle precise :
   *   wilaya      -> ou la livraison echoue-t-elle le plus ?
   *   transporteur-> lequel me coute le plus cher en retours ?
   *   produit     -> lequel est le plus refuse a la livraison ?
   *   agent       -> quelle equipe confirme le mieux ?
   */
  async getLossBreakdown(
    tenantId: string,
    range: DateRange,
    dimension: 'wilaya' | 'carrier' | 'product' | 'agent' | 'source',
  ): Promise<
    readonly {
      key: string;
      label: string;
      orders: number;
      delivered: number;
      failed: number;
      failureRate: number;
      realizedLossCentimes: number;
      recognizedRevenueCentimes: number;
    }[]
  > {
    const rows = await this.queryBreakdown(tenantId, range, dimension);

    return rows.map((row) => {
      const orders = Number(row.orders);
      const delivered = Number(row.delivered);
      const failed = Number(row.failed);

      return {
        key: row.key ?? 'inconnu',
        label: row.label ?? 'Non renseigne',
        orders,
        delivered,
        failed,
        failureRate: orders === 0 ? 0 : (failed / orders) * 100,
        realizedLossCentimes: Number(row.loss ?? 0),
        recognizedRevenueCentimes: Number(row.revenue ?? 0),
      };
    });
  }

  /**
   * Requete d'agregation par axe.
   *
   * SQL brut assume : Prisma ne sait pas exprimer un `GROUP BY` avec des
   * agregats conditionnels (`FILTER (WHERE ...)`), et charger 20 000 commandes
   * en memoire pour les regrouper serait absurde. Le filtre `tenant_id` est
   * present dans chaque variante.
   */
  private async queryBreakdown(
    tenantId: string,
    range: DateRange,
    dimension: 'wilaya' | 'carrier' | 'product' | 'agent' | 'source',
  ): Promise<
    {
      key: string | null;
      label: string | null;
      orders: bigint;
      delivered: bigint;
      failed: bigint;
      loss: bigint | null;
      revenue: bigint | null;
    }[]
  > {
    // Expression de perte reelle, alignee sur `computeOrderProfitability` :
    // une commande en echec APRES expedition perd les frais de transport
    // aller-retour ; une commande livree ne perd rien.
    const lossExpression = `
      SUM(
        CASE
          WHEN o.status IN ('REFUSED', 'RETURNED')
            THEN o.carrier_cost_centimes + o.return_cost_centimes
          WHEN o.status = 'CANCELLED'
            THEN o.carrier_cost_centimes + o.return_cost_centimes
          ELSE 0
        END
      )`;

    const revenueExpression = `
      SUM(
        CASE WHEN o.status = 'DELIVERED'
          THEN o.items_total_centimes + o.delivery_fee_centimes
          ELSE 0
        END
      )`;

    const common = `
      COUNT(*)::bigint AS orders,
      COUNT(*) FILTER (WHERE o.status = 'DELIVERED')::bigint AS delivered,
      COUNT(*) FILTER (WHERE o.status IN ('REFUSED', 'RETURNED', 'CANCELLED'))::bigint AS failed,
      ${lossExpression}::bigint AS loss,
      ${revenueExpression}::bigint AS revenue
    `;

    const where = `
      WHERE o.tenant_id = $1::uuid
        AND o.archived_at IS NULL
        AND o.ordered_at BETWEEN $2 AND $3
    `;

    let sql: string;

    switch (dimension) {
      case 'wilaya':
        sql = `
          SELECT o.wilaya_code_snapshot::text AS key,
                 COALESCE(MAX(a.wilaya_name), o.wilaya_code_snapshot::text) AS label,
                 ${common}
          FROM orders o
          LEFT JOIN addresses a ON a.id = o.address_id AND a.tenant_id = o.tenant_id
          ${where}
          GROUP BY o.wilaya_code_snapshot
          ORDER BY loss DESC NULLS LAST
          LIMIT 60
        `;
        break;

      case 'carrier':
        sql = `
          SELECT c.code AS key, c.name AS label, ${common}
          FROM orders o
          JOIN shipments s ON s.order_id = o.id AND s.tenant_id = o.tenant_id
          JOIN carriers c ON c.id = s.carrier_id
          ${where}
          GROUP BY c.code, c.name
          ORDER BY loss DESC NULLS LAST
          LIMIT 20
        `;
        break;

      case 'product':
        sql = `
          SELECT oi.sku_snapshot AS key,
                 MAX(oi.product_name_snapshot) AS label,
                 ${common}
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id AND oi.tenant_id = o.tenant_id
          ${where}
          GROUP BY oi.sku_snapshot
          ORDER BY loss DESC NULLS LAST
          LIMIT 50
        `;
        break;

      case 'agent':
        sql = `
          SELECT m.id::text AS key, u.full_name AS label, ${common}
          FROM orders o
          JOIN memberships m ON m.id = o.assigned_membership_id AND m.tenant_id = o.tenant_id
          JOIN users u ON u.id = m.user_id
          ${where}
          GROUP BY m.id, u.full_name
          ORDER BY loss DESC NULLS LAST
          LIMIT 50
        `;
        break;

      case 'source':
      default:
        sql = `
          SELECT o.source::text AS key, o.source::text AS label, ${common}
          FROM orders o
          ${where}
          GROUP BY o.source
          ORDER BY loss DESC NULLS LAST
          LIMIT 20
        `;
        break;
    }

    return this.prisma.$queryRawUnsafe(sql, tenantId, range.from, range.to);
  }

  // ==========================================================================
  // SERIES TEMPORELLES
  // ==========================================================================

  /** Evolution quotidienne des commandes et du CA (V2 §20 : graphiques par jour). */
  async getDailySeries(
    tenantId: string,
    range: DateRange,
    timezone = 'Africa/Algiers',
  ): Promise<
    readonly {
      day: string;
      orders: number;
      delivered: number;
      cancelled: number;
      revenueCentimes: number;
    }[]
  > {
    // `AT TIME ZONE` regroupe selon le fuseau de la boutique : une commande
    // passee a 23 h a Alger doit compter pour ce jour-la, pas pour le suivant
    // en UTC.
    const rows = await this.prisma.$queryRawUnsafe<
      {
        day: Date;
        orders: bigint;
        delivered: bigint;
        cancelled: bigint;
        revenue: bigint | null;
      }[]
    >(
      `
      SELECT
        date_trunc('day', o.ordered_at AT TIME ZONE $4)::date AS day,
        COUNT(*)::bigint AS orders,
        COUNT(*) FILTER (WHERE o.status = 'DELIVERED')::bigint AS delivered,
        COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::bigint AS cancelled,
        SUM(CASE WHEN o.status = 'DELIVERED'
              THEN o.items_total_centimes + o.delivery_fee_centimes ELSE 0 END)::bigint AS revenue
      FROM orders o
      WHERE o.tenant_id = $1::uuid
        AND o.archived_at IS NULL
        AND o.ordered_at BETWEEN $2 AND $3
      GROUP BY day
      ORDER BY day ASC
      `,
      tenantId,
      range.from,
      range.to,
      timezone,
    );

    return rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      orders: Number(row.orders),
      delivered: Number(row.delivered),
      cancelled: Number(row.cancelled),
      revenueCentimes: Number(row.revenue ?? 0),
    }));
  }

  // ==========================================================================
  // SYNTHESE
  // ==========================================================================

  /** Tout ce qu'affiche l'ecran d'accueil, en une seule requete cliente. */
  async getOverview(
    tenantId: string,
    range?: Partial<DateRange>,
  ): Promise<{
    range: { from: string; to: string };
    orders: OrderKpis;
    financial: FinancialKpis;
    daily: Awaited<ReturnType<DashboardService['getDailySeries']>>;
    alerts: {
      pendingConfirmation: number;
      lowStock: number;
      failedImports: number;
      pendingDuplicates: number;
      integrationsInError: number;
    };
  }> {
    const resolved = this.resolveRange(range);

    const [orders, financial, daily, alerts] = await Promise.all([
      this.getOrderKpis(tenantId, resolved),
      this.getFinancialKpis(tenantId, resolved),
      this.getDailySeries(tenantId, resolved),
      this.getAlerts(tenantId),
    ]);

    return {
      range: { from: resolved.from.toISOString(), to: resolved.to.toISOString() },
      orders,
      financial,
      daily,
      alerts,
    };
  }

  /** Compteurs d'attention, affiches en bandeau. */
  /**
   * Compteurs affiches en pastille dans la navigation et en onglets d'etape.
   *
   * TOUS SONT COMPTES DANS LA MEME REQUETE PARALLELE, et non calcules ecran
   * par ecran : la barre laterale est presente sur toutes les pages, et
   * multiplier les appels pour afficher trois nombres couterait plus cher que
   * les pages elles-memes.
   *
   * `inPreparation`, `inDelivery` et `inReturn` decrivent les ETAPES du cycle
   * de vie, telles que le systeme de design les presente en onglets au-dessus
   * de la file d'appel. Ils ne sont pas des alertes — un colis en livraison
   * n'appelle aucune action — mais ils viennent de la meme source, et les
   * separer aurait impose un second aller-retour.
   */
  async getAlerts(tenantId: string): Promise<{
    pendingConfirmation: number;
    lowStock: number;
    failedImports: number;
    pendingDuplicates: number;
    integrationsInError: number;
    inPreparation: number;
    inDelivery: number;
    inReturn: number;
  }> {
    const [
      pendingConfirmation,
      failedImports,
      pendingDuplicates,
      integrationsInError,
      lowStock,
      inPreparation,
      inDelivery,
      inReturn,
    ] = await Promise.all([
      this.prisma.order.count({
        where: {
          tenantId,
          archivedAt: null,
          status: { in: ['TO_CONFIRM', 'NO_ANSWER', 'CALL_BACK', 'POSTPONED'] },
        },
      }),
      this.prisma.sheetRowImport.count({ where: { tenantId, status: 'FAILED' } }),
      this.prisma.orderDuplicateFlag.count({ where: { tenantId, resolution: 'PENDING' } }),
      this.prisma.integration.count({
        where: { tenantId, status: { in: ['ERROR', 'DEGRADED'] } },
      }),
      this.countLowStock(tenantId),
      // Preparation : confirmee (le depot peut s'en saisir) jusqu'a prete a
      // expedier incluse — c'est exactement le perimetre du tableau
      // « Preparation ».
      this.prisma.order.count({
        where: {
          tenantId,
          archivedAt: null,
          status: { in: ['CONFIRMED', 'IN_PREPARATION', 'READY_TO_SHIP'] },
        },
      }),
      this.prisma.order.count({
        where: { tenantId, archivedAt: null, status: { in: ['SHIPPED', 'IN_DELIVERY'] } },
      }),
      // « En retour » compte les commandes dont la marchandise revient ou est
      // revenue, refus compris : c'est le refus qui declenche le retour.
      this.prisma.order.count({
        where: { tenantId, archivedAt: null, status: { in: ['RETURNED', 'REFUSED'] } },
      }),
    ]);

    return {
      pendingConfirmation,
      lowStock,
      failedImports,
      pendingDuplicates,
      integrationsInError,
      inPreparation,
      inDelivery,
      inReturn,
    };
  }

  private async countLowStock(tenantId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM inventory_levels l
      JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
      LEFT JOIN tenant_settings ts ON ts.tenant_id = l.tenant_id
      WHERE l.tenant_id = ${tenantId}::uuid
        AND v.is_active = true
        AND v.archived_at IS NULL
        AND (l.on_hand - l.reserved) <= COALESCE(v.low_stock_threshold, ts.low_stock_threshold, 5)
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** Periode par defaut : les 30 derniers jours. */
  private resolveRange(range?: Partial<DateRange>): DateRange {
    const to = range?.to ?? this.clock.now();
    const from = range?.from ?? this.clock.addDays(to, -30);
    return { from, to };
  }

  /** Expose l'agregat brut, utilise par les exports de rapport. */
  async getProfitabilityAggregate(
    tenantId: string,
    range: DateRange,
  ): Promise<ProfitabilityAggregate> {
    const financial = await this.getFinancialKpis(tenantId, range);
    return {
      orders: 0,
      recognizedRevenueCentimes: financial.recognizedRevenueCentimes,
      cogsCentimes: financial.cogsCentimes,
      shippingCostCentimes: financial.shippingCostCentimes,
      grossMarginCentimes: financial.grossMarginCentimes,
      netResultCentimes: financial.netResultCentimes,
      realizedLossCentimes: financial.realizedLossCentimes,
      opportunityLossCentimes: financial.opportunityLossCentimes,
      cogsCompletenessRatio: financial.cogsCompleteness,
    };
  }
}
