/**
 * API d'abonnement et de paiement — familles `/plans`, `/subscriptions/*`,
 * `/payments/*` (V2 §28, Addendum §35).
 *
 * AUCUNE de ces routes n'exige un abonnement operationnel : un commercant dont
 * l'essai est termine doit precisement pouvoir venir ici pour payer (D-023).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { PERMISSIONS } from '@ecomflow/shared';
import {
  Audited,
  Ctx,
  CurrentMembershipId,
  PlatformAdminOnly,
  Public,
  RequirePermissions,
  TenantId,
} from '../../common/decorators';
import type { RequestContext } from '../../infra/context/request-context';
import { BillingService } from './billing.service';
import { TrialAbuseService } from './trial-abuse.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class StartCheckoutDto {
  @ApiProperty({ description: 'Plan a souscrire.' })
  @IsUUID('7')
  planId!: string;
}

export class SubmitManualPaymentDto {
  @ApiProperty()
  @IsUUID('7')
  planId!: string;

  @ApiProperty({
    enum: ['MANUAL_TRANSFER', 'MANUAL_BARIDIMOB'],
    description: 'Moyen utilise : virement bancaire ou BaridiMob.',
  })
  @IsIn(['MANUAL_TRANSFER', 'MANUAL_BARIDIMOB'])
  provider!: 'MANUAL_TRANSFER' | 'MANUAL_BARIDIMOB';

  @ApiProperty({
    description: 'URL du justificatif televerse (recu de virement, capture BaridiMob).',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Un justificatif de paiement est obligatoire.' })
  @MaxLength(500)
  proofUrl!: string;

  @ApiPropertyOptional({ description: 'Precision utile a la verification.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReviewPaymentDto {
  @ApiProperty()
  @IsUUID('7')
  paymentId!: string;

  @ApiPropertyOptional({ description: 'Note de verification.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectPaymentDto {
  @ApiProperty()
  @IsUUID('7')
  paymentId!: string;

  @ApiProperty({
    description: 'Motif du refus. Obligatoire : le commercant doit savoir quoi corriger.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class SuspendTenantDto {
  @ApiProperty()
  @IsUUID('7')
  tenantId!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListLimitDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

@ApiTags('Abonnement et paiements')
@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly trialAbuse: TrialAbuseService,
  ) {}

  // -------------------------------------------------------------------------
  // Plans (publics)
  // -------------------------------------------------------------------------

  @Public()
  @Get('plans')
  @ApiOperation({
    summary: 'Plans tarifaires disponibles',
    description:
      'Les prix et limites viennent de la base, jamais du code frontend ' +
      '(V2 §38). Route publique : la page tarifs doit etre consultable avant ' +
      'toute inscription.',
  })
  async listPlans() {
    return this.billing.listPlans();
  }

  // -------------------------------------------------------------------------
  // Abonnement de la boutique
  // -------------------------------------------------------------------------

  @Get('subscriptions/current')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.BILLING_VIEW)
  @ApiOperation({
    summary: 'Etat d abonnement de la boutique',
    description:
      'L etat est RECALCULE cote serveur a partir des dates persistees : ' +
      'meme si le job d expiration n a pas encore tourne, une boutique dont ' +
      'l essai est termine est signalee comme telle.',
  })
  async currentSubscription(@TenantId() tenantId: string) {
    return this.billing.getSubscription(tenantId);
  }

  @Get('payments')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.BILLING_VIEW)
  @ApiOperation({ summary: 'Historique des paiements de la boutique' })
  async listPayments(@TenantId() tenantId: string, @Query() query: ListLimitDto) {
    return this.billing.listPayments(tenantId, query.limit ?? 50);
  }

  @Post('payments/checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  @Audited({ action: 'PAYMENT_SUBMITTED', entityType: 'Payment' })
  @ApiOperation({
    summary: 'Demarrer un paiement par carte (Chargily Pay)',
    description:
      'Retourne un lien de paiement. L abonnement n est PAS active a ce stade : ' +
      'seul le webhook signe de Chargily l activera. Le retour du navigateur sur ' +
      'l URL de succes ne prouve rien.',
  })
  async startCheckout(
    @TenantId() tenantId: string,
    @Body() dto: StartCheckoutDto,
    @Ctx() context: RequestContext,
  ) {
    return this.billing.startCheckout({
      tenantId,
      planId: dto.planId,
      membershipId: context.membershipId as string,
    });
  }

  @Post('payments/manual')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  @Audited({ action: 'PAYMENT_SUBMITTED', entityType: 'Payment' })
  @ApiOperation({
    summary: 'Soumettre un justificatif de paiement manuel',
    description:
      'Virement ou BaridiMob (Addendum §35). Le paiement passe en « en attente ' +
      'de verification » : un Super Admin doit confronter le justificatif au ' +
      'releve bancaire avant activation. Une capture d ecran n active rien.',
  })
  async submitManualPayment(
    @TenantId() tenantId: string,
    @Body() dto: SubmitManualPaymentDto,
    @CurrentMembershipId() membershipId: string,
  ) {
    return this.billing.submitManualPayment({
      tenantId,
      planId: dto.planId,
      membershipId,
      provider: dto.provider,
      proofUrl: dto.proofUrl,
      note: dto.note ?? null,
    });
  }

  @Post('subscriptions/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  @Audited({ action: 'SUBSCRIPTION_CANCELLED', entityType: 'Subscription' })
  @ApiOperation({
    summary: 'Resilier l abonnement',
    description:
      'La resiliation prend effet a la fin de la periode deja payee : le ' +
      'commercant conserve ce qu il a achete.',
  })
  async cancel(@TenantId() tenantId: string, @CurrentMembershipId() membershipId: string) {
    return this.billing.cancelSubscription(tenantId, membershipId);
  }

  // -------------------------------------------------------------------------
  // Webhook de paiement (public, signe)
  // -------------------------------------------------------------------------

  @Public()
  @Post('payments/webhook/chargily')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Webhook Chargily Pay' })
  async chargilyWebhook(@Req() request: RawBodyRequest<Request>) {
    // Le corps BRUT est indispensable : la signature porte sur les octets
    // exacts recus, pas sur un JSON re-serialise.
    const rawBody = request.rawBody ?? Buffer.from('');
    const signature = request.get('signature') ?? request.get('x-signature');

    const result = await this.billing.handleChargilyWebhook(rawBody, signature);

    // On repond TOUJOURS 200 : renvoyer une erreur ferait rejouer
    // indefiniment un webhook inexploitable par Chargily.
    return { received: true, ...result };
  }

  // -------------------------------------------------------------------------
  // Administration plateforme
  // -------------------------------------------------------------------------

  @Get('admin/payments/pending-review')
  @ApiBearerAuth()
  @PlatformAdminOnly()
  @ApiOperation({ summary: 'File de verification des paiements manuels' })
  @ApiOkResponse({ description: 'Paiements en attente, du plus ancien au plus recent.' })
  async pendingReview(@Query() query: ListLimitDto) {
    return this.billing.listPaymentsAwaitingReview(query.limit ?? 50);
  }

  @Post('admin/payments/approve')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @PlatformAdminOnly()
  @Audited({ action: 'PAYMENT_APPROVED', entityType: 'Payment' })
  @ApiOperation({
    summary: 'Approuver un paiement manuel',
    description:
      'Active l abonnement. A n utiliser qu apres verification effective du ' +
      'versement sur le compte bancaire.',
  })
  async approvePayment(@Body() dto: ReviewPaymentDto, @Ctx() context: RequestContext) {
    await this.billing.approveManualPayment(
      dto.paymentId,
      context.userId as string,
      dto.note,
    );
    return { acknowledged: true as const };
  }

  @Post('admin/payments/reject')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @PlatformAdminOnly()
  @Audited({ action: 'PAYMENT_REJECTED', entityType: 'Payment' })
  @ApiOperation({ summary: 'Refuser un paiement manuel, avec motif' })
  async rejectPayment(@Body() dto: RejectPaymentDto, @Ctx() context: RequestContext) {
    await this.billing.rejectManualPayment(
      dto.paymentId,
      context.userId as string,
      dto.reason,
    );
    return { acknowledged: true as const };
  }

  @Post('admin/tenants/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @PlatformAdminOnly()
  @Audited({ action: 'TENANT_SUSPENDED', entityType: 'Tenant' })
  @ApiOperation({ summary: 'Suspendre une boutique' })
  async suspendTenant(@Body() dto: SuspendTenantDto, @Ctx() context: RequestContext) {
    await this.billing.suspendTenant(dto.tenantId, dto.reason, context.userId as string);
    return { acknowledged: true as const };
  }

  @Get('admin/trials/pending-review')
  @ApiBearerAuth()
  @PlatformAdminOnly()
  @ApiOperation({
    summary: 'Essais gratuits signales pour revue manuelle',
    description:
      'Chaque entree liste les signaux ayant declenche la revue et leur poids ' +
      '(Addendum §38). La boutique reste utilisable en attendant la decision.',
  })
  async pendingTrialReviews(@Query() query: ListLimitDto) {
    return this.trialAbuse.listPendingReviews(query.limit ?? 50);
  }
}
