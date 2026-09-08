/**
 * Prevention de l'abus de l'essai gratuit — Addendum §38.
 *
 * PROBLEME : sans garde-fou, un vendeur peut creer une nouvelle boutique tous
 * les 7 jours et rester indefiniment en essai. Le modele d'abonnement serait
 * contournable des le lancement.
 *
 * PRINCIPES APPLIQUES (prompt produit §35)
 *
 *  1. AUCUNE DONNEE FRAGILE SEULE NE BLOQUE.
 *     Une IP partagee (cybercafe, NAT operateur, 4G) ou une empreinte
 *     d'appareil identique (navigateur durci, machine partagee) sont des
 *     signaux FAIBLES. Pris isolement, ils ne declenchent rien. Seul le
 *     numero verifie par OTP — identifiant fort, coutant un vrai numero
 *     algerien a dupliquer — suffit a lui seul.
 *
 *  2. EXPLICABLE.
 *     Chaque decision retourne la liste des signaux et leur poids. Le Super
 *     Admin voit exactement pourquoi un compte est en revue.
 *
 *  3. RESPECTUEUX DE LA VIE PRIVEE (loi 18-07, Addendum §37).
 *     IP et empreinte d'appareil ne sont JAMAIS stockees en clair : seule
 *     leur empreinte HMAC est conservee. On garde la capacite de detecter une
 *     reutilisation sans constituer un fichier d'adresses IP.
 *
 *  4. FAILLIBLE DU BON COTE.
 *     En cas de doute, la decision est `MANUAL_REVIEW` (l'essai demarre et un
 *     humain tranche), jamais un blocage silencieux. Bloquer a tort un vrai
 *     commercant coute plus cher que laisser passer un abus.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  assessTrialAbuse,
  TRIAL_ABUSE_WINDOW_DAYS,
  type TrialAbuseAssessment,
  type TrialAbuseSignal,
} from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { HashService } from '../../infra/crypto/hash.service';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';

/**
 * Nombre de boutiques creees depuis une meme empreinte technique sur la
 * fenetre d'observation, au-dela duquel le signal RAPID_TENANT_CREATION est
 * leve.
 */
const RAPID_CREATION_THRESHOLD = 2;

export interface TrialSignalInput {
  readonly email: string;
  readonly verifiedPhoneE164: string | null;
  readonly ipAddress: string | null;
  readonly deviceFingerprint: string | null;
}

export interface TrialAbuseEvaluation extends TrialAbuseAssessment {
  /** Empreintes a persister avec l'inscription. */
  readonly hashes: {
    readonly emailNormalized: string;
    readonly ipHash: string | null;
    readonly deviceFingerprintHash: string | null;
  };
}

@Injectable()
export class TrialAbuseService {
  private readonly logger = new Logger(TrialAbuseService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly hash: HashService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Evalue le risque d'abus AVANT la creation de la boutique.
   *
   * @returns une decision explicable ; `BLOCK` interdit la creation, tout le
   *          reste l'autorise (avec ou sans revue manuelle ulterieure).
   */
  async evaluate(input: TrialSignalInput): Promise<TrialAbuseEvaluation> {
    const emailNormalized = normalizeEmailForComparison(input.email);
    const ipHash = input.ipAddress ? this.hash.hashSignal(input.ipAddress) : null;
    const deviceFingerprintHash = input.deviceFingerprint
      ? this.hash.hashSignal(input.deviceFingerprint)
      : null;

    const since = this.clock.addDays(this.clock.now(), -TRIAL_ABUSE_WINDOW_DAYS);
    const signals: TrialAbuseSignal[] = [];

    await RequestContextStore.runUnscoped('AUTHENTICATION', async () => {
      // --- Signal FORT : numero verifie deja utilise -----------------------
      // Un numero algerien verifie par OTP est cher a dupliquer. C'est le seul
      // signal qui suffit, a lui seul, a refuser un nouvel essai.
      if (input.verifiedPhoneE164) {
        const existing = await this.prisma.trialRegistration.findFirst({
          where: { verifiedPhoneE164: input.verifiedPhoneE164 },
          select: { id: true },
        });
        if (existing) signals.push('VERIFIED_PHONE_REUSED');
      }

      // --- Signal MOYEN : adresse e-mail derivee ---------------------------
      // `sara+2@gmail.com` et `s.a.r.a@gmail.com` designent la meme boite chez
      // les fournisseurs qui ignorent les points et les suffixes `+`.
      const emailTwin = await this.prisma.trialRegistration.findFirst({
        where: { emailNormalized, createdAt: { gte: since } },
        select: { id: true },
      });
      if (emailTwin) signals.push('EMAIL_LOCAL_PART_REUSED');

      // --- Signal MOYEN : meme appareil ------------------------------------
      if (deviceFingerprintHash) {
        const deviceCount = await this.prisma.trialRegistration.count({
          where: { deviceFingerprintHash, createdAt: { gte: since } },
        });
        if (deviceCount > 0) signals.push('SAME_DEVICE_FINGERPRINT');
        if (deviceCount >= RAPID_CREATION_THRESHOLD) signals.push('RAPID_TENANT_CREATION');
      }

      // --- Signal FAIBLE : meme IP -----------------------------------------
      // Volontairement peu pondere : en Algerie, le partage d'IP est la norme
      // (NAT operateur mobile, connexions partagees). Ce signal ne sert qu'a
      // renforcer un faisceau, jamais a decider seul.
      if (ipHash) {
        const ipCount = await this.prisma.trialRegistration.count({
          where: { ipHash, createdAt: { gte: since } },
        });
        if (ipCount > 0) signals.push('SAME_IP_RECENT');
        if (ipCount >= RAPID_CREATION_THRESHOLD && !signals.includes('RAPID_TENANT_CREATION')) {
          signals.push('RAPID_TENANT_CREATION');
        }
      }
    });

    const assessment = assessTrialAbuse(signals);

    if (assessment.decision !== 'ALLOW') {
      this.logger.warn(
        `Essai gratuit signale (${assessment.decision}, score ${assessment.score}) : ` +
          assessment.signals.join(', '),
      );
    }

    return {
      ...assessment,
      hashes: { emailNormalized, ipHash, deviceFingerprintHash },
    };
  }

  /**
   * Persiste l'empreinte d'inscription. Appele DANS la transaction de creation
   * de la boutique, afin qu'une boutique ne puisse jamais exister sans sa
   * trace anti-abus.
   */
  async recordRegistration(
    tx: PrismaTransactionClient,
    params: {
      tenantId: string;
      userId: string;
      evaluation: TrialAbuseEvaluation;
      verifiedPhoneE164: string | null;
    },
  ): Promise<void> {
    await tx.trialRegistration.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        verifiedPhoneE164: params.verifiedPhoneE164,
        emailNormalized: params.evaluation.hashes.emailNormalized,
        ipHash: params.evaluation.hashes.ipHash,
        deviceFingerprintHash: params.evaluation.hashes.deviceFingerprintHash,
        signals: [...params.evaluation.signals],
        score: params.evaluation.score,
        decision: params.evaluation.decision,
      },
    });
  }

  /** File de revue manuelle du Super Admin. */
  async listPendingReviews(limit = 50): Promise<
    {
      id: string;
      tenantId: string;
      score: number;
      signals: string[];
      createdAt: Date;
      tenantName: string;
    }[]
  > {
    return RequestContextStore.runUnscoped('PLATFORM_ADMIN', async () => {
      const rows = await this.prisma.trialRegistration.findMany({
        where: { decision: 'MANUAL_REVIEW', reviewedAt: null },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: {
          id: true,
          tenantId: true,
          score: true,
          signals: true,
          createdAt: true,
          tenant: { select: { name: true } },
        },
      });

      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        score: row.score,
        signals: row.signals,
        createdAt: row.createdAt,
        tenantName: row.tenant.name,
      }));
    });
  }
}

/**
 * Normalise une adresse e-mail pour la COMPARAISON anti-abus uniquement.
 *
 * Retire les suffixes `+...` et, pour les domaines qui les ignorent, les
 * points de la partie locale. Cette forme n'est jamais utilisee pour
 * l'authentification : l'adresse reelle reste seule identifiante.
 */
export function normalizeEmailForComparison(email: string): string {
  const [rawLocal, rawDomain] = email.trim().toLowerCase().split('@');
  if (!rawLocal || !rawDomain) return email.trim().toLowerCase();

  let local = rawLocal.split('+')[0] ?? rawLocal;

  // Domaines connus pour ignorer les points dans la partie locale.
  const dotInsensitiveDomains = ['gmail.com', 'googlemail.com'];
  if (dotInsensitiveDomains.includes(rawDomain)) {
    local = local.replace(/\./g, '');
  }

  return `${local}@${rawDomain}`;
}
