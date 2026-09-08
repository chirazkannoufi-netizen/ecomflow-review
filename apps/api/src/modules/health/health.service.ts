import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/configuration';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { MailService } from '../notifications/mail/mail.service';
import { WhatsappGateway } from '../whatsapp/whatsapp.gateway';

export type CheckStatus = 'up' | 'down' | 'degraded' | 'disabled';

export interface HealthCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly durationMs?: number;
  readonly detail?: string;
  /** Une dependance critique en panne rend l'instance indisponible. */
  readonly critical: boolean;
}

export interface HealthReport {
  readonly healthy: boolean;
  readonly version: string;
  readonly environment: string;
  readonly uptimeSeconds: number;
  readonly timestamp: string;
  readonly checks: readonly HealthCheck[];
}

/** Au-dela, la dependance est consideree degradee plutot que saine. */
const SLOW_CHECK_THRESHOLD_MS = 1_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly config: AppConfigService,
    private readonly mail: MailService,
    private readonly whatsapp: WhatsappGateway,
  ) {}

  /** Dependances sans lesquelles l'application ne peut pas servir de trafic. */
  async checkCritical(): Promise<HealthReport> {
    const checks = [await this.checkDatabase()];
    return this.assemble(checks);
  }

  /** Diagnostic complet, integrations optionnelles comprises. */
  async checkAll(): Promise<HealthReport> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkMail(),
      this.checkWhatsapp(),
      Promise.resolve(this.checkQueues()),
      Promise.resolve(this.checkPaymentProvider()),
    ]);
    return this.assemble(checks);
  }

  private assemble(checks: readonly HealthCheck[]): HealthReport {
    const healthy = checks.every((check) => !check.critical || check.status !== 'down');
    return {
      healthy,
      version: process.env.npm_package_version ?? '0.1.0',
      environment: this.config.app.nodeEnv,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async checkDatabase(): Promise<HealthCheck> {
    const start = Date.now();
    try {
      // `$queryRaw` n'est pas intercepte par le garde tenant ; l'appel est
      // donc explicitement declare hors perimetre.
      await RequestContextStore.runUnscoped('HEALTHCHECK', () => this.prisma.$queryRaw`SELECT 1`);
      const durationMs = Date.now() - start;
      return {
        name: 'postgresql',
        status: durationMs > SLOW_CHECK_THRESHOLD_MS ? 'degraded' : 'up',
        durationMs,
        critical: true,
      };
    } catch (error) {
      this.logger.error(`Sonde PostgreSQL en echec : ${(error as Error).message}`);
      return {
        name: 'postgresql',
        status: 'down',
        durationMs: Date.now() - start,
        detail: 'Connexion impossible',
        critical: true,
      };
    }
  }

  private async checkMail(): Promise<HealthCheck> {
    if (this.config.mail.driver === 'console') {
      return { name: 'mail', status: 'disabled', detail: 'Pilote console', critical: false };
    }
    const start = Date.now();
    const ok = await this.mail.verifyConnection();
    return {
      name: 'mail',
      status: ok ? 'up' : 'down',
      durationMs: Date.now() - start,
      critical: false,
    };
  }

  private async checkWhatsapp(): Promise<HealthCheck> {
    if (!this.whatsapp.isConfigured()) {
      return {
        name: 'whatsapp',
        status: 'disabled',
        detail:
          'Passerelle non configuree : la confirmation automatique est inactive, ' +
          'toutes les commandes partent en file d appel humaine.',
        critical: false,
      };
    }
    return { name: 'whatsapp', status: 'up', critical: false };
  }

  private checkQueues(): HealthCheck {
    if (!this.config.queuesEnabled) {
      return {
        name: 'queues',
        status: 'disabled',
        detail:
          'Redis non configure : les traitements asynchrones s executent en ligne. ' +
          'Acceptable en developpement uniquement.',
        critical: false,
      };
    }
    return { name: 'queues', status: 'up', critical: false };
  }

  private checkPaymentProvider(): HealthCheck {
    if (!this.config.chargily.enabled) {
      return {
        name: 'chargily',
        status: 'disabled',
        detail: 'Paiement automatise inactif : seul le paiement manuel est disponible.',
        critical: false,
      };
    }
    return { name: 'chargily', status: 'up', critical: false };
  }
}
