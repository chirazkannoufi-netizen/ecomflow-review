/**
 * Service d'authentification.
 *
 * Couvre le perimetre du prompt produit §9 : inscription, connexion,
 * deconnexion, recuperation de mot de passe, gestion des sessions, plus la
 * verification de numero et la prevention d'abus de l'essai (Addendum §38).
 *
 * CHOIX DE SECURITE STRUCTURANTS
 *
 *  - Reponses uniformes : « e-mail inconnu » et « mot de passe incorrect »
 *    renvoient exactement la meme erreur. Sinon l'API devient un oracle
 *    permettant d'enumerer les comptes existants.
 *
 *  - Cout constant a l'echec : quand l'e-mail n'existe pas, on verifie tout de
 *    meme un hash factice. Sans cela, la difference de temps de reponse
 *    (~100 ms d'Argon2) revele l'existence du compte.
 *
 *  - Verrouillage progressif : au-dela de N echecs, le compte est verrouille
 *    temporairement. Protege contre le forcage sans permettre a un tiers de
 *    bloquer definitivement un commercant.
 *
 *  - Revocation totale au changement de mot de passe : toutes les sessions
 *    tombent, y compris celles d'un eventuel attaquant.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  maskPhone,
  parseAlgerianPhone,
  type Locale,
} from '@ecomflow/shared';
import { AppConfigService } from '../../config/configuration';
import { ClockService } from '../../infra/clock/clock.service';
import { HashService } from '../../infra/crypto/hash.service';
import { RequestContextStore } from '../../infra/context/request-context';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import {
  BusinessException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  ValidationException,
} from '../../common/errors/business.exception';
import { HttpStatus } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../notifications/mail/mail.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { TrialAbuseService } from '../billing/trial-abuse.service';
import { AccessContextService } from './access-context.service';
import { OtpService } from './otp.service';
import { TokenService, type IssuedTokens } from './token.service';
import type { LoginDto, RegisterDto } from './dto/auth.dto';

/**
 * Hash Argon2id d'une valeur arbitraire, utilise pour egaliser le temps de
 * reponse quand le compte n'existe pas. Calcule une fois au demarrage.
 */
const DUMMY_PASSWORD = 'ecomflow-timing-equalizer-2026';

/** Duree de validite d'un lien de reinitialisation de mot de passe. */
const PASSWORD_RESET_TTL_MINUTES = 60;

export interface AuthSession {
  readonly tokens: IssuedTokens;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly phoneVerified: boolean;
  };
  readonly tenant: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
  } | null;
  readonly role: string | null;
  readonly permissions: readonly string[];
  readonly isPlatformAdmin: boolean;
}

export interface RegistrationResult extends AuthSession {
  /**
   * Renseigne lorsque l'inscription part en revue manuelle : la boutique est
   * creee et utilisable, mais un administrateur verifiera l'essai.
   */
  readonly trialUnderReview: boolean;
}

export interface ClientMetadata {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly hash: HashService,
    private readonly clock: ClockService,
    private readonly config: AppConfigService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly access: AccessContextService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly provisioning: TenantProvisioningService,
    private readonly trialAbuse: TrialAbuseService,
  ) {}

  // =========================================================================
  // INSCRIPTION
  // =========================================================================

  /**
   * Cree un compte, sa boutique et son essai gratuit de 7 jours.
   *
   * Sequence :
   *  1. verification du code OTP (le numero devient l'identifiant fort) ;
   *  2. evaluation du risque d'abus d'essai ;
   *  3. creation atomique : utilisateur + boutique + roles + abonnement + trace.
   */
  async register(dto: RegisterDto, client: ClientMetadata = {}): Promise<RegistrationResult> {
    if (!dto.acceptTerms) {
      throw new ValidationException(
        'Vous devez accepter les conditions d utilisation pour creer un compte.',
      );
    }

    // --- 1. Verification du numero ------------------------------------------
    const { phoneE164 } = await this.otp.verifyChallenge(dto.phone, dto.otpCode);

    // --- 2. Unicite de l'e-mail --------------------------------------------
    const existing = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } }),
    );
    if (existing) {
      throw new ConflictException(
        ERROR_CODES.AUTH_EMAIL_ALREADY_USED,
        'Un compte existe deja avec cette adresse e-mail.',
      );
    }

    // --- 3. Prevention de l'abus de l'essai (Addendum §38) ------------------
    const evaluation = await this.trialAbuse.evaluate({
      email: dto.email,
      verifiedPhoneE164: phoneE164,
      ipAddress: client.ipAddress ?? null,
      deviceFingerprint: dto.deviceFingerprint ?? null,
    });

    if (evaluation.decision === 'BLOCK') {
      await this.audit.record({
        action: 'TRIAL_ABUSE_FLAGGED',
        entityType: 'TrialRegistration',
        tenantId: null,
        actorKind: 'SYSTEM',
        metadata: {
          decision: evaluation.decision,
          score: evaluation.score,
          signals: evaluation.signals,
          phoneMasked: maskPhone(phoneE164),
        },
      });

      this.logger.warn(
        `Inscription refusee (abus d essai) : score=${evaluation.score} ` +
          `signaux=${evaluation.signals.join(',')}`,
      );

      throw new ForbiddenException(
        ERROR_CODES.TRIAL_ALREADY_USED,
        'Un essai gratuit a deja ete utilise avec ce numero de telephone. ' +
          'Connectez-vous a votre compte existant ou souscrivez un abonnement.',
        { details: { reasons: evaluation.explanation } },
      );
    }

    const passwordHash = await this.hash.hashPassword(dto.password);
    const now = this.clock.now();

    // --- 4. Creation atomique ----------------------------------------------
    const result = await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      const user = await RequestContextStore.runUnscoped('BOOTSTRAP', () =>
        tx.user.create({
          data: {
            email: dto.email,
            passwordHash,
            fullName: dto.fullName,
            phoneE164,
            phoneVerifiedAt: now,
            // Le numero est verifie ; l'e-mail le sera par lien de confirmation.
            // Le compte est utilisable immediatement : imposer la verification
            // e-mail avant tout usage ferait perdre la moitie des inscriptions.
            status: 'ACTIVE',
          },
          select: { id: true, email: true, fullName: true },
        }),
      );

      const tenant = await this.provisioning.provision(
        { name: dto.storeName, ownerUserId: user.id, status: 'ONBOARDING', startTrial: true },
        tx,
      );

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        this.trialAbuse.recordRegistration(tx, {
          tenantId: tenant.tenantId,
          userId: user.id,
          evaluation,
          verifiedPhoneE164: phoneE164,
        }),
      );

      return { user, tenant };
    });

    await this.audit.record({
      action: 'TENANT_CREATED',
      entityType: 'Tenant',
      entityId: result.tenant.tenantId,
      tenantId: result.tenant.tenantId,
      actorUserId: result.user.id,
      metadata: {
        storeName: dto.storeName,
        slug: result.tenant.slug,
        trialEndAt: result.tenant.trialEndAt?.toISOString(),
        abuseDecision: evaluation.decision,
        abuseScore: evaluation.score,
      },
    });

    await this.sendWelcomeEmail(result.user.email, result.user.fullName, result.tenant.trialEndAt);

    const session = await this.buildSession(
      result.user.id,
      result.tenant.tenantId,
      client,
    );

    return { ...session, trialUnderReview: evaluation.decision === 'MANUAL_REVIEW' };
  }

  // =========================================================================
  // CONNEXION
  // =========================================================================

  async login(dto: LoginDto, client: ClientMetadata = {}): Promise<AuthSession> {
    const user = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.findUnique({
        where: { email: dto.email },
        select: {
          id: true,
          email: true,
          passwordHash: true,
          status: true,
          failedLoginCount: true,
          lockedUntil: true,
        },
      }),
    );

    // Compte inexistant : on paie quand meme le cout d'une verification pour
    // que la duree de reponse ne revele rien.
    if (!user?.passwordHash) {
      await this.equalizeTiming();
      await this.recordFailedLogin(dto.email, client, 'Compte inexistant');
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        'Adresse e-mail ou mot de passe incorrect.',
      );
    }

    if (user.lockedUntil && this.clock.isFuture(user.lockedUntil)) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - this.clock.timestamp()) / 60_000);
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_ACCOUNT_LOCKED,
        `Trop de tentatives. Compte verrouille pendant encore ${minutes} minute(s).`,
        { details: { lockedUntil: user.lockedUntil.toISOString() } },
      );
    }

    if (user.status === 'DISABLED') {
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_ACCOUNT_DISABLED,
        'Ce compte a ete desactive. Contactez le support.',
      );
    }

    const valid = await this.hash.verifyPassword(user.passwordHash, dto.password);

    if (!valid) {
      await this.registerFailedAttempt(user.id, user.failedLoginCount);
      await this.recordFailedLogin(dto.email, client, 'Mot de passe incorrect', user.id);
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        'Adresse e-mail ou mot de passe incorrect.',
      );
    }

    // --- Succes : remise a zero des compteurs -------------------------------
    await RequestContextStore.runUnscoped('AUTHENTICATION', async () => {
      const data: Record<string, unknown> = {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: this.clock.now(),
      };

      // Re-hachage opportuniste si les parametres de cout ont ete durcis.
      if (this.hash.needsRehash(user.passwordHash as string)) {
        data.passwordHash = await this.hash.hashPassword(dto.password);
      }

      await this.prisma.user.update({ where: { id: user.id }, data });
    });

    const session = await this.buildSession(user.id, dto.tenantId ?? null, client);

    await this.audit.record({
      action: 'AUTH_LOGIN_SUCCESS',
      entityType: 'User',
      entityId: user.id,
      actorUserId: user.id,
      tenantId: session.tenant?.id ?? null,
      metadata: { email: user.email },
    });

    return session;
  }

  /** Renouvelle une session a partir d'un jeton de rafraichissement. */
  async refresh(refreshToken: string, client: ClientMetadata = {}): Promise<AuthSession> {
    const rotated = await this.tokens.rotate(refreshToken, client);
    return this.buildSessionFromTokens(rotated.userId, rotated.tenantId, {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      accessTokenExpiresAt: rotated.accessTokenExpiresAt,
      refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
    });
  }

  async logout(refreshToken: string, userId: string | null): Promise<void> {
    await this.tokens.revoke(refreshToken);
    if (userId) {
      await this.audit.record({
        action: 'AUTH_LOGOUT',
        entityType: 'User',
        entityId: userId,
        actorUserId: userId,
      });
    }
  }

  /** Change la boutique active et emet un nouveau couple de jetons. */
  async switchTenant(
    userId: string,
    tenantId: string,
    client: ClientMetadata = {},
  ): Promise<AuthSession> {
    // `resolve` refuse deja l'acces a une boutique dont l'utilisateur n'est
    // pas membre : aucune verification supplementaire n'est requise ici.
    return this.buildSession(userId, tenantId, client);
  }

  // =========================================================================
  // MOT DE PASSE
  // =========================================================================

  /**
   * Demande de reinitialisation.
   *
   * Retourne TOUJOURS un succes, meme si l'adresse est inconnue : repondre
   * differemment transformerait l'endpoint en verificateur d'existence de
   * compte.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, fullName: true, status: true },
      }),
    );

    if (!user || user.status === 'DISABLED') {
      this.logger.debug(`Reinitialisation demandee pour une adresse inconnue ou desactivee.`);
      return;
    }

    const token = this.hash.generateToken(32);
    const expiresAt = this.clock.inMinutes(PASSWORD_RESET_TTL_MINUTES);

    await RequestContextStore.runUnscoped('AUTHENTICATION', async () => {
      // Les demandes precedentes non utilisees sont invalidees : un seul lien
      // actif a la fois.
      await this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: this.clock.now() },
      });

      await this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: this.hash.hashToken(token), expiresAt },
      });
    });

    const link = `${this.config.app.appUrl}/reinitialiser-mot-de-passe?token=${encodeURIComponent(token)}`;

    await this.mail.send({
      to: user.email,
      subject: 'EcomFlow — Reinitialisation de votre mot de passe',
      text: [
        `Bonjour ${user.fullName},`,
        '',
        'Vous avez demande la reinitialisation de votre mot de passe EcomFlow.',
        `Ce lien est valable ${PASSWORD_RESET_TTL_MINUTES} minutes :`,
        link,
        '',
        "Si vous n'etes pas a l'origine de cette demande, ignorez cet e-mail :",
        'votre mot de passe actuel reste valide.',
      ].join('\n'),
    });

    await this.audit.record({
      action: 'AUTH_PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user.id,
      actorUserId: user.id,
      tenantId: null,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = this.hash.hashToken(token);

    const stored = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.passwordResetToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, expiresAt: true, usedAt: true },
      }),
    );

    if (!stored || stored.usedAt || this.clock.isPast(stored.expiresAt)) {
      throw new BusinessException(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        'Ce lien de reinitialisation est invalide ou a expire. Demandez-en un nouveau.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const passwordHash = await this.hash.hashPassword(newPassword);

    await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.$transaction(async (tx) => {
        await tx.passwordResetToken.update({
          where: { id: stored.id },
          data: { usedAt: this.clock.now() },
        });
        await tx.user.update({
          where: { id: stored.userId },
          data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
        });
      }),
    );

    // Toutes les sessions tombent : si un attaquant detenait le compte, il
    // perd son acces au moment meme du changement.
    const revoked = await this.tokens.revokeAllForUser(stored.userId);
    this.access.invalidateUser(stored.userId);

    await this.audit.record({
      action: 'AUTH_PASSWORD_CHANGED',
      entityType: 'User',
      entityId: stored.userId,
      actorUserId: stored.userId,
      tenantId: null,
      metadata: { via: 'reset_link', revokedSessions: revoked },
    });
  }

  /**
   * Enregistre la preference de langue d'un utilisateur.
   *
   * Ecriture hors perimetre de tenant : la table `users` est globale a la
   * plateforme, un compte pouvant appartenir a plusieurs boutiques. La langue
   * de l'interface suit la PERSONNE, pas la boutique dans laquelle elle se
   * trouve a l'instant T.
   */
  async updatePreferences(
    userId: string,
    preferences: { locale: Locale },
  ): Promise<{ locale: string }> {
    const updated = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.update({
        where: { id: userId },
        data: { locale: preferences.locale },
        select: { locale: true },
      }),
    );

    return { locale: updated.locale };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
    );

    if (!user?.passwordHash || !(await this.hash.verifyPassword(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        'Le mot de passe actuel est incorrect.',
      );
    }

    const passwordHash = await this.hash.hashPassword(newPassword);
    await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    );

    const revoked = await this.tokens.revokeAllForUser(userId);
    this.access.invalidateUser(userId);

    await this.audit.record({
      action: 'AUTH_PASSWORD_CHANGED',
      entityType: 'User',
      entityId: userId,
      actorUserId: userId,
      metadata: { via: 'profile', revokedSessions: revoked },
    });
  }

  // =========================================================================
  // OTP
  // =========================================================================

  /** Demande un code de verification pour un numero (inscription). */
  async requestOtp(phone: string): Promise<{
    expiresAt: Date;
    phoneMasked: string;
    devCode?: string;
  }> {
    const parsed = parseAlgerianPhone(phone);
    if (!parsed.ok) {
      throw new ValidationException(
        'Numero de telephone algerien invalide. Format attendu : 0555 12 34 56.',
      );
    }

    const challenge = await this.otp.requestChallenge(phone, null, 'PHONE_VERIFICATION');
    return {
      expiresAt: challenge.expiresAt,
      phoneMasked: challenge.phoneMasked,
      ...(challenge.devCode ? { devCode: challenge.devCode } : {}),
    };
  }

  // =========================================================================
  // Construction de session
  // =========================================================================

  private async buildSession(
    userId: string,
    requestedTenantId: string | null,
    client: ClientMetadata,
  ): Promise<AuthSession> {
    const resolved = await this.access.resolve(userId, requestedTenantId);

    const tokens = await this.tokens.issueTokens(
      {
        userId,
        email: await this.getEmail(userId),
        tenantId: resolved.tenantId,
        membershipId: resolved.membershipId,
      },
      client,
    );

    return this.assembleSession(userId, resolved.tenantId, tokens);
  }

  private async buildSessionFromTokens(
    userId: string,
    tenantId: string | null,
    tokens: IssuedTokens,
  ): Promise<AuthSession> {
    return this.assembleSession(userId, tenantId, tokens);
  }

  private async assembleSession(
    userId: string,
    tenantId: string | null,
    tokens: IssuedTokens,
  ): Promise<AuthSession> {
    const resolved = await this.access.resolve(userId, tenantId);

    return RequestContextStore.runUnscoped('AUTHENTICATION', async () => {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true, fullName: true, phoneVerifiedAt: true },
      });

      const tenant = resolved.tenantId
        ? await this.prisma.tenant.findUnique({
            where: { id: resolved.tenantId },
            select: { id: true, name: true, slug: true, status: true },
          })
        : null;

      return {
        tokens,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          phoneVerified: user.phoneVerifiedAt !== null,
        },
        tenant,
        role: resolved.roleCode,
        permissions: [...resolved.permissions].sort(),
        isPlatformAdmin: resolved.isPlatformAdmin,
      };
    });
  }

  private async getEmail(userId: string): Promise<string> {
    const user = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    );
    return user.email;
  }

  // =========================================================================
  // Anti-forcage
  // =========================================================================

  private async registerFailedAttempt(userId: string, currentCount: number): Promise<void> {
    const next = currentCount + 1;
    const max = this.config.auth.maxFailedLogins;

    await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: next,
          lockedUntil:
            next >= max ? this.clock.inMinutes(this.config.auth.lockDurationMinutes) : null,
        },
      }),
    );

    if (next >= max) {
      this.logger.warn(
        `Compte ${userId} verrouille apres ${next} echecs de connexion consecutifs.`,
      );
    }
  }

  private async recordFailedLogin(
    email: string,
    _client: ClientMetadata,
    reason: string,
    userId?: string,
  ): Promise<void> {
    await this.audit.record({
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'User',
      entityId: userId ?? null,
      actorUserId: userId ?? null,
      actorKind: 'SYSTEM',
      tenantId: null,
      // L'e-mail est conserve : sans lui, impossible d'enqueter sur une
      // campagne de forcage. Le mot de passe tente n'est evidemment jamais
      // journalise.
      metadata: { email, reason },
    });
  }

  /**
   * Consomme un temps comparable a une verification Argon2 reelle.
   * Le hash factice est calcule une seule fois puis reutilise.
   */
  private async equalizeTiming(): Promise<void> {
    this.dummyHashPromise ??= this.hash.hashPassword(DUMMY_PASSWORD);
    const dummyHash = await this.dummyHashPromise;
    await this.hash.verifyPassword(dummyHash, 'mot-de-passe-quelconque');
  }

  private async sendWelcomeEmail(
    email: string,
    fullName: string,
    trialEndAt: Date | null,
  ): Promise<void> {
    const deadline = trialEndAt
      ? trialEndAt.toLocaleDateString('fr-DZ', { day: '2-digit', month: 'long', year: 'numeric' })
      : null;

    await this.mail.send({
      to: email,
      subject: 'Bienvenue sur EcomFlow — votre essai gratuit a demarre',
      text: [
        `Bonjour ${fullName},`,
        '',
        'Votre boutique EcomFlow est prete.',
        deadline ? `Votre essai gratuit de 7 jours court jusqu au ${deadline}.` : '',
        '',
        'Prochaine etape : connectez votre Google Sheet pour importer vos',
        'premieres commandes automatiquement.',
        `${this.config.app.appUrl}/onboarding`,
        '',
        "L'equipe EcomFlow",
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
}
