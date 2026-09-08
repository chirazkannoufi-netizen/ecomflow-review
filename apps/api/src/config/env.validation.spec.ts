/**
 * Validation de l'environnement — V2 §31, mission §47.
 *
 * CE QUE CES TESTS PROTEGENT
 *   Un secret manquant ou faible doit empecher le demarrage, jamais degrader
 *   silencieusement le service. La regle §47 (« aucun secret dans Git »)
 *   n'a de valeur que si l'absence de secret est bruyante : sinon un deploiement
 *   partirait en production avec une cle par defaut.
 *
 *   Les garde-fous specifiques a la production sont testes explicitement :
 *   Swagger ferme, HTTPS impose, Redis present, secrets JWT distincts.
 */

import { validateEnv } from './env.validation';

/** 32 octets en base64, comme l'exige AES-256-GCM. */
const VALID_KEY = Buffer.alloc(32, 3).toString('base64');
const LONG_SECRET_A = 'a'.repeat(48);
const LONG_SECRET_B = 'b'.repeat(48);

function baseEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/ecomflow',
    JWT_ACCESS_SECRET: LONG_SECRET_A,
    JWT_REFRESH_SECRET: LONG_SECRET_B,
    ENCRYPTION_KEY: VALID_KEY,
    HASH_PEPPER: 'c'.repeat(48),
    ...overrides,
  };
}

describe('validateEnv', () => {
  describe('variables requises', () => {
    it('accepte un environnement de developpement minimal', () => {
      const env = validateEnv(baseEnv());

      expect(env.NODE_ENV).toBe('development');
      expect(env.PORT).toBe(3001);
      expect(env.API_PREFIX).toBe('api');
    });

    it('refuse une base de donnees absente', () => {
      const { DATABASE_URL: _omitted, ...rest } = baseEnv();

      expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
    });

    it('refuse un secret JWT trop court', () => {
      expect(() => validateEnv(baseEnv({ JWT_ACCESS_SECRET: 'trop-court' }))).toThrow(
        /32 caracteres/,
      );
    });

    it('refuse un poivre de hachage trop court', () => {
      expect(() => validateEnv(baseEnv({ HASH_PEPPER: 'court' }))).toThrow(/HASH_PEPPER/);
    });

    it('refuse une cle de chiffrement qui ne decode pas 32 octets', () => {
      expect(() =>
        validateEnv(baseEnv({ ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })),
      ).toThrow(/ENCRYPTION_KEY/);
    });

    it('signale TOUTES les variables invalides d un coup', () => {
      // Corriger une variable a la fois, en redemarrant a chaque essai, est
      // une perte de temps evitable au premier deploiement.
      let message = '';
      try {
        validateEnv({ DATABASE_URL: 'pas-une-url', JWT_ACCESS_SECRET: 'court' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('ENCRYPTION_KEY');
      expect(message).toContain('.env.example');
    });
  });

  describe('variables vides traitees comme absentes', () => {
    it('ignore une URL optionnelle laissee vide', () => {
      // Cas nominal d'un `.env` : `REDIS_URL=` signifie « non utilise », pas
      // « chaine vide a valider comme URL ».
      expect(() => validateEnv(baseEnv({ REDIS_URL: '' }))).not.toThrow();
      expect(() => validateEnv(baseEnv({ GOOGLE_CLIENT_ID: '   ' }))).not.toThrow();
    });

    it('retablit la valeur par defaut d un champ laisse vide', () => {
      const env = validateEnv(baseEnv({ API_PREFIX: '', PORT: '' }));

      expect(env.API_PREFIX).toBe('api');
      expect(env.PORT).toBe(3001);
    });

    it('considere toujours une variable REQUISE vide comme manquante', () => {
      expect(() => validateEnv(baseEnv({ DATABASE_URL: '' }))).toThrow(/DATABASE_URL/);
    });
  });

  describe('booleens tolerants', () => {
    it.each([
      ['true', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['TRUE', true],
      ['false', false],
      ['0', false],
      ['non-sens', false],
    ])('interprete %s comme %s', (raw, expected) => {
      // On teste sur un drapeau sans dependance conditionnelle, pour isoler la
      // seule conversion de chaine vers booleen.
      expect(validateEnv(baseEnv({ SWAGGER_ENABLED: raw })).SWAGGER_ENABLED).toBe(expected);
    });
  });

  describe('garde-fous de production', () => {
    function productionEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return baseEnv({
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'false',
        REDIS_URL: 'redis://localhost:6379',
        API_URL: 'https://api.ecomflow.dz',
        APP_URL: 'https://app.ecomflow.dz',
        MAIL_DRIVER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        ...overrides,
      });
    }

    it('accepte une production correctement configuree', () => {
      expect(() => validateEnv(productionEnv())).not.toThrow();
    });

    it('refuse Swagger ouvert en production', () => {
      // Publier la surface complete de l'API facilite la reconnaissance.
      expect(() => validateEnv(productionEnv({ SWAGGER_ENABLED: 'true' }))).toThrow(
        /SWAGGER_ENABLED/,
      );
    });

    it('refuse une API servie en clair', () => {
      expect(() => validateEnv(productionEnv({ API_URL: 'http://api.ecomflow.dz' }))).toThrow(
        /API_URL/,
      );
    });

    it('refuse deux secrets JWT identiques', () => {
      // Un meme secret pour l acces et le rafraichissement permettrait de
      // presenter un refresh token comme un access token.
      expect(() =>
        validateEnv(productionEnv({ JWT_REFRESH_SECRET: LONG_SECRET_A })),
      ).toThrow(/JWT_REFRESH_SECRET/);
    });

    it('exige Redis en production', () => {
      expect(() => validateEnv(productionEnv({ REDIS_URL: '' }))).toThrow(/REDIS_URL/);
    });

    it('refuse un transport e-mail factice en production', () => {
      expect(() => validateEnv(productionEnv({ MAIL_DRIVER: 'console' }))).toThrow(/MAIL_DRIVER/);
    });
  });

  describe('dependances conditionnelles', () => {
    it('exige les identifiants WhatsApp quand l integration est activee', () => {
      let message = '';
      try {
        validateEnv(baseEnv({ WHATSAPP_ENABLED: 'true' }));
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('WHATSAPP_PHONE_NUMBER_ID');
      expect(message).toContain('WHATSAPP_ACCESS_TOKEN');
      expect(message).toContain('WHATSAPP_APP_SECRET');
    });

    it('n exige rien quand WhatsApp est desactive', () => {
      expect(() => validateEnv(baseEnv({ WHATSAPP_ENABLED: 'false' }))).not.toThrow();
    });

    it('exige le secret de webhook quand Chargily est active', () => {
      let message = '';
      try {
        validateEnv(baseEnv({ CHARGILY_ENABLED: 'true' }));
      } catch (error) {
        message = (error as Error).message;
      }

      // Sans secret de webhook, n'importe qui pourrait declarer un paiement
      // recu et activer un abonnement gratuitement.
      expect(message).toContain('CHARGILY_WEBHOOK_SECRET');
    });

    it('exige un mot de passe robuste si un Super Admin est declare', () => {
      expect(() =>
        validateEnv(baseEnv({ SUPER_ADMIN_EMAIL: 'admin@ecomflow.dz', SUPER_ADMIN_PASSWORD: 'court' })),
      ).toThrow(/SUPER_ADMIN_PASSWORD/);
    });
  });
});
