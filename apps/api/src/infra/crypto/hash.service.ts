/**
 * Hachage des mots de passe et des jetons.
 *
 * DEUX MECANISMES DISTINCTS, pour deux menaces distinctes :
 *
 * 1. MOTS DE PASSE — Argon2id.
 *    Secret a faible entropie, choisi par un humain. Le hachage doit etre
 *    LENT et couteux en memoire pour rendre une attaque par dictionnaire
 *    impraticable. Argon2id est le choix recommande par l'OWASP ; il resiste
 *    aux attaques GPU (cout memoire) et aux attaques par canal auxiliaire
 *    (variante « id »).
 *
 * 2. JETONS (refresh, reinitialisation, OTP) — HMAC-SHA-256.
 *    Secret a forte entropie, genere par le serveur. Un hachage lent serait
 *    ici un handicap : chaque appel authentifie le verifierait. HMAC avec un
 *    poivre serveur suffit : sans le poivre, une base volee ne permet pas de
 *    retrouver les jetons ; et l'entropie du jeton exclut toute recherche
 *    exhaustive.
 *
 * Aucun mot de passe ni jeton en clair n'est jamais persiste (prompt §9, §47).
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { AppConfigService } from '../../config/configuration';

/**
 * Parametres Argon2id.
 * Cible : environ 100 ms sur un vCPU de serveur standard, conformement aux
 * recommandations OWASP (memoire 19 Mio minimum, 2 iterations).
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 Mio
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class HashService {
  private readonly logger = new Logger(HashService.name);
  private readonly pepper: string;

  constructor(config: AppConfigService) {
    this.pepper = config.hashPepper;
  }

  // -------------------------------------------------------------------------
  // Mots de passe
  // -------------------------------------------------------------------------

  async hashPassword(password: string): Promise<string> {
    return argonHash(password, ARGON2_OPTIONS);
  }

  /**
   * Verifie un mot de passe.
   *
   * Retourne `false` sur erreur de format plutot que de propager l'exception :
   * un hash corrompu en base ne doit pas produire une 500 exploitable pour
   * distinguer « compte inexistant » de « compte casse ».
   */
  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argonVerify(hash, password);
    } catch (error) {
      this.logger.warn(`Verification de mot de passe impossible : ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Indique si un hash doit etre recalcule parce que les parametres de cout
   * ont ete durcis depuis sa creation. Appele apres une connexion reussie.
   */
  needsRehash(hash: string): boolean {
    const match = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)/.exec(hash);
    if (!match) return true;
    const [, memory, time, parallelism] = match;
    return (
      Number(memory) < ARGON2_OPTIONS.memoryCost ||
      Number(time) < ARGON2_OPTIONS.timeCost ||
      Number(parallelism) < ARGON2_OPTIONS.parallelism
    );
  }

  // -------------------------------------------------------------------------
  // Jetons a forte entropie
  // -------------------------------------------------------------------------

  /** Genere un jeton opaque, sur 32 octets d'entropie (256 bits). */
  generateToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Empreinte HMAC-SHA-256 poivree d'un jeton, stockee en base. */
  hashToken(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('base64url');
  }

  /** Comparaison a temps constant d'un jeton avec son empreinte stockee. */
  verifyToken(token: string, storedHash: string): boolean {
    const computed = Buffer.from(this.hashToken(token), 'utf8');
    const stored = Buffer.from(storedHash, 'utf8');
    if (computed.length !== stored.length) return false;
    return timingSafeEqual(computed, stored);
  }

  // -------------------------------------------------------------------------
  // Codes OTP
  // -------------------------------------------------------------------------

  /**
   * Genere un code numerique a 6 chiffres avec un generateur
   * CRYPTOGRAPHIQUEMENT sur. `Math.random()` serait predictible et permettrait
   * de contourner la verification de numero, donc la prevention de l'abus du
   * Trial (Addendum §38).
   */
  generateOtpCode(digits = 6): string {
    const max = 10 ** digits;
    return String(randomInt(0, max)).padStart(digits, '0');
  }

  /** Empreinte d'un code OTP. Meme mecanisme que les jetons. */
  hashOtp(code: string): string {
    return this.hashToken(`otp:${code}`);
  }

  verifyOtp(code: string, storedHash: string): boolean {
    return this.verifyToken(`otp:${code}`, storedHash);
  }

  // -------------------------------------------------------------------------
  // Empreintes de signaux techniques (anti-abus)
  // -------------------------------------------------------------------------

  /**
   * Empreinte irreversible d'une adresse IP ou d'une empreinte d'appareil.
   *
   * On conserve la capacite de DETECTER une reutilisation sans jamais stocker
   * la donnee brute : c'est la traduction technique du principe de
   * minimisation des donnees (Addendum §37, loi 18-07).
   */
  hashSignal(value: string): string {
    return createHmac('sha256', this.pepper).update(`signal:${value}`).digest('hex');
  }
}
