/**
 * Hachage des mots de passe, jetons et codes OTP — V1 §23, mission §47.
 *
 * Ce que ces tests verrouillent :
 *   - un jeton n'est JAMAIS stocke en clair : seule son empreinte poivree l'est ;
 *   - deux installations aux poivres differents ne partagent aucune empreinte,
 *     donc une base volee ne permet pas de rejouer un jeton ailleurs ;
 *   - un hash de mot de passe corrompu produit un refus, pas une erreur 500
 *     qui distinguerait « compte inexistant » de « compte casse ».
 */

import { HashService } from './hash.service';
import type { AppConfigService } from '../../config/configuration';

function makeService(pepper = 'poivre-de-test-suffisamment-long-0123456789'): HashService {
  return new HashService({ hashPepper: pepper } as unknown as AppConfigService);
}

describe('HashService', () => {
  describe('mots de passe', () => {
    // Argon2id est volontairement lent : ces tests ont besoin de marge.
    jest.setTimeout(30_000);

    it('produit un hash argon2id verifiable', async () => {
      const service = makeService();
      const hash = await service.hashPassword('MotDePasseSolide12');

      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(await service.verifyPassword(hash, 'MotDePasseSolide12')).toBe(true);
    });

    it('refuse un mot de passe incorrect', async () => {
      const service = makeService();
      const hash = await service.hashPassword('MotDePasseSolide12');

      expect(await service.verifyPassword(hash, 'MotDePasseSolide13')).toBe(false);
    });

    it('produit deux hashs differents pour le meme mot de passe', async () => {
      const service = makeService();

      // Sel aleatoire : deux utilisateurs avec le meme mot de passe ne sont
      // pas reperables dans un vidage de base.
      const first = await service.hashPassword('MotDePasseSolide12');
      const second = await service.hashPassword('MotDePasseSolide12');
      expect(first).not.toBe(second);
    });

    it('retourne false sur un hash corrompu au lieu de lever', async () => {
      const service = makeService();

      expect(await service.verifyPassword('pas-un-hash', 'peu-importe')).toBe(false);
      expect(await service.verifyPassword('', 'peu-importe')).toBe(false);
    });

    it('demande un recalcul pour un hash non reconnu', () => {
      const service = makeService();

      expect(service.needsRehash('pas-un-hash-argon')).toBe(true);
      expect(service.needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
    });

    it('demande un recalcul pour un cout inferieur aux parametres actuels', () => {
      const service = makeService();

      expect(service.needsRehash('$argon2id$v=19$m=1024,t=1,p=1$sel$hash')).toBe(true);
    });

    it('ne demande pas de recalcul pour un hash frais', async () => {
      const service = makeService();
      const hash = await service.hashPassword('MotDePasseSolide12');

      expect(service.needsRehash(hash)).toBe(false);
    });
  });

  describe('jetons', () => {
    it('genere des jetons a forte entropie, tous differents', () => {
      const service = makeService();
      const tokens = new Set(Array.from({ length: 200 }, () => service.generateToken()));

      expect(tokens.size).toBe(200);
    });

    it('produit un jeton utilisable dans une URL', () => {
      const service = makeService();

      // base64url : le jeton de reinitialisation transite dans un lien e-mail.
      expect(service.generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('hache un jeton de facon deterministe', () => {
      const service = makeService();
      const token = service.generateToken();

      expect(service.hashToken(token)).toBe(service.hashToken(token));
    });

    it('ne laisse jamais deviner le jeton depuis son empreinte', () => {
      const service = makeService();
      const token = service.generateToken();

      expect(service.hashToken(token)).not.toContain(token);
    });

    it('verifie un jeton contre son empreinte', () => {
      const service = makeService();
      const token = service.generateToken();

      expect(service.verifyToken(token, service.hashToken(token))).toBe(true);
      expect(service.verifyToken(service.generateToken(), service.hashToken(token))).toBe(false);
    });

    it('rejette une empreinte de longueur inattendue sans lever', () => {
      const service = makeService();

      expect(service.verifyToken('jeton', 'trop-court')).toBe(false);
      expect(service.verifyToken('jeton', '')).toBe(false);
    });

    it('produit des empreintes differentes selon le poivre', () => {
      // Le poivre vit dans l'environnement, jamais en base : une base volee
      // sans le poivre ne permet pas de rejouer un jeton.
      const token = 'jeton-identique';

      expect(makeService('poivre-A').hashToken(token)).not.toBe(
        makeService('poivre-B').hashToken(token),
      );
    });
  });

  describe('codes OTP', () => {
    it('genere un code de 6 chiffres', () => {
      const service = makeService();

      for (let index = 0; index < 100; index += 1) {
        expect(service.generateOtpCode()).toMatch(/^\d{6}$/);
      }
    });

    it('conserve les zeros de tete', () => {
      const service = makeService();
      const codes = Array.from({ length: 500 }, () => service.generateOtpCode());

      // Un code tronque a « 1234 » au lieu de « 001234 » rendrait la
      // verification impossible pour l'utilisateur.
      expect(codes.every((code) => code.length === 6)).toBe(true);
    });

    it('verifie un code contre son empreinte', () => {
      const service = makeService();
      const code = '123456';

      expect(service.verifyOtp(code, service.hashOtp(code))).toBe(true);
      expect(service.verifyOtp('654321', service.hashOtp(code))).toBe(false);
    });

    it('distingue l empreinte d un OTP de celle d un jeton de meme valeur', () => {
      const service = makeService();

      // Sans prefixe de domaine, un code OTP intercepte pourrait servir de
      // jeton de session la ou les deux empreintes se croisent.
      expect(service.hashOtp('123456')).not.toBe(service.hashToken('123456'));
    });
  });

  describe('empreintes de signaux anti-abus', () => {
    it('hache une adresse IP de facon deterministe et irreversible', () => {
      const service = makeService();

      expect(service.hashSignal('105.98.12.7')).toBe(service.hashSignal('105.98.12.7'));
      expect(service.hashSignal('105.98.12.7')).not.toContain('105.98');
      expect(service.hashSignal('105.98.12.7')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('distingue deux signaux differents', () => {
      const service = makeService();

      expect(service.hashSignal('105.98.12.7')).not.toBe(service.hashSignal('105.98.12.8'));
    });
  });
});
