/**
 * API du centre de confirmation — famille `/confirmation/*` (V2 §28).
 *
 * Ces routes sont les plus sollicitees de la plateforme : un agent y enchaine
 * des dizaines d'appels par heure. Elles sont donc pensees pour une seule
 * chose — permettre une action par appel telephonique, sans navigation.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { CONFIRMATION_QUEUE_STATUSES, PERMISSIONS, parseAlgerianPhone } from '@ecomflow/shared';
import {
  Audited,
  Ctx,
  CurrentMembershipId,
  RequirePermissions,
  RequiresOperationalSubscription,
  TenantId,
} from '../../common/decorators';
import { ValidationException } from '../../common/errors/business.exception';
import { PaginationQueryDto, toStringArray } from '../../common/dto/query.dto';
import type { RequestContext } from '../../infra/context/request-context';
import { ConfirmationService, type ConfirmationAction } from './confirmation.service';
import { WhatsappFilterService } from '../whatsapp/whatsapp-filter.service';
import { asPrimitiveString } from '../../common/utils/text';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const toDate = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  // Une valeur non primitive (`?from[gte]=x`) est renvoyee telle quelle : le
  // validateur la refusera avec un message clair, plutot que de la convertir
  // en « [object Object] » puis en date invalide.
  const raw = asPrimitiveString(value);
  if (raw === null) return value;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? value : parsed;
};

export class QueueQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ isArray: true, enum: CONFIRMATION_QUEUE_STATUSES })
  @IsOptional()
  @Transform(toStringArray)
  @IsIn([...CONFIRMATION_QUEUE_STATUSES], { each: true })
  status?: (typeof CONFIRMATION_QUEUE_STATUSES)[number][];

  @ApiPropertyOptional({ minimum: 1, maximum: 58 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  wilayaCode?: number;

  @ApiPropertyOptional({ description: 'Restreint aux commandes affectees a cet agent.' })
  @IsOptional()
  @IsUUID('7')
  assignedMembershipId?: string;

  @ApiPropertyOptional({ description: 'Uniquement les commandes non affectees.' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unassignedOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Exclut les rappels programmes dans le futur.',
    default: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  dueOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class ConfirmationActionDto {
  @ApiProperty({
    enum: ['CONFIRM', 'CALL_BACK', 'POSTPONE', 'NO_ANSWER', 'CANCEL', 'WRONG_NUMBER'],
    description: 'Action rapide du centre de confirmation (V1 §9).',
  })
  @IsIn(['CONFIRM', 'CALL_BACK', 'POSTPONE', 'NO_ANSWER', 'CANCEL', 'WRONG_NUMBER'])
  action!: ConfirmationAction;

  @ApiPropertyOptional({ description: 'Note d appel, visible dans l historique.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({ description: 'Motif. Obligatoire pour une annulation.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Date du prochain rappel (ISO 8601). Applicable a CALL_BACK et POSTPONE. ' +
      'A defaut, le delai par defaut de la boutique s applique.',
  })
  @IsOptional()
  @Transform(toDate)
  @IsDate({ message: 'Date de rappel invalide.' })
  callbackAt?: Date;

  @ApiPropertyOptional({ description: 'Duree de l appel en secondes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  callDurationSeconds?: number;
}

export class CorrectPhoneDto {
  @ApiProperty({ example: '0555123456' })
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  phone!: string;
}

@ApiTags('Centre de confirmation')
@ApiBearerAuth()
@Controller('confirmation')
export class ConfirmationController {
  constructor(
    private readonly confirmation: ConfirmationService,
    private readonly whatsappFilter: WhatsappFilterService,
  ) {}

  @Get('queue')
  @RequirePermissions(PERMISSIONS.CONFIRMATION_MANAGE)
  @ApiOperation({
    summary: 'File de confirmation',
    description:
      'Triee par rappels echus, puis par priorite de fiabilite client ' +
      '(Addendum §32), puis par anciennete. Un client a risque n est jamais ' +
      'exclu de la file : il est simplement traite plus tard.',
  })
  async queue(
    @TenantId() tenantId: string,
    @Query() query: QueueQueryDto,
    @Ctx() context: RequestContext,
  ) {
    // Un agent sans `confirmation.view_all` ne voit que ses propres commandes
    // et celles qui ne sont affectees a personne.
    const restrictToSelf = !context.permissions.has(PERMISSIONS.CONFIRMATION_VIEW_ALL);

    return this.confirmation.getQueue(
      tenantId,
      {
        status: query.status,
        wilayaCode: query.wilayaCode,
        assignedMembershipId: restrictToSelf
          ? (context.membershipId ?? undefined)
          : query.assignedMembershipId,
        unassignedOnly: query.unassignedOnly,
        dueOnly: query.dueOnly ?? true,
        search: query.search,
      },
      { page: query.page, pageSize: query.pageSize },
    );
  }

  @Get('queue/stats')
  @RequirePermissions(PERMISSIONS.CONFIRMATION_MANAGE)
  @ApiOperation({ summary: 'Compteurs de la file, pour l en-tete de l ecran' })
  async stats(@TenantId() tenantId: string) {
    return this.confirmation.getQueueStats(tenantId);
  }

  @Post('queue/next')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONFIRMATION_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Prendre la commande suivante',
    description:
      'Reserve la prochaine commande a traiter et l affecte a l agent. ' +
      'Deux agents cliquant simultanement ne recoivent jamais la meme commande : ' +
      'le verrou de base garantit l exclusivite.',
  })
  @ApiOkResponse({ description: 'Commande reservee, ou `null` si la file est vide.' })
  async next(
    @TenantId() tenantId: string,
    @CurrentMembershipId() membershipId: string,
    @Query() query: QueueQueryDto,
  ) {
    return this.confirmation.claimNext(tenantId, membershipId, {
      status: query.status,
      wilayaCode: query.wilayaCode,
    });
  }

  @Post('orders/:id/action')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONFIRMATION_MANAGE)
  @RequiresOperationalSubscription()
  @Audited({ action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityIdParam: 'id' })
  @ApiOperation({
    summary: 'Appliquer une action de confirmation',
    description:
      'Enregistre la tentative d appel, applique la transition de statut avec ' +
      'tous ses effets metier (stock, compteurs client, historique) et programme ' +
      'le rappel — le tout dans une seule transaction.',
  })
  async applyAction(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: ConfirmationActionDto,
    @Ctx() context: RequestContext,
  ) {
    return this.confirmation.applyAction({
      tenantId,
      orderId,
      action: dto.action,
      membershipId: context.membershipId as string,
      permissions: context.permissions,
      note: dto.note ?? null,
      reason: dto.reason ?? null,
      callbackAt: dto.callbackAt ?? null,
      callDurationSeconds: dto.callDurationSeconds ?? null,
    });
  }

  @Post('orders/:id/correct-phone')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONFIRMATION_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Corriger un numero incorrect et relancer la confirmation',
    description:
      'Repositionne la commande en file d appel avec le numero corrige. ' +
      'C est la sortie prevue du statut NUMERO INCORRECT.',
  })
  async correctPhone(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: CorrectPhoneDto,
    @Ctx() context: RequestContext,
  ) {
    const parsed = parseAlgerianPhone(dto.phone);
    if (!parsed.ok) {
      throw new ValidationException(
        'Numero de telephone algerien invalide. Format attendu : 0555 12 34 56.',
        { details: { reason: parsed.error } },
      );
    }

    await this.confirmation.correctPhoneNumber({
      tenantId,
      orderId,
      membershipId: context.membershipId as string,
      permissions: context.permissions,
      phoneE164: parsed.value.e164,
    });

    return { acknowledged: true as const, phoneE164: parsed.value.e164 };
  }

  // -------------------------------------------------------------------------
  // Filtre WhatsApp (Addendum §31)
  // -------------------------------------------------------------------------

  @Get('orders/:id/whatsapp')
  @RequirePermissions(PERMISSIONS.CONFIRMATION_MANAGE)
  @ApiOperation({
    summary: 'Historique WhatsApp d une commande',
    description:
      'Affiche ce qui a ete tente automatiquement et pourquoi la commande a ete ' +
      'rendue a un agent. C est ce qui distingue un transfert d une perte.',
  })
  async whatsappThread(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return this.whatsappFilter.getThread(tenantId, orderId);
  }

  @Post('orders/:id/whatsapp/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONFIRMATION_MANAGE)
  @RequiresOperationalSubscription()
  @ApiOperation({
    summary: 'Relancer le filtre WhatsApp sur une commande',
    description:
      'Utile apres correction d un numero. Si la passerelle n est pas ' +
      'configuree ou la commande ineligible, la reponse le dit explicitement ' +
      'et la commande reste en file d appel.',
  })
  async retryWhatsapp(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return this.whatsappFilter.attemptFilter(tenantId, orderId);
  }
}
