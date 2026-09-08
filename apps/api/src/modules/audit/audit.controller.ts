/**
 * Consultation du journal d'audit — `/audit-logs` (V2 §23, §28).
 *
 * LECTURE SEULE, SANS EXCEPTION.
 *   Aucune route de modification ni de suppression n'existe. Un journal
 *   d'audit modifiable ne prouve rien : il perdrait toute valeur au moment
 *   precis ou il servirait — lors d'une investigation.
 *   La purge par retention est un job de fond, lui-meme trace.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AUDIT_ACTIONS, PERMISSIONS, buildPageMeta, toSkipTake } from '@ecomflow/shared';
import { PlatformAdminOnly, RequirePermissions, TenantId } from '../../common/decorators';
import { PaginationQueryDto, toStringArray } from '../../common/dto/query.dto';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { asPrimitiveString } from '../../common/utils/text';

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

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ isArray: true, enum: AUDIT_ACTIONS })
  @IsOptional()
  @Transform(toStringArray)
  @IsIn([...AUDIT_ACTIONS], { each: true })
  action?: string[];

  @ApiPropertyOptional({ description: 'Type d entite : Order, Payment, Membership...' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({ description: 'Auteur des actions.' })
  @IsOptional()
  @IsUUID('7')
  actorUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toDate)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toDate)
  @IsDate()
  to?: Date;
}

@ApiTags('Journal d audit')
@ApiBearerAuth()
@Controller()
export class AuditController {
  constructor(@InjectPrisma() private readonly prisma: PrismaClientExtended) {}

  @Get('audit-logs')
  @RequirePermissions(PERMISSIONS.AUDIT_VIEW)
  @ApiOperation({
    summary: 'Journal d audit de la boutique',
    description:
      'Actions sensibles uniquement : connexions, changements de role et de ' +
      'statut, integrations, exports, paiements, abonnements. Les metadonnees ' +
      'sont expurgees de tout secret a l ecriture.',
  })
  async list(@TenantId() tenantId: string, @Query() query: AuditQueryDto) {
    const { skip, take } = toSkipTake(query);
    const page = Math.max(1, Math.trunc(query.page ?? 1));

    const where = {
      tenantId,
      ...(query.action?.length ? { action: { in: query.action } } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          actorKind: true,
          actorLabel: true,
          metadata: true,
          correlationId: true,
          createdAt: true,
          actor: { select: { id: true, fullName: true, email: true } },
        },
      }),
    ]);

    return { data: rows, meta: buildPageMeta(page, take, total) };
  }

  @Get('admin/audit-logs')
  @PlatformAdminOnly()
  @ApiOperation({
    summary: 'Journal d audit global (administration plateforme)',
    description:
      'Toutes boutiques confondues, y compris les actions sans tenant ' +
      '(authentification, administration).',
  })
  async listGlobal(@Query() query: AuditQueryDto) {
    const { skip, take } = toSkipTake(query);
    const page = Math.max(1, Math.trunc(query.page ?? 1));

    return RequestContextStore.runUnscoped('PLATFORM_ADMIN', async () => {
      const where = {
        ...(query.action?.length ? { action: { in: query.action } } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: query.from } : {}),
                ...(query.to ? { lte: query.to } : {}),
              },
            }
          : {}),
      };

      const [total, rows] = await Promise.all([
        this.prisma.auditLog.count({ where }),
        this.prisma.auditLog.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            tenantId: true,
            action: true,
            entityType: true,
            entityId: true,
            actorKind: true,
            actorLabel: true,
            ipAddress: true,
            correlationId: true,
            createdAt: true,
            tenant: { select: { name: true, slug: true } },
            actor: { select: { email: true, fullName: true } },
          },
        }),
      ]);

      return { data: rows, meta: buildPageMeta(page, take, total) };
    });
  }
}
