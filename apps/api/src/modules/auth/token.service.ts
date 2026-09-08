/**
 * Emission et verification des jetons.
 *
 * MODELE : jeton d'acces court (15 min) + jeton de rafraichissement long
 * (30 j) A ROTATION, avec detection de rejeu.
 *
 * Pourquoi la rotation avec detection de rejeu :
 *   Un jeton de rafraichissement vole est indiscernable d'un jeton legitime.
 *   En le faisant tourner a chaque usage, un vol devient detectable : si
 *   l'ancien jeton est presente une seconde fois, c'est que deux porteurs
 *   existent. On revoque alors TOUTE LA FAMILLE, ce qui deconnecte l'attaquant
 *   et l'utilisateur legitime — lequel se reconnectera avec son mot de passe.
 *   C'est la recommandation OAuth 2.0 pour les clients publics (RFC 9700).
 *
 * Le jeton de rafraichissement n'est stocke qu'en EMPREINTE (HMAC poivre) :
 * une base compromise ne permet pas d'usurper une session.
 */

import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '@ecomflow/shared';
import { AppConfigService } from '../../config/configuration';
import { ClockService } from '../../infra/clock/clock.service';
import { HashService } from '../../infra/crypto/hash.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { UnauthorizedException } from '../../common/errors/business.exception';
import { RequestContextStore } from '../../infra/context/request-context';

/** Charge utile du jeton d'acces. */
export interface AccessTokenPayload {
  /** Identifiant utilisateur. */
  sub: string;
  email: string;
  /** Boutique active, `null` pour un Super Admin sans boutique selectionnee. */
  tid: string | null;
  /** Adhesion correspondante. */
  mid: string | null;
  /** Type de jeton : empeche d'utiliser un refresh comme access. */
  typ: 'access';
  /** Identifiant unique du jeton, utile a la revocation ciblee. */
  jti: string;
  iat?: number;
  exp?: number;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
}

export interface RefreshContext {
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly hash: HashService,
    private readonly clock: ClockService,
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
  ) {}

  /**
   * Emet un couple de jetons et ouvre une nouvelle famille de rafraichissement.
   * Appele a la connexion et apres un changement de boutique active.
   */
  async issueTokens(
    params: { userId: string; email: string; tenantId: string | null; membershipId: string | null },
    context: RefreshContext = {},
  ): Promise<IssuedTokens> {
    const familyId = randomUUID();
    return this.issueForFamily(params, familyId, context);
  }

  /**
   * Echange un jeton de rafraichissement contre un nouveau couple.
   *
   * @throws UnauthorizedException si le jeton est inconnu, expire, revoque
   *         ou deja utilise (rejeu).
   */
  async rotate(
    refreshToken: string,
    context: RefreshContext = {},
  ): Promise<IssuedTokens & { userId: string; tenantId: string | null; membershipId: string | null }> {
    const tokenHash = this.hash.hashToken(refreshToken);

    // L'authentification s'execute hors perimetre tenant : le tenant n'est
    // connu qu'apres resolution du jeton.
    const stored = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { id: true, email: true, status: true } } },
      }),
    );

    if (!stored) {
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        'Session invalide. Veuillez vous reconnecter.',
      );
    }

    // --- Detection de rejeu ------------------------------------------------
    // Le jeton existe mais a deja ete revoque : soit l'utilisateur s'est
    // deconnecte, soit un attaquant rejoue un jeton derobe. Dans le doute, on
    // revoque toute la famille.
    if (stored.revokedAt) {
      await this.revokeFamily(stored.familyId, 'Rejeu de jeton de rafraichissement detecte');
      this.logger.error(
        `REJEU DE JETON DETECTE — utilisateur=${stored.userId} famille=${stored.familyId}. ` +
          'Toutes les sessions de cette famille ont ete revoquees.',
      );
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_REFRESH_REUSED,
        'Cette session a ete revoquee pour raison de securite. Veuillez vous reconnecter.',
      );
    }

    if (this.clock.isPast(stored.expiresAt)) {
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_TOKEN_EXPIRED,
        'Session expiree. Veuillez vous reconnecter.',
      );
    }

    if (stored.user.status !== 'ACTIVE') {
      throw new UnauthorizedException(
        ERROR_CODES.AUTH_ACCOUNT_DISABLED,
        'Ce compte n est pas actif.',
      );
    }

    const membership = await this.resolveMembershipForRefresh(stored.userId);

    const issued = await this.issueForFamily(
      {
        userId: stored.userId,
        email: stored.user.email,
        tenantId: membership?.tenantId ?? null,
        membershipId: membership?.id ?? null,
      },
      stored.familyId,
      context,
    );

    // Revocation de l'ancien jeton, avec chainage vers le nouveau : l'historique
    // de rotation reste lisible pour une investigation.
    await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: {
          revokedAt: this.clock.now(),
          replacedById: issued.refreshTokenId,
        },
      }),
    );

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt,
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
      userId: stored.userId,
      tenantId: membership?.tenantId ?? null,
      membershipId: membership?.id ?? null,
    };
  }

  /** Revoque un jeton precis (deconnexion). */
  async revoke(refreshToken: string): Promise<void> {
    const tokenHash = this.hash.hashToken(refreshToken);
    await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: this.clock.now() },
      }),
    );
  }

  /** Revoque toutes les sessions d'une famille (rejeu detecte). */
  async revokeFamily(familyId: string, _reason: string): Promise<void> {
    await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: this.clock.now() },
      }),
    );
  }

  /** Revoque toutes les sessions d'un utilisateur (changement de mot de passe). */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: this.clock.now() },
      }),
    );
    return result.count;
  }

  /** Verifie un jeton d'acces et retourne sa charge utile. */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.auth.accessSecret,
      });

      // Un jeton de rafraichissement ne doit jamais etre accepte comme jeton
      // d'acces : il vit bien plus longtemps.
      if (payload.typ !== 'access') {
        throw new UnauthorizedException(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          'Type de jeton incorrect.',
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      const name = (error as { name?: string }).name;
      if (name === 'TokenExpiredError') {
        throw new UnauthorizedException(
          ERROR_CODES.AUTH_TOKEN_EXPIRED,
          'Jeton d acces expire.',
        );
      }
      throw new UnauthorizedException(ERROR_CODES.AUTH_TOKEN_INVALID, 'Jeton d acces invalide.');
    }
  }

  /** Supprime les jetons expires depuis plus de 30 jours (job de menage). */
  async purgeExpiredTokens(): Promise<number> {
    const cutoff = this.clock.addDays(this.clock.now(), -30);
    const result = await RequestContextStore.runUnscoped('BACKGROUND_JOB', () =>
      this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    );
    return result.count;
  }

  // -------------------------------------------------------------------------

  private async issueForFamily(
    params: { userId: string; email: string; tenantId: string | null; membershipId: string | null },
    familyId: string,
    context: RefreshContext,
  ): Promise<IssuedTokens & { refreshTokenId: string }> {
    const now = this.clock.now();

    const payload: AccessTokenPayload = {
      sub: params.userId,
      email: params.email,
      tid: params.tenantId,
      mid: params.membershipId,
      typ: 'access',
      jti: randomUUID(),
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.auth.accessSecret,
      expiresIn: this.config.auth.accessTtl,
    });

    const refreshToken = this.hash.generateToken(48);
    const refreshTokenExpiresAt = new Date(
      now.getTime() + parseDuration(this.config.auth.refreshTtl),
    );

    const created = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.refreshToken.create({
        data: {
          userId: params.userId,
          tokenHash: this.hash.hashToken(refreshToken),
          familyId,
          expiresAt: refreshTokenExpiresAt,
          userAgent: context.userAgent?.slice(0, 255) ?? null,
          ipAddress: context.ipAddress ?? null,
        },
        select: { id: true },
      }),
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(now.getTime() + parseDuration(this.config.auth.accessTtl)),
      refreshTokenExpiresAt,
      refreshTokenId: created.id,
    };
  }

  /**
   * Determine la boutique a reactiver lors d'un rafraichissement.
   *
   * On relit l'adhesion en base plutot que de faire confiance au jeton :
   * l'utilisateur a pu etre retire de la boutique entre-temps, et le
   * rafraichissement doit alors refleter cette revocation immediatement.
   */
  private async resolveMembershipForRefresh(
    userId: string,
  ): Promise<{ id: string; tenantId: string } | null> {
    const memberships = await RequestContextStore.runUnscoped('AUTHENTICATION', () =>
      this.prisma.membership.findMany({
        where: { userId, status: 'ACTIVE' },
        select: { id: true, tenantId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return memberships[0] ?? null;
  }
}

/** Convertit « 15m », « 30d », « 3600s » en millisecondes. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(`Duree invalide : ${value}. Format attendu : 15m, 24h, 7d.`);
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const multiplier = multipliers[unit];
  /* istanbul ignore next -- la regex restreint deja l unite a s|m|h|d */
  if (!multiplier) throw new Error(`Unite de duree inconnue : ${unit}`);
  return amount * multiplier;
}
