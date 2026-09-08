/**
 * Reponses d'authentification.
 *
 * Ces classes existent pour deux raisons :
 *  1. documenter le contrat exact dans OpenAPI ;
 *  2. constituer une barriere de serialisation : seuls les champs declares ici
 *     quittent le serveur. Un ajout de colonne en base (hash de mot de passe,
 *     empreinte anti-abus) ne peut pas fuiter par inadvertance.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AuthSession } from '../auth.service';

export class AuthTokensResponse {
  @ApiProperty({ description: 'Jeton d acces, a placer dans l en-tete Authorization.' })
  accessToken!: string;

  @ApiProperty({ description: 'Jeton de rafraichissement, a usage unique.' })
  refreshToken!: string;

  @ApiProperty({ description: 'Expiration du jeton d acces (ISO 8601).' })
  accessTokenExpiresAt!: string;

  @ApiProperty({ description: 'Expiration du jeton de rafraichissement (ISO 8601).' })
  refreshTokenExpiresAt!: string;
}

export class AuthUserResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ description: 'Numero de telephone verifie par code OTP.' })
  phoneVerified!: boolean;
}

export class AuthTenantResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ enum: ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'] })
  status!: string;
}

export class AuthSessionResponse {
  @ApiProperty({ type: AuthTokensResponse })
  tokens!: AuthTokensResponse;

  @ApiProperty({ type: AuthUserResponse })
  user!: AuthUserResponse;

  @ApiPropertyOptional({
    type: AuthTenantResponse,
    nullable: true,
    description: 'Boutique active. Null pour un Super Admin sans boutique selectionnee.',
  })
  tenant!: AuthTenantResponse | null;

  @ApiPropertyOptional({ nullable: true, description: 'Code du role dans la boutique active.' })
  role!: string | null;

  @ApiProperty({
    type: [String],
    description:
      'Permissions effectives. Fournies pour adapter l interface ; elles ne ' +
      'constituent jamais une autorisation cote client.',
  })
  permissions!: string[];

  @ApiProperty()
  isPlatformAdmin!: boolean;
}

export class RegistrationResponse extends AuthSessionResponse {
  @ApiProperty({
    description:
      'Vrai si l essai part en revue manuelle du Super Admin. La boutique est ' +
      'utilisable normalement en attendant (Addendum §38).',
  })
  trialUnderReview!: boolean;
}

export class OtpChallengeResponse {
  @ApiProperty({ example: '+213•••••3456' })
  phoneMasked!: string;

  @ApiProperty({ description: 'Expiration du code (ISO 8601).' })
  expiresAt!: string;

  @ApiPropertyOptional({
    description:
      'Code en clair. Renseigne UNIQUEMENT avec OTP_DRIVER=console hors ' +
      'production, pour permettre le developpement local et les tests de bout ' +
      'en bout sans fournisseur SMS.',
  })
  devCode?: string;
}

/** Convertit la session interne en reponse API. */
export function toSessionResponse(session: AuthSession): AuthSessionResponse {
  return {
    tokens: {
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
      accessTokenExpiresAt: session.tokens.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: session.tokens.refreshTokenExpiresAt.toISOString(),
    },
    user: { ...session.user },
    tenant: session.tenant ? { ...session.tenant } : null,
    role: session.role,
    permissions: [...session.permissions],
    isPlatformAdmin: session.isPlatformAdmin,
  };
}
