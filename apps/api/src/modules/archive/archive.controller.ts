/**
 * Corbeille de la boutique.
 *
 * DEUX REGIMES DE PERMISSION, ET LA LIGNE PASSE ENTRE VOIR ET EFFACER
 *   CONSULTER la corbeille demande `ORDERS_READ` : savoir ce qu'on a mis de
 *   cote fait partie du travail courant, et le cacher pousserait a recreer ce
 *   qui existe deja.
 *
 *   EFFACER demande `DATA_PURGE`, que seul le proprietaire possede
 *   (`ADMIN_EXCLUDED`). C'est le seul geste du produit qu'aucune sauvegarde
 *   applicative ne rattrape : il rejoint la gestion de l'abonnement dans ce
 *   qu'un administrateur ne peut pas faire.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PERMISSIONS } from '@ecomflow/shared';
import { Audited, Ctx, RequirePermissions, TenantId } from '../../common/decorators';
import type { RequestContext } from '../../infra/context/request-context';
import { PaginationQueryDto } from '../../common/dto/query.dto';
import { ArchiveService, type ArchivedKind } from './archive.service';

const KINDS = ['ORDER', 'PRODUCT', 'CUSTOMER'] as const;

export class ListArchiveQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsIn(KINDS)
  kind?: ArchivedKind;
}

/**
 * Selection a effacer, separee PAR ENTITE.
 *
 * Un seul tableau d'identifiants aurait impose d'encoder le type dans la chaine
 * (« ORDER:uuid ») et de le redecouper cote serveur : un format invente, non
 * valide, qu'une faute de frappe transformerait en suppression de la mauvaise
 * table.
 */
export class PurgeDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('7', { each: true })
  orders?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('7', { each: true })
  products?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('7', { each: true })
  customers?: string[];
}

@ApiTags('Corbeille')
@ApiBearerAuth()
@Controller('archive')
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({
    summary: 'Lister ce qui a ete archive, toutes entites confondues',
    description:
      'Commandes, produits et clients archives, du plus recent au plus ancien. ' +
      'Jusqu ici, ce qui avait ete retire n etait visible nulle part : une ' +
      'ligne archivee par erreur ne se retrouvait qu en connaissant sa ' +
      'reference.',
  })
  async list(@TenantId() tenantId: string, @Query() query: ListArchiveQueryDto) {
    return this.archive.list(
      tenantId,
      { kind: query.kind },
      { page: query.page, pageSize: query.pageSize },
    );
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @Audited({ action: 'ORDER_UPDATED', entityType: 'Archive' })
  @ApiOperation({
    summary: 'Remettre une selection archivee a son emplacement d origine',
    description:
      'Produits et clients reviennent en levant `archivedAt`. Les commandes ' +
      'aussi — SAUF celles dont le statut est terminal : « Annuler et ' +
      'archiver » fait deux choses, et seule la seconde est reversible. ' +
      '`CANCELLED` figure dans `TERMINAL_ORDER_STATUSES` et un test interdit ' +
      'nommement son retour en file. Ces lignes sont refusees avec leur motif, ' +
      'et signalees non restaurables dans la liste pour que le bouton ne soit ' +
      'pas propose.',
  })
  async restore(
    @TenantId() tenantId: string,
    @Body() dto: PurgeDto,
    @Ctx() context: RequestContext,
  ) {
    return this.archive.restore(
      tenantId,
      { orders: dto.orders, products: dto.products, customers: dto.customers },
      context.membershipId as string,
    );
  }

  @Post('purge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.DATA_PURGE)
  @Audited({ action: 'DATA_PURGED', entityType: 'Archive' })
  @ApiOperation({
    summary: 'Supprimer definitivement une selection archivee',
    description:
      'IRREVERSIBLE, et refuse plus souvent qu il n accepte : les cles ' +
      'etrangeres du schema retiennent tout ce dont un chiffre passe depend — ' +
      'un client qui a commande, un produit qui a bouge en stock, une commande ' +
      'liee a un retour. Ce n est pas un defaut a contourner mais la garantie ' +
      'que les chiffres restent calculables. Chaque refus porte son motif, dans ' +
      'les termes du metier.',
  })
  async purge(
    @TenantId() tenantId: string,
    @Body() dto: PurgeDto,
    @Ctx() context: RequestContext,
  ) {
    return this.archive.purge(
      tenantId,
      { orders: dto.orders, products: dto.products, customers: dto.customers },
      context.membershipId as string,
    );
  }
}
