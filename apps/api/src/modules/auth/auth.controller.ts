/**
 * Points d'entree d'authentification — famille `/auth/*` (V2 §28).
 *
 * Toutes les routes publiques de ce controleur sont soumises a une limitation
 * de debit renforcee : ce sont les cibles naturelles du forcage de mot de
 * passe et de l'enumeration de comptes.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Ctx, CurrentUserId, Public } from '../../common/decorators';
import type { RequestContext } from '../../infra/context/request-context';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  RequestOtpDto,
  ResetPasswordDto,
  UpdatePreferencesDto,
  SwitchTenantDto,
} from './dto/auth.dto';
import {
  AuthSessionResponse,
  OtpChallengeResponse,
  RegistrationResponse,
  toSessionResponse,
} from './dto/auth-response.dto';

@ApiTags('Authentification')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // -------------------------------------------------------------------------
  // Inscription
  // -------------------------------------------------------------------------

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  // Trois demandes de code par minute et par IP : au-dela, on protege a la
  // fois la plateforme (cout des envois) et le destinataire (harcelement).
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Demander un code de verification de numero',
    description:
      'Premiere etape de l inscription. Le numero verifie devient l identifiant ' +
      'fort qui lie l essai gratuit a une personne reelle (Addendum §38). ' +
      'En developpement (OTP_DRIVER=console), le code est renvoye dans la reponse.',
  })
  @ApiOkResponse({ type: OtpChallengeResponse })
  @ApiTooManyRequestsResponse({ description: 'Un code a deja ete envoye recemment.' })
  async requestOtp(@Body() dto: RequestOtpDto): Promise<OtpChallengeResponse> {
    const result = await this.auth.requestOtp(dto.phone);
    return {
      phoneMasked: result.phoneMasked,
      expiresAt: result.expiresAt.toISOString(),
      ...(result.devCode ? { devCode: result.devCode } : {}),
    };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'Creer un compte, une boutique et demarrer l essai de 7 jours',
    description:
      'Cree de facon atomique : le compte utilisateur, la boutique, ses roles ' +
      'et permissions, ses parametres, son abonnement d essai et sa progression ' +
      'd onboarding. Necessite un code OTP valide obtenu via /auth/otp/request.',
  })
  @ApiOkResponse({ type: RegistrationResponse })
  @ApiConflictResponse({ description: 'Adresse e-mail deja utilisee.' })
  @ApiBadRequestResponse({ description: 'Code de verification invalide ou expire.' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
  ): Promise<RegistrationResponse> {
    const result = await this.auth.register(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    return { ...toSessionResponse(result), trialUnderReview: result.trialUnderReview };
  }

  // -------------------------------------------------------------------------
  // Connexion
  // -------------------------------------------------------------------------

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Se connecter' })
  @ApiOkResponse({ type: AuthSessionResponse })
  @ApiUnauthorizedResponse({ description: 'Identifiants incorrects ou compte verrouille.' })
  async login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthSessionResponse> {
    const session = await this.auth.login(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    return toSessionResponse(session);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Renouveler la session',
    description:
      'Le jeton de rafraichissement est a usage unique : chaque appel en emet ' +
      'un nouveau et revoque le precedent. Un rejeu revoque toute la famille ' +
      'de sessions, par securite.',
  })
  @ApiOkResponse({ type: AuthSessionResponse })
  @ApiUnauthorizedResponse({ description: 'Jeton invalide, expire ou deja utilise.' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<AuthSessionResponse> {
    const session = await this.auth.refresh(dto.refreshToken, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    return toSessionResponse(session);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Se deconnecter',
    description: 'Revoque le jeton de rafraichissement fourni.',
  })
  async logout(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<void> {
    // La route est publique : un jeton d'acces expire ne doit pas empecher
    // une deconnexion propre.
    const userId = (request as Request & { user?: { id?: string } }).user?.id ?? null;
    await this.auth.logout(dto.refreshToken, userId);
  }

  // -------------------------------------------------------------------------
  // Mot de passe
  // -------------------------------------------------------------------------

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @ApiOperation({
    summary: 'Demander la reinitialisation du mot de passe',
    description:
      'Repond toujours 202, que l adresse existe ou non : repondre ' +
      'differemment permettrait d enumerer les comptes.',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.auth.requestPasswordReset(dto.email);
    return {
      message:
        'Si un compte existe pour cette adresse, un e-mail de reinitialisation vient d etre envoye.',
    };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'Definir un nouveau mot de passe a partir du lien recu' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.password);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Changer son mot de passe',
    description: 'Revoque toutes les sessions actives, y compris la session courante.',
  })
  async changePassword(
    @CurrentUserId() userId: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  // -------------------------------------------------------------------------
  // Session courante
  // -------------------------------------------------------------------------

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Profil et droits de la session courante',
    description:
      'Le frontend s en sert pour adapter la navigation. Ce n est JAMAIS une ' +
      'autorisation : chaque appel est revalide cote serveur.',
  })
  async me(@Ctx() context: RequestContext): Promise<{
    userId: string;
    tenantId: string | null;
    membershipId: string | null;
    permissions: string[];
    isPlatformAdmin: boolean;
  }> {
    return {
      userId: context.userId as string,
      tenantId: context.tenantId,
      membershipId: context.membershipId,
      permissions: [...context.permissions].sort(),
      isPlatformAdmin: context.isPlatformAdmin,
    };
  }

  @Patch('me/preferences')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Changer la langue de son interface',
    description:
      'La preference est portee par l UTILISATEUR, pas par le navigateur : ' +
      'un agent retrouve sa langue depuis n importe quel poste. Elle prime ' +
      'toujours sur la langue par defaut de la boutique.',
  })
  async updatePreferences(
    @CurrentUserId() userId: string,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<{ locale: string }> {
    return this.auth.updatePreferences(userId, { locale: dto.locale });
  }

  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Changer de boutique active',
    description:
      'Emet un nouveau couple de jetons portant la boutique demandee. ' +
      'L appartenance est revalidee : un identifiant de boutique arbitraire ' +
      'est refuse.',
  })
  @ApiOkResponse({ type: AuthSessionResponse })
  async switchTenant(
    @CurrentUserId() userId: string,
    @Body() dto: SwitchTenantDto,
    @Req() request: Request,
  ): Promise<AuthSessionResponse> {
    const session = await this.auth.switchTenant(userId, dto.tenantId, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    return toSessionResponse(session);
  }
}
