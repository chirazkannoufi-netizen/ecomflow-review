/**
 * Chiffrement des secrets d'integration — V1 §23, V2 §16/§31, mission §47.
 *
 * Ces tests portent sur la PROPRIETE DE SECURITE, pas sur l'implementation :
 * un blob chiffre pour une boutique doit rester indechiffrable pour une autre,
 * et toute alteration doit etre detectee. C'est ce qui distingue un
 * chiffrement authentifie d'un simple encodage.
 */

import { EncryptionService, DecryptionError } from './encryption.service';
import type { AppConfigService } from '../../config/configuration';

/** Cle de test deterministe : 32 octets, comme l'exige AES-256. */
function makeService(keyByte = 7): EncryptionService {
  const config = {
    encryptionKey: Buffer.alloc(32, keyByte),
  } as unknown as AppConfigService;
  return new EncryptionService(config);
}

const TENANT_A = '01a05330-0000-7000-8000-000000000001';
const TENANT_B = '01a05330-0000-7000-8000-000000000002';

describe('EncryptionService', () => {
  it('refuse une cle qui ne fait pas 32 octets', () => {
    const config = { encryptionKey: Buffer.alloc(16, 1) } as unknown as AppConfigService;
    expect(() => new EncryptionService(config)).toThrow(/32 octets/);
  });

  it('restitue exactement la valeur chiffree', () => {
    const service = makeService();
    const secret = 'ya29.a0AfH6SMBx-jeton-google-tres-long';

    expect(service.decrypt(service.encrypt(secret))).toBe(secret);
  });

  it('preserve les caracteres non latins et les emojis', () => {
    const service = makeService();
    const secret = 'clé-transporteur-الجزائر-🇩🇿';

    expect(service.decrypt(service.encrypt(secret))).toBe(secret);
  });

  it('produit un chiffre different a chaque appel pour la meme valeur', () => {
    const service = makeService();

    // Un IV aleatoire par chiffrement : sans cela, deux boutiques ayant le
    // meme jeton auraient le meme blob en base, ce qui est une fuite.
    expect(service.encrypt('meme-secret')).not.toBe(service.encrypt('meme-secret'));
  });

  it('lie le chiffre a son tenant : un blob copie ailleurs devient illisible', () => {
    const service = makeService();
    const encrypted = service.encrypt('jeton-de-la-boutique-A', TENANT_A);

    expect(service.decrypt(encrypted, TENANT_A)).toBe('jeton-de-la-boutique-A');
    expect(() => service.decrypt(encrypted, TENANT_B)).toThrow(DecryptionError);
  });

  it('refuse de dechiffrer sans l AAD utilisee au chiffrement', () => {
    const service = makeService();
    const encrypted = service.encrypt('secret', TENANT_A);

    expect(() => service.decrypt(encrypted)).toThrow(DecryptionError);
  });

  it('detecte l alteration du chiffre', () => {
    const service = makeService();
    const [version, iv, tag, data] = service.encrypt('secret').split('.');

    // On modifie un octet du chiffre : GCM doit le detecter via son tag.
    const tampered = Buffer.from(data, 'base64');
    tampered[0] = (tampered[0]) ^ 0xff;
    const forged = [version, iv, tag, tampered.toString('base64')].join('.');

    expect(() => service.decrypt(forged)).toThrow(DecryptionError);
  });

  it('detecte l alteration du tag d authentification', () => {
    const service = makeService();
    const [version, iv, tag, data] = service.encrypt('secret').split('.');

    const tampered = Buffer.from(tag, 'base64');
    tampered[0] = (tampered[0]) ^ 0xff;
    const forged = [version, iv, tampered.toString('base64'), data].join('.');

    expect(() => service.decrypt(forged)).toThrow(DecryptionError);
  });

  it('refuse un chiffre produit avec une autre cle', () => {
    const encrypted = makeService(7).encrypt('secret');

    expect(() => makeService(9).decrypt(encrypted)).toThrow(DecryptionError);
  });

  it('rejette un format inattendu sans exposer de detail cryptographique', () => {
    const service = makeService();

    expect(() => service.decrypt('pas-du-tout-un-chiffre')).toThrow(DecryptionError);
    expect(() => service.decrypt('v9.a.b.c')).toThrow(/non supportee/);
  });

  it('rejette un IV de longueur incorrecte', () => {
    const service = makeService();
    const [, , tag, data] = service.encrypt('secret').split('.');
    const shortIv = Buffer.alloc(8, 1).toString('base64');

    expect(() => service.decrypt(['v1', shortIv, tag, data].join('.'))).toThrow(DecryptionError);
  });

  it('chiffre et restitue un objet structure', () => {
    const service = makeService();
    const credentials = { accessToken: 'a', refreshToken: 'b', expiresAt: 1_700_000_000 };

    expect(service.decryptJson(service.encryptJson(credentials, TENANT_A), TENANT_A)).toEqual(
      credentials,
    );
  });

  describe('safeCompare', () => {
    it('reconnait deux valeurs identiques', () => {
      expect(EncryptionService.safeCompare('signature', 'signature')).toBe(true);
    });

    it('rejette deux valeurs differentes de meme longueur', () => {
      expect(EncryptionService.safeCompare('signatureA', 'signatureB')).toBe(false);
    });

    it('rejette deux valeurs de longueurs differentes sans lever d erreur', () => {
      // `timingSafeEqual` leve si les longueurs different : la garde en amont
      // evite que la verification d'une signature de webhook ne plante.
      expect(EncryptionService.safeCompare('court', 'beaucoup-plus-long')).toBe(false);
    });

    it('traite correctement la chaine vide', () => {
      expect(EncryptionService.safeCompare('', '')).toBe(true);
      expect(EncryptionService.safeCompare('', 'x')).toBe(false);
    });
  });
});
