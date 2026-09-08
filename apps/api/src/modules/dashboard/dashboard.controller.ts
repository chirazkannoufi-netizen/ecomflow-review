/**
 * API du dashboard et des rapports — familles `/dashboard/*`, `/reports/*`
 * (V2 §28).
 *
 * Le dashboard reste accessible apres expiration de l'essai : consulter ses
 * chiffres n'est pas une operation payante (D-023).
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PERMISSIONS } from '@ecomflow/shared';
import { RequirePermissions, TenantId } from '../../common/decorators';
import { DateRangeQueryDto } from '../../common/dto/query.dto';
import { ClockService } from '../../infra/clock/clock.service';
import { DashboardService } from './dashboard.service';
import { WhatsappFilterService } from '../whatsapp/whatsapp-filter.service';

export class BreakdownQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({
    enum: ['wilaya', 'carrier', 'product', 'agent', 'source'],
    default: 'wilaya',
    description:
      'Axe d analyse. Chaque axe repond a une question : ou la livraison echoue, ' +
      'quel transporteur coute le plus en retours, quel produit est le plus refuse.',
  })
  @IsOptional()
  @IsIn(['wilaya', 'carrier', 'product', 'agent', 'source'])
  dimension?: 'wilaya' | 'carrier' | 'product' | 'agent' | 'source';
}

@ApiTags('Dashboard et rapports')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly whatsappFilter: WhatsappFilterService,
    private readonly clock: ClockService,
  ) {}

  @Get('dashboard/overview')
  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW)
  @ApiOperation({
    summary: 'Synthese du tableau de bord',
    description:
      'KPI operationnels, indicateurs financiers, serie quotidienne et ' +
      'compteurs d alerte, en une seule requete. Periode par defaut : ' +
      'les 30 derniers jours.',
  })
  async overview(@TenantId() tenantId: string, @Query() query: DateRangeQueryDto) {
    return this.dashboard.getOverview(tenantId, { from: query.from, to: query.to });
  }

  @Get('dashboard/kpis')
  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW)
  @ApiOperation({
    summary: 'KPI de commandes et taux',
    description:
      'Taux de confirmation, de livraison, de retour et d annulation. Un taux ' +
      'vaut `null` — et non 0 — quand le denominateur est vide : « aucune ' +
      'donnee » et « 0 % » ne veulent pas dire la meme chose.',
  })
  async kpis(@TenantId() tenantId: string, @Query() query: DateRangeQueryDto) {
    return this.dashboard.getOrderKpis(tenantId, this.resolveRange(query));
  }

  @Get('dashboard/alerts')
  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW)
  @ApiOperation({ summary: 'Compteurs d alerte du bandeau' })
  async alerts(@TenantId() tenantId: string) {
    return this.dashboard.getAlerts(tenantId);
  }

  @Get('dashboard/daily')
  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW)
  @ApiOperation({
    summary: 'Serie quotidienne',
    description:
      'Regroupee selon le fuseau de la boutique : une commande passee a 23 h ' +
      'a Alger compte pour ce jour-la, pas pour le suivant en UTC.',
  })
  async daily(@TenantId() tenantId: string, @Query() query: DateRangeQueryDto) {
    return this.dashboard.getDailySeries(tenantId, this.resolveRange(query));
  }

  // -------------------------------------------------------------------------
  // Pertes & Rentabilite (Addendum §33)
  // -------------------------------------------------------------------------

  @Get('reports/profitability')
  @RequirePermissions(PERMISSIONS.PROFITABILITY_VIEW)
  @ApiOperation({
    summary: 'Indicateurs financiers et rentabilite',
    description:
      'Le chiffre d affaires n est reconnu qu a la LIVRAISON (modele COD). ' +
      'Trois notions distinctes : perte reelle (tresorerie sortie sans ' +
      'contrepartie), manque a gagner (CA non realise) et marge nette. ' +
      '`cogsCompleteness` indique la part des commandes dont le prix d achat ' +
      'est renseigne : en dessous de 1, la marge est partielle.',
  })
  async profitability(@TenantId() tenantId: string, @Query() query: DateRangeQueryDto) {
    return this.dashboard.getFinancialKpis(tenantId, this.resolveRange(query));
  }

  @Get('reports/losses')
  @RequirePermissions(PERMISSIONS.PROFITABILITY_VIEW)
  @ApiOperation({
    summary: 'Ventilation des pertes par axe',
    description:
      'Isole les points de fuite : wilaya, transporteur, produit, agent ou ' +
      'source. Trie par perte decroissante.',
  })
  async losses(@TenantId() tenantId: string, @Query() query: BreakdownQueryDto) {
    return this.dashboard.getLossBreakdown(
      tenantId,
      this.resolveRange(query),
      query.dimension ?? 'wilaya',
    );
  }

  @Get('reports/whatsapp-adoption')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({
    summary: 'Adoption du filtre WhatsApp',
    description:
      'Mesure l impact reel sur la charge du centre d appel : part des ' +
      'commandes confirmees automatiquement, et raisons des transferts ' +
      'vers un agent (Addendum §31).',
  })
  async whatsappAdoption(@TenantId() tenantId: string, @Query() query: DateRangeQueryDto) {
    const range = this.resolveRange(query);
    return this.whatsappFilter.getAdoptionStats(tenantId, range.from, range.to);
  }

  private resolveRange(query: DateRangeQueryDto): { from: Date; to: Date } {
    const to = query.to ?? this.clock.now();
    const from = query.from ?? this.clock.addDays(to, -30);
    return { from, to };
  }
}
