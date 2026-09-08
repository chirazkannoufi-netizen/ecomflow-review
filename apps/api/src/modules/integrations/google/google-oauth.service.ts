/**
 * Connexion Google par OAuth 2.0 — V2 §12, §29.
 *
 * PORTEE DES AUTORISATIONS DEMANDEES
 *   Seul `spreadsheets.readonly` est demande par defaut. EcomFlow n'a besoin
 *   que de LIRE les commandes. Demander un acces en ecriture a l'ensemble du
 *   Drive d'un commercant serait disproportionne, alarmerait l'utilisateur a
 *   l'ecran de consentement et augmenterait inutilement la surface en cas de
 *   fuite du jeton. L'ecriture (`spreadsheets`) n'est demandee que si la
 *   boutique active explicitement le renvoi du statut dans la feuille.
 *
 * STOCKAGE DES JETONS
 *   Le jeton de rafraichissement est chiffre au repos (AES-256-GCM) avec le
 *   `tenantId` comme donnee authentifiee : un blob copie d'une boutique vers
 *   une autre devient indechiffrable. Aucun jeton n'est jamais expose au
 *   frontend (V1 §12, V2 §31).
 *
 * PROTECTION CSRF
 *   Le parametre `state` porte un jeton aleatoire lie au tenant, verifie au
 *   retour. Sans lui, un tiers pourrait faire connecter SON compte Google a la
 *   boutique d'un commercant.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from '@ecomflow/shared';
import { AppConfigService } from '../../../config/configuration';
import { ClockService } from '../../../infra/clock/clock.service';
import { EncryptionService } from '../../../infra/crypto/encryption.service';
import { InjectPrisma, type PrismaClientExtended } from '../../../infra/prisma/prisma.service';
import {
  BusinessException,
  NotFoundException,
  ValidationException,
} from '../../../common/errors/business.exception';
import { HttpStatus } from '@nestjs/common';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const GOOGLE_SCOPES = {
  READ_ONLY: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  READ_WRITE: 'https://www.googleapis.com/auth/spreadsheets',
  DRIVE_METADATA: 'https://www.googleapis.com/auth/drive.metadata.readonly',
  EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
} as const;

/** Duree de validite du parametre `state` anti-CSRF. */
const STATE_TTL_MS = 10 * 60_000;

/** Marge de securite avant expiration du jeton d'acces. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface GoogleCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly scope: string;
  readonly accountEmail?: string;
}

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly config: AppConfigService,
    private readonly encryption: EncryptionService,
    private readonly clock: ClockService,
  ) {}

  isConfigured(): boolean {
    return this.config.google.configured;
  }

  /**
   * Etat de la connexion Google pour cette boutique.
   *
   * Deux questions distinctes, deux reponses distinctes :
   *   `installationConfigured` — l'installation possede-t-elle des identifiants
   *     OAuth ? Si non, aucun commercant ne peut se connecter, et l'interface
   *     doit le dire au lieu d'afficher un bouton qui echouera.
   *   `connected` — CETTE boutique a-t-elle autorise l'acces ?
   *
   * Aucun jeton n'est jamais renvoye : seuls l'etat et le libelle du compte.
   */
  async getStatus(tenantId: string): Promise<{
    installationConfigured: boolean;
    connected: boolean;
    status: string;
    accountLabel: string | null;
    connectedAt: Date | null;
    lastCheckedAt: Date | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }> {
    const integration = await this.prisma.integration.findFirst({
      where: { tenantId, provider: 'GOOGLE_SHEETS' },
      select: {
        status: true,
        accountLabel: true,
        connectedAt: true,
        lastCheckedAt: true,
        lastErrorCode: true,
        lastErrorMessage: true,
      },
    });

    return {
      installationConfigured: this.isConfigured(),
      connected: integration?.status === 'CONNECTED',
      status: integration?.status ?? 'DISCONNECTED',
      accountLabel: integration?.accountLabel ?? null,
      connectedAt: integration?.connectedAt ?? null,
      lastCheckedAt: integration?.lastCheckedAt ?? null,
      lastErrorCode: integration?.lastErrorCode ?? null,
      lastErrorMessage: integration?.lastErrorMessage ?? null,
    };
  }

  /**
   * URL de consentement Google.
   *
   * `access_type=offline` et `prompt=consent` sont indispensables : sans eux,
   * Google ne renvoie pas de jeton de rafraichissement lors d'une reconnexion,
   * et la synchronisation s'arreterait au bout d'une heure.
   */
  buildAuthorizationUrl(tenantId: string, options: { allowWrite?: boolean } = {}): {
    url: string;
    state: string;
  } {
    this.assertConfigured();

    const state = this.createState(tenantId);
    const scopes = [
      options.allowWrite ? GOOGLE_SCOPES.READ_WRITE : GOOGLE_SCOPES.READ_ONLY,
      GOOGLE_SCOPES.DRIVE_METADATA,
      GOOGLE_SCOPES.EMAIL,
    ];

    const params = new URLSearchParams({
      client_id: this.config.google.clientId as string,
      redirect_uri: this.config.google.redirectUri as string,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });

    return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state };
  }

  /**
   * Finalise la connexion : echange le code contre des jetons et persiste
   * l'integration.
   */
  async handleCallback(code: string, state: string): Promise<{ tenantId: string; email: string }> {
    this.assertConfigured();

    const tenantId = this.verifyState(state);
    const tokens = await this.exchangeCode(code);
    const email = await this.fetchAccountEmail(tokens.access_token);

    const credentials: GoogleCredentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(this.clock.timestamp() + tokens.expires_in * 1000).toISOString(),
      scope: tokens.scope,
      accountEmail: email,
    };

    await this.prisma.integration.upsert({
      where: { tenantId_provider: { tenantId, provider: 'GOOGLE_SHEETS' } },
      create: {
        tenantId,
        type: 'ORDER_SOURCE',
        provider: 'GOOGLE_SHEETS',
        label: 'Google Sheets',
        status: 'CONNECTED',
        credentialsEncrypted: this.encryption.encryptJson(credentials, tenantId),
        accountLabel: email,
        connectedAt: this.clock.now(),
        lastCheckedAt: this.clock.now(),
      },
      update: {
        status: 'CONNECTED',
        credentialsEncrypted: this.encryption.encryptJson(credentials, tenantId),
        accountLabel: email,
        connectedAt: this.clock.now(),
        lastCheckedAt: this.clock.now(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    this.logger.log(`Google Sheets connecte pour la boutique ${tenantId} (compte ${email}).`);
    return { tenantId, email };
  }

  /**
   * Jeton d'acces valide pour une boutique, rafraichi automatiquement.
   *
   * @throws BusinessException GOOGLE_AUTH_REVOKED si le commercant a revoque
   *         l'acces depuis son compte Google. L'integration passe alors en
   *         erreur et l'incident devient visible dans l'interface, plutot que
   *         de laisser la synchronisation echouer silencieusement.
   */
  async getAccessToken(tenantId: string): Promise<string> {
    const integration = await this.prisma.integration.findFirst({
      where: { tenantId, provider: 'GOOGLE_SHEETS' },
      select: { id: true, credentialsEncrypted: true, status: true },
    });

    if (!integration?.credentialsEncrypted) {
      throw new NotFoundException(
        ERROR_CODES.INTEGRATION_NOT_CONNECTED,
        'Aucun compte Google connecte pour cette boutique.',
      );
    }

    const credentials = this.encryption.decryptJson<GoogleCredentials>(
      integration.credentialsEncrypted,
      tenantId,
    );

    const expiresAt = new Date(credentials.expiresAt).getTime();
    if (expiresAt - TOKEN_REFRESH_MARGIN_MS > this.clock.timestamp()) {
      return credentials.accessToken;
    }

    return this.refreshAccessToken(tenantId, integration.id, credentials);
  }

  /** Coupe la connexion et revoque le jeton cote Google. */
  async disconnect(tenantId: string): Promise<void> {
    const integration = await this.prisma.integration.findFirst({
      where: { tenantId, provider: 'GOOGLE_SHEETS' },
      select: { id: true, credentialsEncrypted: true },
    });

    if (!integration) return;

    if (integration.credentialsEncrypted) {
      try {
        const credentials = this.encryption.decryptJson<GoogleCredentials>(
          integration.credentialsEncrypted,
          tenantId,
        );
        // Revoquer cote Google est une politesse envers l'utilisateur : son
        // compte ne garde pas une autorisation orpheline. L'echec n'empeche
        // pas la deconnexion locale.
        await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(credentials.refreshToken)}`, {
          method: 'POST',
        }).catch(() => undefined);
      } catch {
        // Jeton indechiffrable : rien a revoquer.
      }
    }

    await this.prisma.$transaction([
      this.prisma.sheetSyncConfig.updateMany({
        where: { tenantId, integrationId: integration.id },
        data: { isActive: false },
      }),
      this.prisma.integration.update({
        where: { id: integration.id },
        data: {
          status: 'DISCONNECTED',
          credentialsEncrypted: null,
          accountLabel: null,
          connectedAt: null,
        },
      }),
    ]);

    this.logger.log(`Google Sheets deconnecte pour la boutique ${tenantId}.`);
  }

  // -------------------------------------------------------------------------

  private async refreshAccessToken(
    tenantId: string,
    integrationId: string,
    credentials: GoogleCredentials,
  ): Promise<string> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.google.clientId as string,
        client_secret: this.config.google.clientSecret as string,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      const revoked = detail.error === 'invalid_grant';

      await this.prisma.integration.update({
        where: { id: integrationId },
        data: {
          status: 'ERROR',
          lastErrorCode: revoked ? ERROR_CODES.GOOGLE_AUTH_REVOKED : ERROR_CODES.GOOGLE_AUTH_EXPIRED,
          lastErrorMessage: revoked
            ? 'Acces revoque depuis le compte Google. Une reconnexion est necessaire.'
            : `Rafraichissement du jeton refuse (${detail.error ?? response.status}).`,
          lastCheckedAt: this.clock.now(),
        },
      });

      throw new BusinessException(
        revoked ? ERROR_CODES.GOOGLE_AUTH_REVOKED : ERROR_CODES.GOOGLE_AUTH_EXPIRED,
        revoked
          ? 'L acces Google a ete revoque. Reconnectez votre compte pour reprendre la synchronisation.'
          : 'Impossible de renouveler l acces Google.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const tokens = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };

    // Google ne renvoie PAS de nouveau `refresh_token` lors d'un
    // rafraichissement : on conserve celui d'origine.
    const updated: GoogleCredentials = {
      ...credentials,
      accessToken: tokens.access_token,
      expiresAt: new Date(this.clock.timestamp() + tokens.expires_in * 1000).toISOString(),
      scope: tokens.scope ?? credentials.scope,
    };

    await this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        credentialsEncrypted: this.encryption.encryptJson(updated, tenantId),
        status: 'CONNECTED',
        lastErrorCode: null,
        lastErrorMessage: null,
        lastCheckedAt: this.clock.now(),
      },
    });

    return updated.accessToken;
  }

  private async exchangeCode(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  }> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.google.clientId as string,
        client_secret: this.config.google.clientSecret as string,
        redirect_uri: this.config.google.redirectUri as string,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new BusinessException(
        ERROR_CODES.GOOGLE_AUTH_EXPIRED,
        'Google a refuse le code d autorisation. Relancez la connexion.',
        HttpStatus.BAD_GATEWAY,
        { details: { status: response.status, detail } },
      );
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };

    if (!tokens.refresh_token) {
      // Sans jeton de rafraichissement, la synchronisation cesserait au bout
      // d'une heure. Mieux vaut echouer maintenant avec une consigne claire.
      throw new BusinessException(
        ERROR_CODES.GOOGLE_AUTH_EXPIRED,
        'Google n a pas fourni de jeton de rafraichissement. Revoquez l acces ' +
          'd EcomFlow dans les parametres de securite de votre compte Google, ' +
          'puis relancez la connexion.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
    };
  }

  private async fetchAccountEmail(accessToken: string): Promise<string> {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return 'compte Google';
    const profile = (await response.json()) as { email?: string };
    return profile.email ?? 'compte Google';
  }

  // --- Protection CSRF du parametre `state` --------------------------------

  /**
   * `state` = tenantId.horodatage.nonce.signature
   *
   * Signe par HMAC : impossible a forger sans le poivre serveur. Aucun
   * stockage n'est necessaire, ce qui evite une table a nettoyer et rend le
   * mecanisme insensible a un redemarrage pendant le parcours OAuth.
   */
  private createState(tenantId: string): string {
    const issuedAt = this.clock.timestamp().toString(36);
    const nonce = randomBytes(12).toString('base64url');
    const payload = `${tenantId}.${issuedAt}.${nonce}`;
    return `${payload}.${this.signState(payload)}`;
  }

  private verifyState(state: string): string {
    const parts = state.split('.');
    if (parts.length !== 4) {
      throw new ValidationException('Parametre state invalide.');
    }

    const [tenantId, issuedAt, nonce, signature] = parts as [string, string, string, string];
    const payload = `${tenantId}.${issuedAt}.${nonce}`;

    const expected = Buffer.from(this.signState(payload), 'utf8');
    const provided = Buffer.from(signature, 'utf8');

    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      this.logger.warn('Callback Google avec un state non signe correctement : rejete.');
      throw new ValidationException('Parametre state invalide.');
    }

    const age = this.clock.timestamp() - Number.parseInt(issuedAt, 36);
    if (Number.isNaN(age) || age > STATE_TTL_MS || age < 0) {
      throw new ValidationException(
        'Le parcours de connexion Google a expire. Relancez-le depuis les integrations.',
      );
    }

    return tenantId;
  }

  private signState(payload: string): string {
    return createHmac('sha256', this.config.hashPepper)
      .update(`google-oauth:${payload}`)
      .digest('base64url');
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new BusinessException(
        ERROR_CODES.INTEGRATION_NOT_CONNECTED,
        'La connexion Google n est pas configuree sur cette installation ' +
          '(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
