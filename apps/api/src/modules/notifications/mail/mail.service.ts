/**
 * Envoi d'e-mails transactionnels.
 *
 * Deux pilotes, choisis par `MAIL_DRIVER` :
 *  - `console` : ecrit le message dans les journaux. Seul pilote autorise en
 *    developpement local, il evite d'envoyer un vrai e-mail a un vrai client
 *    depuis un poste de developpement — accident classique et couteux.
 *  - `smtp`    : envoi reel. Impose en production par la validation
 *    d'environnement.
 *
 * L'envoi n'echoue JAMAIS l'action metier appelante : une inscription reussie
 * ne doit pas etre annulee parce que le serveur SMTP est momentanement
 * injoignable. Les echecs sont journalises et remontes au centre d'incidents.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppConfigService } from '../../../config/configuration';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  /** Corps texte brut. Toujours fourni : certains clients n'affichent que lui. */
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
}

export interface MailResult {
  readonly sent: boolean;
  readonly messageId?: string;
  readonly error?: string;
}

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: AppConfigService) {}

  async send(message: MailMessage): Promise<MailResult> {
    const mail = this.config.mail;

    if (mail.driver === 'console') {
      this.logger.log(
        [
          '--- E-MAIL (pilote console, non envoye) ---',
          `A       : ${message.to}`,
          `Sujet   : ${message.subject}`,
          '',
          message.text,
          '-------------------------------------------',
        ].join('\n'),
      );
      return { sent: true, messageId: 'console' };
    }

    try {
      const transporter = this.getTransporter();
      const info = await transporter.sendMail({
        from: mail.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
      });
      return { sent: true, messageId: info.messageId };
    } catch (error) {
      const reason = (error as Error).message;
      this.logger.error(`Echec d envoi e-mail vers ${maskEmail(message.to)} : ${reason}`);
      return { sent: false, error: reason };
    }
  }

  /** Verifie la connexion SMTP (utilise par le health check). */
  async verifyConnection(): Promise<boolean> {
    if (this.config.mail.driver === 'console') return true;
    try {
      await this.getTransporter().verify();
      return true;
    } catch (error) {
      this.logger.warn(`Connexion SMTP indisponible : ${(error as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const mail = this.config.mail;
    this.transporter = createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
      // Un serveur SMTP lent ne doit pas immobiliser une requete HTTP.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    return this.transporter;
  }
}

/** Masque une adresse pour les journaux : `sa***@boutique.dz`. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}
