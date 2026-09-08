/**
 * DTO d'authentification.
 *
 * Toute entree est validee cote serveur (V2 §31). Les contraintes declarees
 * ici alimentent a la fois la validation runtime (class-validator) et la
 * documentation OpenAPI, ce qui garantit qu'elles ne divergent jamais.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LOCALES } from '@ecomflow/shared';

/** Normalise un e-mail : minuscules, espaces retires. */
const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Politique de mot de passe.
 *
 * 12 caracteres minimum, avec au moins une minuscule, une majuscule et un
 * chiffre. Le choix de la LONGUEUR plutot que d'une accumulation de classes
 * de caracteres suit la recommandation NIST SP 800-63B : une phrase de passe
 * longue resiste mieux qu'un mot court truffe de symboles.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;
export const PASSWORD_MESSAGE =
  'Le mot de passe doit contenir au moins 12 caracteres, dont une minuscule, une majuscule et un chiffre.';

export class RegisterDto {
  @ApiProperty({ example: 'sara@boutique-dz.com', description: 'Adresse e-mail du proprietaire.' })
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'MotDePasseSolide2026', minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  password!: string;

  @ApiProperty({ example: 'Sara Benali' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Le nom complet est obligatoire.' })
  @MaxLength(150)
  fullName!: string;

  @ApiProperty({ example: 'Boutique Sara', description: 'Nom de la boutique a creer.' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Le nom de la boutique est obligatoire.' })
  @MaxLength(120)
  storeName!: string;

  @ApiProperty({
    example: '0555123456',
    description:
      'Numero de telephone algerien, OBLIGATOIRE et verifie par code OTP. ' +
      'C est l identifiant fort qui lie l essai gratuit a une personne reelle ' +
      'et empeche la reouverture indefinie d essais (Addendum §38). Demandez ' +
      'd abord un code via POST /auth/otp/request.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Le numero de telephone est obligatoire.' })
  @MaxLength(30)
  phone!: string;

  @ApiProperty({
    example: '123456',
    description: 'Code a 6 chiffres recu par WhatsApp (ou affiche dans les logs en developpement).',
  })
  @Transform(trim)
  @IsString()
  @Length(6, 6, { message: 'Le code de verification comporte 6 chiffres.' })
  otpCode!: string;

  @ApiPropertyOptional({
    description:
      'Empreinte d appareil calculee cote navigateur. Utilisee uniquement pour ' +
      'detecter la reouverture repetee d essais gratuits ; stockee hachee.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string;

  @ApiProperty({ description: 'Acceptation des conditions d utilisation.', example: true })
  @IsBoolean()
  acceptTerms!: boolean;
}

export class LoginDto {
  @ApiProperty({ example: 'sara@boutique-dz.com' })
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  email!: string;

  @ApiProperty({ example: 'MotDePasseSolide2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({
    description: 'Boutique a ouvrir si l utilisateur est membre de plusieurs boutiques.',
  })
  @IsOptional()
  @IsUUID('7')
  tenantId?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Jeton de rafraichissement obtenu a la connexion.' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'sara@boutique-dz.com' })
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Jeton recu par e-mail.' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  newPassword!: string;
}

export class RequestOtpDto {
  @ApiProperty({ example: '0555123456' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '0555123456' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiProperty({ example: '123456' })
  @Transform(trim)
  @IsString()
  @Length(6, 6, { message: 'Le code de verification comporte 6 chiffres.' })
  code!: string;
}

export class SwitchTenantDto {
  @ApiProperty({ description: 'Boutique a activer.' })
  @IsUUID('7')
  tenantId!: string;
}

export class UpdatePreferencesDto {
  @ApiProperty({
    enum: LOCALES,
    description:
      'Langue de l interface pour CET utilisateur. Elle prime toujours sur le ' +
      'reglage de la boutique : un agent arabophone dans une boutique ' +
      'francophone doit pouvoir travailler dans sa langue.',
  })
  @IsIn([...LOCALES], { message: 'Langue non prise en charge.' })
  locale!: (typeof LOCALES)[number];
}
