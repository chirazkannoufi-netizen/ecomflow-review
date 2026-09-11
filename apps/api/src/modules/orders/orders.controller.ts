/**
 * API des commandes — famille `/orders/*` (V2 §28).
 *
 * Chaque route declare explicitement :
 *   - les permissions requises (`@RequirePermissions`) ;
 *   - si elle exige un abonnement operationnel
 *     (`@RequiresOperationalSubscription`).
 *
 * La lecture reste accessible apres expiration de l'essai : le commercant doit
 * pouvoir consulter et exporter ses donnees meme sans abonnement (D-023). Seule
 * l'ecriture qui fait AVANCER l'operationnel est bloquee.
 */

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '@ecomflow/shared';
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
import { OrdersService } from './orders.service';
import { OrdersExportService } from './orders-export.service';
import { OrderWorkflowService } from './workflow/order-workflow.service';
import {
  AssignOrderDto,
  ChangeOrderStatusDto,
  CreateOrderDto,
  ListOrdersQueryDto,
  ResolveDuplicateDto,
} from './dto/orders.dto';
import { BulkArchiveDto, PreparationBulkDto } from '../../common/dto/query.dto';

@ApiTags('Commandes')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly workflow: OrderWorkflowService,
    private readonly exports: OrdersExportService,
  ) {}

  // -------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------

  @Get()
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({
    summary: 'Lister les commandes',
    description:
      'Pagination cote serveur. La recherche porte sur la reference, le nom, ' +
      'le telephone (normalise avant recherche), le SKU, le produit, la commune ' +
      'et le numero de suivi.',
  })
  async list(@TenantId() tenantId: string, @Query() query: ListOrdersQueryDto) {
    return this.orders.list(
      tenantId,
      {
        status: query.status,
        source: query.source,
        wilayaCode: query.wilayaCode,
        assignedMembershipId: query.assignedMembershipId,
        carrierId: query.carrierId,
        search: query.search,
        includeArchived: query.includeArchived,
      },
      {
        page: query.page,
        pageSize: query.pageSize,
        sortBy: query.sortBy,
        sortDir: query.sortDir,
      },
    );
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({
    summary: 'Detail d une commande',
    description:
      'Inclut la timeline complete : historique de statut, tentatives d appel, ' +
      'colis et evenements transporteur, retours, doublons signales et fiche ' +
      'client avec son score de fiabilite.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  async getOne(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getById(tenantId, id);
  }

  @Get(':id/transitions')
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({
    summary: 'Actions de statut disponibles',
    description:
      'Filtrees par les droits de l appelant. Sert a afficher les bons boutons ; ' +
      'chaque transition est de toute facon revalidee cote serveur.',
  })
  async transitions(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() context: RequestContext,
  ) {
    return this.workflow.listAvailableTransitions(tenantId, id, context.permissions);
  }

  // -------------------------------------------------------------------------
  // Ecriture
  // -------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.ORDERS_CREATE)
  @RequiresOperationalSubscription()
  @Idempotent('order_create')
  @Audited({ action: 'ORDER_CREATED', entityType: 'Order' })
  @ApiOperation({
    summary: 'Creer une commande manuellement',
    description:
      'Le client est retrouve par son telephone normalise, ou cree. La commande ' +
      'entre immediatement dans la file de confirmation, et les doublons ' +
      'potentiels sont signales sans jamais etre supprimes.',
  })
  async create(
    @TenantId() tenantId: string,
    @CurrentMembershipId() membershipId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.createOrder({
      tenantId,
      // `MANUAL` a defaut : une commande saisie sans provenance declaree reste
      // une saisie manuelle, ce qu'elle etait avant que le menu existe.
      source: dto.source ?? 'MANUAL',
      customerName: dto.customerName,
      phone: dto.phone,
      wilaya: dto.wilaya,
      commune: dto.commune,
      addressText: dto.addressText,
      lines: dto.lines,
      deliveryFeeCentimes: dto.deliveryFeeCentimes,
      notes: dto.notes ?? null,
      assignedMembershipId: dto.assignedMembershipId ?? null,
      createdByMembershipId: membershipId,
    });
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORDERS_CHANGE_STATUS)
  @RequiresOperationalSubscription()
  @Audited({ action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityIdParam: 'id' })
  @ApiOperation({
    summary: 'Changer le statut d une commande',
    description:
      'Applique une transition du workflow, avec ses effets metier : stock, ' +
      'dates, historique, compteurs client. Une transition non declaree ou dont ' +
      'une garde echoue est refusee avec un motif precis.',
  })
  @ApiConflictResponse({ description: 'Transition interdite ou garde metier non satisfaite.' })
  async changeStatus(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeOrderStatusDto,
    @Ctx() context: RequestContext,
  ) {
    return this.workflow.transition({
      tenantId,
      orderId: id,
      to: dto.status,
      actorKind: 'USER',
      membershipId: context.membershipId,
      permissions: context.permissions,
      reason: dto.reason ?? null,
      note: dto.note ?? null,
      source: 'ui',
    });
  }

  @Patch(':id/assign')
  @RequirePermissions(PERMISSIONS.ORDERS_ASSIGN)
  @ApiOperation({ summary: 'Affecter la commande a un membre' })
  @ApiOkResponse({ description: 'Affectation enregistree.' })
  async assign(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignOrderDto,
  ) {
    await this.orders.assign(tenantId, id, dto.membershipId ?? null);
    return { acknowledged: true as const };
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ORDERS_DELETE)
  @Audited({ action: 'ORDER_ARCHIVED', entityType: 'Order', entityIdParam: 'id' })
  @ApiOperation({
    summary: 'Archiver une commande',
    description:
      'Suppression LOGIQUE : la commande disparait des listes et des KPI mais ' +
      'reste consultable. L historique metier n est jamais detruit. Une commande ' +
      'dont le stock est encore reserve doit d abord etre annulee.',
  })
  async archive(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMembershipId() membershipId: string,
  ): Promise<void> {
    await this.orders.archive(tenantId, id, membershipId);
  }

  @Post(':id/mark-ready')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PREPARATION_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Declarer un colis pret a expedier',
    description:
      'Enregistre les lignes comme preparees, PUIS bascule le statut. La ' +
      'transition est gardee par `REQUIRE_PREPARATION_COMPLETED`, qui exige ' +
      '`preparedQuantity` sur chaque ligne — un champ qu aucun code n ecrivait, ' +
      'ce qui rendait le bouton « Colis pret » systematiquement refuse. ' +
      'Declarer un colis pret EST l affirmation que les lignes y sont : elle ' +
      'est desormais enregistree, et la garde la verifie au lieu de la ' +
      'supposer. Une commande encore CONFIRMEE passe d abord par la ' +
      'preparation, sans raccourci.',
  })
  async markReady(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() context: RequestContext,
  ) {
    await this.orders.markPreparationReady(
      tenantId,
      id,
      context.membershipId as string,
      context.permissions,
    );
    return { acknowledged: true as const };
  }

  @Post('export.xlsx')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORDERS_EXPORT)
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @Header('Content-Disposition', 'attachment; filename="ecomflow-export.xlsx"')
  @ApiOperation({
    summary: 'Exporter une selection de commandes en Excel',
    description:
      'POST et non GET : la selection peut compter deux cents identifiants, ' +
      'qui ne tiennent pas dans une URL. Les montants sortent en DINARS — le ' +
      'produit stocke des centimes, mais un classeur est lu par un humain.',
  })
  async exportXlsx(
    @TenantId() tenantId: string,
    @Body() dto: BulkArchiveDto,
  ): Promise<StreamableFile> {
    return new StreamableFile(await this.exports.buildXlsx(tenantId, dto.ids));
  }

  @Post('bulk-preparation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PREPARATION_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Action groupee sur une selection de l ecran de preparation',
    description:
      'Chaque ligne passe par le MOTEUR DE WORKFLOW, comme un clic unitaire : ' +
      'le lot n est pas un chemin derobe vers un etat qu une action unitaire ' +
      'n aurait pas permis. `MARK_READY` enchaine les deux transitions legales ' +
      'quand la commande part de CONFIRMEE, au lieu de sauter l etape. ' +
      '`CANCEL_AND_ARCHIVE` annule d abord — l archivage est refuse tant que le ' +
      'stock est reserve. Le resultat detaille ce qui n est pas passe, et ' +
      'pourquoi.',
  })
  async bulkPreparation(
    @TenantId() tenantId: string,
    @Body() dto: PreparationBulkDto,
    @Ctx() context: RequestContext,
  ) {
    return this.orders.bulkPreparationAction({
      tenantId,
      action: dto.action,
      orderIds: dto.ids,
      membershipId: context.membershipId as string,
      permissions: context.permissions,
      reason: dto.reason,
    });
  }

  @Post('bulk-archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORDERS_DELETE)
  @Audited({ action: 'ORDER_ARCHIVED', entityType: 'Order' })
  @ApiOperation({
    summary: 'Archiver une selection de commandes',
    description:
      'Suppression LOGIQUE, ligne par ligne. Le resultat detaille ce qui n a ' +
      'PAS ete archive et pourquoi — typiquement une commande dont le stock ' +
      'est encore reserve. Une selection partiellement traitee est le cas ' +
      'normal, pas une anomalie.',
  })
  async bulkArchive(
    @TenantId() tenantId: string,
    @Body() dto: BulkArchiveDto,
    @CurrentMembershipId() membershipId: string,
  ) {
    return this.orders.archiveMany(tenantId, dto.ids, membershipId);
  }

  // -------------------------------------------------------------------------
  // Doublons
  // -------------------------------------------------------------------------

  @Post('duplicates/:flagId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORDERS_MERGE_DUPLICATES)
  @Audited({ action: 'ORDER_DUPLICATE_RESOLVED', entityType: 'OrderDuplicateFlag' })
  @ApiOperation({
    summary: 'Trancher un signalement de doublon',
    description:
      'EcomFlow signale, l utilisateur decide : conserver les deux, fusionner, ' +
      'ou constater que le doublon a ete annule. Aucune commande n est jamais ' +
      'supprimee automatiquement.',
  })
  async resolveDuplicate(
    @TenantId() tenantId: string,
    @Param('flagId', ParseUUIDPipe) flagId: string,
    @Body() dto: ResolveDuplicateDto,
    @CurrentMembershipId() membershipId: string,
  ) {
    await this.orders.resolveDuplicateFlag(tenantId, flagId, dto.resolution, membershipId);
    return { acknowledged: true as const };
  }
}
