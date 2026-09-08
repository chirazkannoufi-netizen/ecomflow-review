/**
 * Verification de numero de telephone par code a usage unique (OTP).
 *
 * Finalite : Addendum §38 — « lier chaque Trial a un identifiant verifie et
 * difficile a dupliquer : numero de telephone confirme par OTP, unique par
 * tenant ». C'est le signal fort de la prevention d'abus de l'essai gratuit.
 *
 * PROTECTIONS EN PLACE
 *  - le code n'est jamais stocke en clair (empreinte HMAC poivree) ;
 *  - nombre d'essais borne : au-dela, le defi est consomme et un nouveau code
 *    doit etre demande, ce qui empeche le forcage des 10^6 combinaisons ;
 *  - un seul defi actif par numero : demander un nouveau code invalide le
 *    precedent, ce qui evite d'elargir la fenetre d'attaque ;
 *  - limitation de debit a l'envoi, pour ne pas transformer l'API en
 *    generateur de SMS a la charge de la plateforme.
 *
 * LIMITE ACTUELLE, ASSUMEE ET DOCUMENTEE
 *  Le pilote `console` affiche le code dans les journaux : il n'envoie rien.
 *  C'est le pilote de developpement. Les pilotes `sms` et `whatsapp` exigent
 *  un fournisseur configure ; tant qu'il ne l'est pas, `OtpService` le declare
 *  explicitement au lieu de simuler un envoi reussi.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, maskPhone, parseAlgerianPhone } from '@ecomflow/shared';
import { AppConfigService } from '../../config/configuration';
import { ClockService } from '../../infra/clock/clock.service';
import { HashService } from '../../infra/crypto/hash.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { BusinessException, ValidationException } from '../../common/errors/business.exception';
import { HttpStatus } from '@nestjs/common';
import { WhatsappGateway } from '../whatsapp/whatsapp.gateway';

/** Delai minimal entre deux demandes de code pour un meme numero. */
const RESEND_COOLDOWN_SECONDS = 60;

export interface OtpChallengeResult {
  readonly challengeId: string;
  readonly expiresAt: Date;
  readonly phoneMasked: string;
  /**
   * Renseigne UNIQUEMENT avec le pilote `console`, en developpement.
   * Permet aux tests de bout en bout et a l'onboarding local de fonctionner
   * sans fournisseur SMS. Jamais renseigne en production : la validation
   * d'environnement impose alors un autre pilote.
   */
  readonly devCode?: string;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly hash: HashService,
    private readonly clock: ClockService,
    private readonly config: AppConfigService,
    private readonly whatsapp: WhatsappGateway,
  ) {}

  /**
   * Emet un code de verification pour un numero algerien.
   *
   * @param phoneInput numero saisi, sous n'importe quelle forme
   * @param userId compte associe, s'il existe deja
   */
  async requestChallenge(
    phoneInput: string,
    userId: string | null,
    purpose: 'PHONE_VERIFICATION' | 'LOGIN' = 'PHONE_VERIFICATION',
  ): Promise<OtpChallengeResult> {
    const parsed = parseAlgerianPhone(phoneInput);
    if (!parsed.ok) {
      throw new ValidationException(
        'Numero de telephone algerien invalide. Format attendu : 0555 12 34 56.',
        { details: { reason: parsed.error } },
      );
    }

    const phoneE164 = parsed.value.e164;

    return RequestContextStore.runUnscoped('AUTHENTICATION', async () => {
      // --- Anti-abus : delai minimal entre deux envois ---------------------
      const recent = await this.prisma.otpChallenge.findFirst({
        where: { phoneE164, purpose, consumedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      if (recent) {
        const elapsedSeconds = (this.clock.timestamp() - recent.createdAt.getTime()) / 1000;
        if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
          const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds);
          throw new BusinessException(
            ERROR_CODES.RATE_LIMITED,
            `Un code a deja ete envoye. Reessayez dans ${wait} seconde(s).`,
            HttpStatus.TOO_MANY_REQUESTS,
            { details: { retryAfterSeconds: wait } },
          );
        }
      }

      // Un seul defi actif par numero : les precedents sont consommes.
      await this.prisma.otpChallenge.updateMany({
        where: { phoneE164, purpose, consumedAt: null },
        data: { consumedAt: this.clock.now() },
      });

      const code = this.hash.generateOtpCode(6);
      const expiresAt = this.clock.inMinutes(this.config.otp.ttlMinutes);

      const challenge = await this.prisma.otpChallenge.create({
        data: {
          userId,
          phoneE164,
          purpose,
          codeHash: this.hash.hashOtp(code),
          expiresAt,
        },
        select: { id: true },
      });

      const delivered = await this.deliver(phoneE164, code);

      return {
        challengeId: challenge.id,
        expiresAt,
        phoneMasked: maskPhone(phoneE164),
        ...(delivered.exposeCode ? { devCode: code } : {}),
      };
    });
  }

  /**
   * Verifie un code et retourne le numero normalise en cas de succes.
   *
   * @throws BusinessException si le code est invalide, expire ou si le nombre
   *         maximal de tentatives est atteint.
   */
  async verifyChallenge(
    phoneInput: string,
    code: string,
    purpose: 'PHONE_VERIFICATION' | 'LOGIN' = 'PHONE_VERIFICATION',
  ): Promise<{ phoneE164: string; userId: string | null }> {
    const parsed = parseAlgerianPhone(phoneInput);
    if (!parsed.ok) {
      throw new ValidationException('Numero de telephone invalide.');
    }
    const phoneE164 = parsed.value.e164;

    return RequestContextStore.runUnscoped('AUTHENTICATION', async () => {
      const challenge = await this.prisma.otpChallenge.findFirst({
        where: { phoneE164, purpose, consumedAt: null },
        orderBy: { createdAt: 'desc' },
      });

      if (!challenge) {
        throw new BusinessException(
          ERROR_CODES.AUTH_OTP_INVALID,
          'Aucun code en attente pour ce numero. Demandez un nouveau code.',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (this.clock.isPast(challenge.expiresAt)) {
        await this.prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: this.clock.now() },
        });
        throw new BusinessException(
          ERROR_CODES.AUTH_OTP_EXPIRED,
          'Ce code a expire. Demandez-en un nouveau.',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (challenge.attempts >= challenge.maxAttempts) {
        await this.prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: this.clock.now() },
        });
        throw new BusinessException(
          ERROR_CODES.AUTH_OTP_TOO_MANY_ATTEMPTS,
          'Trop de tentatives. Demandez un nouveau code.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (!this.hash.verifyOtp(code.trim(), challenge.codeHash)) {
        const updated = await this.prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
          select: { attempts: true, maxAttempts: true },
        });
        throw new BusinessException(
          ERROR_CODES.AUTH_OTP_INVALID,
          'Code incorrect.',
          HttpStatus.BAD_REQUEST,
          { details: { attemptsRemaining: Math.max(0, updated.maxAttempts - updated.attempts) } },
        );
      }

      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: this.clock.now() },
      });

      return { phoneE164, userId: challenge.userId };
    });
  }

  /** Supprime les defis expires (job de menage). */
  async purgeExpired(): Promise<number> {
    const cutoff = this.clock.addDays(this.clock.now(), -7);
    const result = await RequestContextStore.runUnscoped('BACKGROUND_JOB', () =>
      this.prisma.otpChallenge.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    );
    return result.count;
  }

  /**
   * Achemine le code vers le destinataire.
   *
   * Retourne `exposeCode: true` uniquement pour le pilote `console`, ou aucun
   * envoi n'a lieu : l'appelant peut alors afficher le code en developpement.
   */
  private async deliver(
    phoneE164: string,
    code: string,
  ): Promise<{ exposeCode: boolean }> {
    switch (this.config.otp.driver) {
      case 'whatsapp': {
        if (!this.whatsapp.isConfigured()) {
          this.logger.error(
            'OTP_DRIVER=whatsapp mais la passerelle WhatsApp n est pas configuree. ' +
              'Aucun code n a ete envoye.',
          );
          throw new BusinessException(
            ERROR_CODES.WHATSAPP_NOT_CONFIGURED,
            'Le service de verification par WhatsApp n est pas disponible.',
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
        await this.whatsapp.sendVerificationCode(phoneE164, code);
        return { exposeCode: false };
      }

      case 'sms': {
        // Aucun agregateur SMS algerien n'est integre a ce jour. Plutot que de
        // faire croire a un envoi, on echoue explicitement : la regle de
        // veracite (prompt produit §5) interdit de simuler une integration.
        this.logger.error(
          'OTP_DRIVER=sms : aucun fournisseur SMS n est integre. ' +
            'Configurez OTP_DRIVER=whatsapp ou integrez un agregateur.',
        );
        throw new BusinessException(
          ERROR_CODES.INTERNAL_ERROR,
          'Le service de verification par SMS n est pas disponible.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      case 'console':
      default: {
        this.logger.warn(
          `[OTP developpement] Code pour ${maskPhone(phoneE164)} : ${code} ` +
            '(pilote console — aucun message reel envoye)',
        );
        return { exposeCode: !this.config.isProduction };
      }
    }
  }
}
