/**
 * Chiffrement au repos des secrets d'integration.
 *
 * Perimetre : jetons OAuth Google, cles d'API transporteurs, jetons WhatsApp.
 * Exigence : V1 §23 (« chiffrement des secrets d'integration et tokens
 * OAuth »), V2 §16 et §31, prompt produit §47.
 *
 * ALGORITHME : AES-256-GCM.
 *   - GCM est un mode AUTHENTIFIE : il detecte toute alteration du chiffre.
 *     Un attaquant disposant d'un acces en ecriture a la base ne peut pas
 *     substituer un jeton par un autre sans que le dechiffrement echoue.
 *   - Un IV aleatoire de 12 octets est genere a chaque chiffrement : deux
 *     chiffrements de la meme valeur produisent des resultats differents.
 *
 * FORMAT STOCKE : `v1.<iv_base64>.<tag_base64>.<chiffre_base64>`
 *   Le prefixe de version permettra une rotation d'algorithme sans migration
 *   destructive : un dechiffreur futur saura lire les deux formats.
 */

import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const FORMAT_VERSION = 'v1';

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: AppConfigService) {
    this.key = config.encryptionKey;
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY doit faire exactement 32 octets apres decodage base64.');
    }
  }

  /**
   * Chiffre une valeur textuelle.
   *
   * @param plaintext valeur en clair (jeton, cle d'API, secret)
   * @param aad donnee additionnelle authentifiee, non chiffree mais liee au
   *            chiffre. On y place l'identifiant du tenant : un blob chiffre
   *            copie d'une boutique vers une autre devient indechiffrable.
   */
  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });

    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      FORMAT_VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join('.');
  }

  /**
   * Dechiffre une valeur produite par `encrypt`.
   * Leve `DecryptionError` si le chiffre a ete altere, si la cle a change ou
   * si l'AAD ne correspond pas.
   */
  decrypt(payload: string, aad?: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4) {
      throw new DecryptionError('Format de chiffre invalide.');
    }

    const [version, ivBase64, tagBase64, dataBase64] = parts as [string, string, string, string];
    if (version !== FORMAT_VERSION) {
      throw new DecryptionError(`Version de chiffrement non supportee : ${version}`);
    }

    try {
      const iv = Buffer.from(ivBase64, 'base64');
      const authTag = Buffer.from(tagBase64, 'base64');
      const data = Buffer.from(dataBase64, 'base64');

      if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw new DecryptionError('Parametres de chiffrement invalides.');
      }

      const decipher = createDecipheriv(ALGORITHM, this.key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));

      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error instanceof DecryptionError) throw error;
      // Le message d'origine peut contenir des details cryptographiques :
      // on ne le propage pas au client.
      throw new DecryptionError(
        'Dechiffrement impossible : donnee alteree, cle incorrecte ou contexte different.',
        { cause: error },
      );
    }
  }

  /** Chiffre un objet JSON (credentials structures). */
  encryptJson<T>(value: T, aad?: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  /** Dechiffre un objet JSON precedemment chiffre. */
  decryptJson<T>(payload: string, aad?: string): T {
    return JSON.parse(this.decrypt(payload, aad)) as T;
  }

  /**
   * Comparaison a temps constant de deux secrets.
   * Utilisee pour les signatures de webhook, ou une comparaison naive
   * (`===`) exposerait a une attaque temporelle.
   */
  static safeCompare(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    // `timingSafeEqual` exige des longueurs egales : on compare d'abord les
    // longueurs, ce qui ne divulgue que la taille, jamais le contenu.
    if (bufferA.length !== bufferB.length) return false;
    return timingSafeEqual(bufferA, bufferB);
  }
}
