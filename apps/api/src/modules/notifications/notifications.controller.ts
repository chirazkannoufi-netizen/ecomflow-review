/**
 * API des notifications et du centre d'incidents — `/notifications/*` (V2 §21).
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { NOTIFICATION_CHANNELS, PERMISSIONS } from '@ecomflow/shared';
import { RequirePermissions, TenantId } from '../../common/decorators';
import { NotificationsService } from './notifications.service';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class MarkReadDto {
  @ApiProperty({ type: [String], description: 'Notifications a marquer comme lues.' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('7', { each: true })
  ids!: string[];
}

export class SetPreferenceDto {
  @ApiProperty({ example: 'stock.low', description: 'Type d evenement.' })
  @IsString()
  type!: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  @IsIn([...NOTIFICATION_CHANNELS])
  channel!: (typeof NOTIFICATION_CHANNELS)[number];

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Lister les notifications de la boutique',
    description:
      'Inclut les incidents techniques (echec de synchronisation, panne ' +
      'transporteur) et les evenements metier importants.',
  })
  async list(@TenantId() tenantId: string, @Query() query: ListNotificationsQueryDto) {
    return this.notifications.list(tenantId, {
      unreadOnly: query.unreadOnly,
      limit: query.limit,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Nombre de notifications non lues (pastille de navigation)' })
  async unreadCount(@TenantId() tenantId: string) {
    return { count: await this.notifications.countUnread(tenantId) };
  }

  @Post('mark-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marquer des notifications comme lues' })
  async markRead(@TenantId() tenantId: string, @Body() dto: MarkReadDto) {
    const count = await this.notifications.markRead(tenantId, dto.ids);
    return { marked: count };
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tout marquer comme lu' })
  async markAllRead(@TenantId() tenantId: string) {
    const count = await this.notifications.markAllRead(tenantId);
    return { marked: count };
  }

  @Get('preferences')
  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @ApiOperation({
    summary: 'Preferences de notification de la boutique',
    description:
      'Le canal « in-app » ne peut pas etre desactive : sans lui, un incident ' +
      'critique pourrait passer totalement inapercu.',
  })
  async listPreferences(@TenantId() tenantId: string) {
    return this.notifications.listPreferences(tenantId);
  }

  @Post('preferences')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @ApiOperation({ summary: 'Activer ou desactiver un canal pour un type d evenement' })
  async setPreference(@TenantId() tenantId: string, @Body() dto: SetPreferenceDto) {
    await this.notifications.setPreference(tenantId, dto.type, dto.channel, dto.enabled);
    return { acknowledged: true as const };
  }
}
