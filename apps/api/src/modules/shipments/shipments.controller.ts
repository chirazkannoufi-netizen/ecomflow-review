/**
 * API d'expedition, de suivi et de retours — familles `/shipments/*`,
 * `/tracking/*`, `/returns/*` (V2 §28).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BulkArchiveDto } from '../../common/dto/query.dto';
import {
  CARRIER_ACCOUNT_KINDS,
  PERMISSIONS,
  PRODUCT_CONDITIONS,
  RETURN_REASONS,
  SHIPMENT_STATUSES,
  WILAYA_COUNT,
  type CarrierAccountKind,
} from '@ecomflow/shared';
import {
  Audited,
  Ctx,
  CurrentMembershipId,
  Idempotent,
  RequirePermissions,
  RequiresOperationalSubscription,
  TenantId,
} from '../../common/decorators';
import type { RequestContext } from '../../infra/context/request-context';
import { PaginationQueryDto, toStringArray } from '../../common/dto/query.dto';
import { ReturnsService } from '../returns/returns.service';
import { CarrierRegistry } from './carriers/carrier.registry';
import { ShipmentsService } from './shipments.service';
import { TrackingService } from './tracking.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateShipmentDto {
  @ApiPropertyOptional({
    description: 'Compte transporteur. A defaut, celui par defaut de la boutique.',
  })
  @IsOptional()
  @IsUUID('7')
  carrierAccountId?: string;

  @ApiPropertyOptional({ enum: ['HOME', 'PICKUP_POINT'], default: 'HOME' })
  @IsOptional()
  @IsIn(['HOME', 'PICKUP_POINT'])
  deliveryType?: 'HOME' | 'PICKUP_POINT';

  @ApiPropertyOptional({ description: 'Point relais, requis si deliveryType=PICKUP_POINT.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  pickupPointId?: string;

  @ApiPropertyOptional({ description: 'Poids du colis en grammes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  weightGrams?: number;

  @ApiPropertyOptional({ description: 'Consignes pour le livreur.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Le client peut-il ouvrir le colis avant paiement ?',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  allowOpening?: boolean;
}

export class CancelShipmentDto {
  @ApiProperty({ description: 'Motif d annulation, transmis a l historique.' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Un motif est obligatoire pour annuler un colis.' })
  @MaxLength(500)
  reason!: string;
}

export class ReturnLineDto {
  @ApiProperty()
  @IsUUID('7')
  orderItemId!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateReturnDto {
  @ApiProperty({ enum: RETURN_REASONS })
  @IsIn([...RETURN_REASONS])
  reason!: (typeof RETURN_REASONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reasonDetail?: string;

  @ApiPropertyOptional({ description: 'Cout du retour facture par le transporteur, en centimes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  returnCostCentimes?: number;

  @ApiPropertyOptional({
    type: [ReturnLineDto],
    description: 'Lignes retournees. A defaut, toute la commande.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items?: ReturnLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class InspectLineDto {
  @ApiProperty()
  @IsUUID('7')
  returnItemId!: string;

  @ApiProperty({ enum: PRODUCT_CONDITIONS })
  @IsIn([...PRODUCT_CONDITIONS])
  condition!: (typeof PRODUCT_CONDITIONS)[number];

  @ApiProperty({
    enum: ['RESTOCK', 'QUARANTINE', 'WRITE_OFF'],
    description:
      'RESTOCK remet en vente, QUARANTINE place en stock a verifier, ' +
      'WRITE_OFF constate la perte (impactee dans la rentabilite).',
  })
  @IsIn(['RESTOCK', 'QUARANTINE', 'WRITE_OFF'])
  stockDecision!: 'RESTOCK' | 'QUARANTINE' | 'WRITE_OFF';
}

export class InspectReturnDto {
  @ApiProperty({ type: [InspectLineDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InspectLineDto)
  lines!: InspectLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Cout reel du retour, en centimes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  returnCostCentimes?: number;
}

export class ListShipmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    isArray: true,
    enum: SHIPMENT_STATUSES,
    description: 'Statuts internes, separes par des virgules.',
  })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn([...SHIPMENT_STATUSES], { each: true })
  status?: (typeof SHIPMENT_STATUSES)[number][];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('7')
  carrierId?: string;

  @ApiPropertyOptional({ description: 'Numero de suivi, reference de commande ou nom du client.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class DeliveryQueueQueryDto extends PaginationQueryDto {
  @ApiProperty({ enum: ['IN_DELIVERY', 'DELIVERED'] })
  @IsIn(['IN_DELIVERY', 'DELIVERED'])
  stage!: 'IN_DELIVERY' | 'DELIVERED';

  @ApiPropertyOptional({ minimum: 1, maximum: WILAYA_COUNT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WILAYA_COUNT)
  wilayaCode?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('7')
  carrierAccountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class AssignCarrierDto extends BulkArchiveDto {
  @ApiProperty({ description: 'Compte transporteur a affecter a la selection.' })
  @IsUUID('7')
  carrierAccountId!: string;
}

export class BulkShipDto extends BulkArchiveDto {
  @ApiPropertyOptional({
    description:
      'Compte transporteur a utiliser. A defaut, celui par defaut de la boutique.',
  })
  @IsOptional()
  @IsUUID('7')
  carrierAccountId?: string;
}

export class SetCarrierCoverageDto {
  @ApiProperty({ minimum: 1, maximum: WILAYA_COUNT, description: 'Code wilaya, 1 a 58.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WILAYA_COUNT)
  wilayaCode!: number;

  @ApiProperty({ description: 'Livraison a domicile desservie.' })
  @IsBoolean()
  homeDelivery!: boolean;

  @ApiProperty({ description: 'Retrait au bureau du transporteur desservi.' })
  @IsBoolean()
  pickupPoint!: boolean;

  @ApiPropertyOptional({ minimum: 0, description: 'Delai indicatif en jours.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  leadTimeDays?: number;
}

export class UpdateCarrierAccountSettingsDto {
  @ApiPropertyOptional({
    enum: CARRIER_ACCOUNT_KINDS,
    description: 'Agent de livraison independant, ou societe de livraison.',
  })
  @IsOptional()
  @IsIn(CARRIER_ACCOUNT_KINDS)
  kind?: CarrierAccountKind;

  @ApiPropertyOptional({
    description:
      'Transmettre le numero de commande de la source plutot que la reference ' +
      'EcomFlow. Sans numero externe, la reference reste envoyee.',
  })
  @IsOptional()
  @IsBoolean()
  sendOrderNumberInsteadOfReference?: boolean;

  @ApiPropertyOptional({ description: 'Le transporteur detient le stock de la boutique.' })
  @IsOptional()
  @IsBoolean()
  stockHeldByCourier?: boolean;
}

@ApiTags('Expedition, suivi et retours')
@ApiBearerAuth()
@Controller()
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly tracking: TrackingService,
    private readonly returns: ReturnsService,
    private readonly registry: CarrierRegistry,
  ) {}

  // -------------------------------------------------------------------------
  // Transporteurs
  // -------------------------------------------------------------------------

  @Get('carriers')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({
    summary: 'Connecteurs transporteurs disponibles',
    description:
      'Liste les connecteurs REELLEMENT implementes, avec les champs ' +
      'd identifiants qu ils attendent. Un transporteur planifie mais non ' +
      'implemente n y figure pas : le produit ne promet que ce qu il tient.',
  })
  listCarriers() {
    return this.registry.describeAll();
  }

  @Get('delivery-queue')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({
    summary: 'Commandes en livraison ou livrees',
    description:
      'Deux etapes du meme flux, distinguees par `stage`. Chaque ligne porte ' +
      'son etat d ENCAISSEMENT, calcule en croisant le colis et la capacite du ' +
      'transporteur : un montant absent ne veut pas dire « impaye », il peut ' +
      'vouloir dire « ce transporteur ne publie pas cette donnee ». Les deux ' +
      'sont distingues, parce que l un est une creance et l autre une ' +
      'ignorance. Les tentatives ECHOUEES sont comptees une par une, jamais ' +
      'ecrasees par le dernier evenement.',
  })
  async deliveryQueue(
    @TenantId() tenantId: string,
    @Query() query: DeliveryQueueQueryDto,
  ) {
    return this.shipments.listDeliveryQueue(
      tenantId,
      {
        stage: query.stage,
        wilayaCode: query.wilayaCode,
        carrierAccountId: query.carrierAccountId,
        search: query.search,
      },
      { page: query.page, pageSize: query.pageSize },
    );
  }

  @Get('carrier-catalogue')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({
    summary: 'Transporteurs et matrice de capacites',
    description:
      'Contrairement a `/carriers`, cette vue inclut les transporteurs ' +
      'planifies : le commercant doit pouvoir voir que son transporteur ' +
      'habituel arrive, plutot que de le redemander. `capabilities: null` ' +
      'signifie « non renseignees », a ne pas confondre avec « aucune ».',
  })
  async carrierCatalogue() {
    return this.shipments.listCarrierCatalogue();
  }

  @Get('carriers/:carrierId/coverage')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({
    summary: 'Couverture declaree d un transporteur, wilaya par wilaya',
    description:
      'Une wilaya absente signifie « couverture inconnue », pas « non ' +
      'desservie » : tant que le tableau n est pas rempli, rien n est affirme.',
  })
  async carrierCoverage(@Param('carrierId', ParseUUIDPipe) carrierId: string) {
    return this.shipments.listCarrierCoverage(carrierId);
  }

  @Put('carriers/:carrierId/coverage')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  @ApiOperation({
    summary: 'Declarer la couverture d une wilaya',
    description:
      'Decocher les deux modes SUPPRIME la ligne : l absence de ligne porte ' +
      'deja le sens « couverture inconnue », et deux facons d ecrire la meme ' +
      'chose finiraient par se contredire.',
  })
  async setCarrierCoverage(
    @Param('carrierId', ParseUUIDPipe) carrierId: string,
    @Body() dto: SetCarrierCoverageDto,
  ) {
    await this.shipments.setCarrierCoverage(carrierId, dto);
    return { acknowledged: true as const };
  }

  @Patch('carrier-accounts/:id/settings')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  @ApiOperation({
    summary: 'Reglages d exploitation d un compte transporteur',
    description:
      'Nature du compte (agent ou societe), reference envoyee au ' +
      'transporteur, et detention du stock. Ce sont des arrangements entre ' +
      'CETTE boutique et son transporteur, pas des proprietes du reseau.',
  })
  async updateAccountSettings(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCarrierAccountSettingsDto,
  ) {
    await this.shipments.updateCarrierAccountSettings(tenantId, id, dto);
    return { acknowledged: true as const };
  }

  @Get('carrier-accounts')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({ summary: 'Comptes transporteur configures pour la boutique' })
  async listAccounts(@TenantId() tenantId: string) {
    return this.shipments.listCarrierAccounts(tenantId);
  }

  @Post('carrier-accounts/:id/health-check')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary: 'Verifier qu un compte transporteur repond',
    description: 'Valide les identifiants sans creer aucun colis.',
  })
  async healthCheck(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.checkCarrierHealth(tenantId, id);
  }

  // -------------------------------------------------------------------------
  // Expedition
  // -------------------------------------------------------------------------

  @Post('orders/:orderId/ship')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.SHIPMENTS_CREATE)
  @RequiresOperationalSubscription()
  @Idempotent('shipment_create')
  @Audited({ action: 'SHIPMENT_CREATED', entityType: 'Order', entityIdParam: 'orderId' })
  @ApiOperation({
    summary: 'Confier une commande au transporteur',
    description:
      'Cree le colis chez le transporteur et passe la commande a EXPEDIEE. ' +
      'Un appel rejoue retourne le colis existant au lieu d en creer un second : ' +
      'trois barrieres independantes l en empechent (V2 §17).',
  })
  async ship(
    @TenantId() tenantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateShipmentDto,
    @Ctx() context: RequestContext,
  ) {
    return this.shipments.createShipment({
      tenantId,
      orderId,
      carrierAccountId: dto.carrierAccountId,
      membershipId: context.membershipId as string,
      permissions: context.permissions,
      deliveryType: dto.deliveryType,
      pickupPointId: dto.pickupPointId ?? null,
      weightGrams: dto.weightGrams ?? null,
      notes: dto.notes ?? null,
      allowOpening: dto.allowOpening,
    });
  }

  @Post('orders/bulk-dispatch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHIPMENTS_CREATE, PERMISSIONS.PREPARATION_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Dispatcher une selection : de confirmee a expediee, en un geste',
    description:
      'Enchaine la mise en preparation, l enregistrement des lignes preparees ' +
      'et la creation du colis. Le garde `REQUIRE_PREPARATION_COMPLETED` reste ' +
      'ACTIF : cocher des lignes puis dispatcher EST l affirmation qu elles ' +
      'sont pretes, et cette affirmation est enregistree avant d etre ' +
      'verifiee — pas contournee. Une commande sans transporteur choisi est ' +
      'refusee, au lieu de retomber sur le compte par defaut de la boutique.',
  })
  async bulkDispatch(
    @TenantId() tenantId: string,
    @Body() dto: BulkArchiveDto,
    @Ctx() context: RequestContext,
  ) {
    return this.shipments.dispatchOrders({
      tenantId,
      orderIds: dto.ids,
      membershipId: context.membershipId as string,
      permissions: context.permissions,
    });
  }

  @Post('orders/bulk-assign-carrier')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHIPMENTS_CREATE)
  @ApiOperation({
    summary: 'Affecter un transporteur a une selection',
    description:
      'Enregistre une INTENTION, revisable tant que le colis n existe pas. ' +
      'Une commande deja partie garde le transporteur de son colis : changer ' +
      'l intention apres coup ne deplacerait aucun paquet et ferait mentir ' +
      'l ecran.',
  })
  async bulkAssignCarrier(
    @TenantId() tenantId: string,
    @Body() dto: AssignCarrierDto,
  ) {
    return this.shipments.assignCarrierAccount({
      tenantId,
      orderIds: dto.ids,
      carrierAccountId: dto.carrierAccountId,
    });
  }

  @Post('orders/bulk-ship')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHIPMENTS_CREATE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Expedier une selection de commandes pretes',
    description:
      'Les colis sont crees UN PAR UN chez le transporteur : les lancer en ' +
      'parallele ferait tomber son quota, et un compte bloque coute une ' +
      'journee la ou vingt appels sequentiels coutent quelques secondes. ' +
      'L appel est idempotent, un lot relance ne duplique aucun colis.',
  })
  async bulkShip(
    @TenantId() tenantId: string,
    @Body() dto: BulkShipDto,
    @Ctx() context: RequestContext,
  ) {
    return this.shipments.createShipmentsBulk({
      tenantId,
      orderIds: dto.ids,
      carrierAccountId: dto.carrierAccountId,
      membershipId: context.membershipId as string,
      permissions: context.permissions,
    });
  }

  @Get('orders/:orderId/shipments')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({ summary: 'Colis d une commande' })
  async listByOrder(
    @TenantId() tenantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.shipments.listByOrder(tenantId, orderId);
  }

  @Get('shipments')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({
    summary: 'Lister les colis de la boutique',
    description:
      'Suivi transverse, independant des commandes. Le dernier evenement ' +
      'connu et la date de derniere synchronisation accompagnent chaque colis : ' +
      'un colis sans nouvelle depuis longtemps est un colis a verifier.',
  })
  async listShipments(@TenantId() tenantId: string, @Query() query: ListShipmentsQueryDto) {
    return this.shipments.list(
      tenantId,
      { status: query.status, carrierId: query.carrierId, search: query.search },
      { page: query.page, pageSize: query.pageSize },
    );
  }

  @Get('shipments/:id')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({ summary: 'Detail d un colis et de ses evenements' })
  async getShipment(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.getShipment(tenantId, id);
  }

  @Post('shipments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHIPMENTS_CANCEL)
  @Audited({ action: 'SHIPMENT_CANCELLED', entityType: 'Shipment', entityIdParam: 'id' })
  @ApiOperation({
    summary: 'Annuler un colis',
    description:
      'Annule chez le transporteur puis localement. Un colis deja livre ou ' +
      'retourne ne peut plus etre annule.',
  })
  async cancelShipment(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelShipmentDto,
  ) {
    return this.shipments.cancelShipment(tenantId, id, dto.reason);
  }

  // -------------------------------------------------------------------------
  // Suivi
  // -------------------------------------------------------------------------

  @Post('shipments/:id/sync-tracking')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHIPMENTS_TRACK)
  @ApiOperation({
    summary: 'Forcer une synchronisation du suivi',
    description:
      'Interroge le transporteur et applique les nouveaux evenements. Les ' +
      'evenements deja connus sont ignores : rejouer est sans effet.',
  })
  async syncTracking(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tracking.pollShipment(tenantId, id);
  }

  @Get('shipments/:id/tracking')
  @RequirePermissions(PERMISSIONS.SHIPMENTS_READ)
  @ApiOperation({
    summary: 'Evenements de suivi d un colis',
    description:
      'Conserve le statut BRUT du transporteur et le statut normalise ' +
      'EcomFlow : le premier sert au diagnostic, le second au metier.',
  })
  async trackingEvents(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    const shipment = await this.shipments.getShipment(tenantId, id);
    return {
      trackingNumber: shipment.trackingNumber,
      carrier: shipment.carrier,
      status: shipment.status,
      providerStatus: shipment.providerStatus,
      lastSyncedAt: shipment.lastSyncedAt,
      events: shipment.events,
    };
  }

  // -------------------------------------------------------------------------
  // Retours
  // -------------------------------------------------------------------------

  @Get('returns')
  @RequirePermissions(PERMISSIONS.RETURNS_READ)
  @ApiOperation({ summary: 'Lister les retours' })
  async listReturns(
    @TenantId() tenantId: string,
    @Query('status') status?: string,
    @Query('reason') reason?: string,
  ) {
    return this.returns.list(tenantId, {
      status: status ? status.split(',') : undefined,
      reason: reason ? (reason.split(',') as never[]) : undefined,
    });
  }

  @Get('returns/:id')
  @RequirePermissions(PERMISSIONS.RETURNS_READ)
  @ApiOperation({ summary: 'Detail d un retour' })
  async getReturn(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.returns.getById(tenantId, id);
  }

  @Post('orders/:orderId/returns')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.RETURNS_MANAGE)
  @Audited({ action: 'RETURN_CREATED', entityType: 'Order', entityIdParam: 'orderId' })
  @ApiOperation({
    summary: 'Creer un retour',
    description:
      'Le retour reste rattache a sa commande d origine. Aucun mouvement de ' +
      'stock n a lieu ici : la marchandise n est pas encore revenue.',
  })
  async createReturn(
    @TenantId() tenantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateReturnDto,
    @CurrentMembershipId() membershipId: string,
  ) {
    return this.returns.createReturn({
      tenantId,
      orderId,
      reason: dto.reason,
      reasonDetail: dto.reasonDetail ?? null,
      membershipId,
      returnCostCentimes: dto.returnCostCentimes,
      items: dto.items,
      notes: dto.notes ?? null,
    });
  }

  @Post('returns/:id/in-transit')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.RETURNS_MANAGE)
  @ApiOperation({ summary: 'Marquer le retour comme reparti chez le transporteur' })
  async markInTransit(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.returns.markInTransit(tenantId, id);
  }

  @Post('returns/:id/received')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.RETURNS_MANAGE)
  @ApiOperation({ summary: 'Marquer le colis retour comme physiquement recu' })
  async markReceived(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.returns.markReceived(tenantId, id);
  }

  @Post('returns/:id/inspect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.RETURNS_MANAGE, PERMISSIONS.INVENTORY_MANAGE)
  @Audited({ action: 'RETURN_RESOLVED', entityType: 'Return', entityIdParam: 'id' })
  @ApiOperation({
    summary: 'Inspecter un retour et decider du sort du stock',
    description:
      'C est ICI, et seulement ici, que le stock bouge. Chaque ligne recoit ' +
      'son etat et sa decision. Une inspection rejouee ne double jamais le stock.',
  })
  async inspect(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InspectReturnDto,
    @CurrentMembershipId() membershipId: string,
  ) {
    return this.returns.inspect({
      tenantId,
      returnId: id,
      membershipId,
      lines: dto.lines,
      notes: dto.notes ?? null,
      returnCostCentimes: dto.returnCostCentimes,
    });
  }

  @Post('returns/:id/close')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.RETURNS_MANAGE)
  @ApiOperation({
    summary: 'Cloturer un retour',
    description: 'Refuse tant que toutes les lignes n ont pas ete inspectees.',
  })
  async closeReturn(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.returns.close(tenantId, id);
  }

  @Post('returns/:id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.RETURNS_MANAGE)
  @ApiOperation({
    summary: 'Annuler un retour cree par erreur',
    description:
      'Impossible si des mouvements de stock ont deja ete appliques : ' +
      'les defaire casserait la piste d audit. Passer alors par un ajustement.',
  })
  async cancelReturn(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelShipmentDto,
  ): Promise<void> {
    await this.returns.cancel(tenantId, id, dto.reason);
  }
}
