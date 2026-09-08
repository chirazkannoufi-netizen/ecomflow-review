/**
 * Contexte de requete et perimetre de tenant — V1 §29, V2 §5, mission §8.
 *
 * Le contexte est le PREMIER des trois niveaux d'isolation multi-tenant (les
 * deux autres etant le garde Prisma et les cles etrangeres composites). Ce
 * qu'il doit garantir :
 *
 *   1. Hors de tout perimetre, demander un tenant leve une erreur explicite.
 *      Un `null` silencieux ferait fuiter des donnees a la premiere requete
 *      mal ecrite.
 *   2. Le perimetre survit aux frontieres asynchrones : sans cela, un `await`
 *      au milieu d'un service ferait perdre le tenant et le garde Prisma
 *      refuserait la requete suivante — ou pire, la laisserait passer.
 *   3. Sortir du perimetre exige une RAISON, jamais un simple `null`.
 */

import {
  RequestContextStore,
  createRequestContext,
  generateCorrelationId,
} from './request-context';

const TENANT_A = '01a05330-0000-7000-8000-00000000000a';
const TENANT_B = '01a05330-0000-7000-8000-00000000000b';

describe('RequestContextStore', () => {
  describe('hors de tout contexte', () => {
    it('retourne undefined sur get()', () => {
      expect(RequestContextStore.get()).toBeUndefined();
    });

    it('leve une erreur explicite sur require()', () => {
      expect(() => RequestContextStore.require()).toThrow(/Aucun contexte de requete actif/);
    });

    it('leve une erreur sur requireTenantId()', () => {
      expect(() => RequestContextStore.requireTenantId()).toThrow(/Aucun contexte/);
    });

    it('refuse update() faute de contexte a enrichir', () => {
      expect(() => RequestContextStore.update({ userId: 'u1' })).toThrow(/Aucun contexte/);
    });
  });

  describe('runWithTenant', () => {
    it('expose le tenant a tout le code appele', () => {
      RequestContextStore.runWithTenant(TENANT_A, () => {
        expect(RequestContextStore.requireTenantId()).toBe(TENANT_A);
        expect(RequestContextStore.require().unscopedReason).toBeNull();
      });
    });

    it('conserve le tenant a travers les frontieres asynchrones', async () => {
      await RequestContextStore.runWithTenant(TENANT_A, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(RequestContextStore.requireTenantId()).toBe(TENANT_A);

        await Promise.all([
          (async () => {
            await new Promise((resolve) => setImmediate(resolve));
            expect(RequestContextStore.requireTenantId()).toBe(TENANT_A);
          })(),
          (async () => {
            expect(RequestContextStore.requireTenantId()).toBe(TENANT_A);
          })(),
        ]);
      });
    });

    it('restaure le contexte precedent en sortie', () => {
      RequestContextStore.runWithTenant(TENANT_A, () => {
        RequestContextStore.runWithTenant(TENANT_B, () => {
          expect(RequestContextStore.requireTenantId()).toBe(TENANT_B);
        });
        // Deux boutiques traitees a la suite dans un job : la seconde ne doit
        // jamais deteindre sur la premiere.
        expect(RequestContextStore.requireTenantId()).toBe(TENANT_A);
      });

      expect(RequestContextStore.get()).toBeUndefined();
    });

    it('herite des informations du contexte parent', () => {
      RequestContextStore.run(
        createRequestContext({ userId: 'user-1', correlationId: 'corr-1' }),
        () => {
          RequestContextStore.runWithTenant(TENANT_A, () => {
            const context = RequestContextStore.require();
            expect(context.userId).toBe('user-1');
            expect(context.correlationId).toBe('corr-1');
            expect(context.tenantId).toBe(TENANT_A);
          });
        },
      );
    });

    it('efface toute raison hors perimetre heritee', () => {
      RequestContextStore.runUnscoped('BACKGROUND_JOB', () => {
        RequestContextStore.runWithTenant(TENANT_A, () => {
          // Entrer dans une boutique referme la parenthese « hors perimetre » :
          // sinon le garde Prisma laisserait passer des requetes non filtrees.
          expect(RequestContextStore.require().unscopedReason).toBeNull();
        });
      });
    });

    it('accepte des surcharges ponctuelles', () => {
      RequestContextStore.runWithTenant(TENANT_A, () => {
        const context = RequestContextStore.require();
        expect(context.membershipId).toBe('m-1');
        expect(context.permissions.has('orders.read')).toBe(true);
      }, { membershipId: 'm-1', permissions: new Set(['orders.read']) });
    });
  });

  describe('runUnscoped', () => {
    it('n expose aucun tenant mais conserve la raison', () => {
      RequestContextStore.runUnscoped('AUTHENTICATION', () => {
        const context = RequestContextStore.require();
        expect(context.tenantId).toBeNull();
        expect(context.unscopedReason).toBe('AUTHENTICATION');
      });
    });

    it('refuse toujours requireTenantId, en citant la raison', () => {
      RequestContextStore.runUnscoped('PLATFORM_ADMIN', () => {
        expect(() => RequestContextStore.requireTenantId()).toThrow(/PLATFORM_ADMIN/);
      });
    });

    it('retire le tenant du contexte parent', () => {
      RequestContextStore.runWithTenant(TENANT_A, () => {
        RequestContextStore.runUnscoped('BACKGROUND_JOB', () => {
          expect(RequestContextStore.require().tenantId).toBeNull();
        });
        expect(RequestContextStore.requireTenantId()).toBe(TENANT_A);
      });
    });
  });

  describe('patch', () => {
    it('enrichit le contexte pour la duree de l appel seulement', () => {
      RequestContextStore.runWithTenant(TENANT_A, () => {
        RequestContextStore.patch({ userId: 'user-2' }, () => {
          expect(RequestContextStore.require().userId).toBe('user-2');
        });
        expect(RequestContextStore.require().userId).toBeNull();
      });
    });
  });

  describe('update', () => {
    it('enrichit le contexte courant en place', () => {
      RequestContextStore.runWithTenant(TENANT_A, () => {
        // Le middleware ouvre le contexte, les gardes le completent plus tard :
        // la mutation doit etre visible par tout le reste de la requete.
        RequestContextStore.update({ userId: 'user-3', isPlatformAdmin: true });

        const context = RequestContextStore.require();
        expect(context.userId).toBe('user-3');
        expect(context.isPlatformAdmin).toBe(true);
        expect(context.tenantId).toBe(TENANT_A);
      });
    });

    it('reste visible depuis un appel imbrique deja demarre', async () => {
      await RequestContextStore.runWithTenant(TENANT_A, async () => {
        const observed: (string | null)[] = [];

        const pending = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          observed.push(RequestContextStore.require().userId);
        })();

        RequestContextStore.update({ userId: 'user-4' });
        await pending;

        expect(observed).toEqual(['user-4']);
      });
    });
  });

  describe('generateCorrelationId', () => {
    it('produit des identifiants uniques', () => {
      const ids = new Set(Array.from({ length: 1000 }, () => generateCorrelationId()));
      expect(ids.size).toBe(1000);
    });

    it('produit des identifiants croissants dans le temps', async () => {
      const first = generateCorrelationId();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = generateCorrelationId();

      // Trier des journaux par identifiant de correlation doit les remettre
      // dans l'ordre chronologique.
      expect(second >= first).toBe(true);
    });
  });

  describe('createRequestContext', () => {
    it('produit un contexte neutre et complet', () => {
      const context = createRequestContext();

      expect(context.tenantId).toBeNull();
      expect(context.userId).toBeNull();
      expect(context.unscopedReason).toBeNull();
      expect(context.isPlatformAdmin).toBe(false);
      expect(context.permissions.size).toBe(0);
      expect(context.correlationId).toBeTruthy();
    });
  });
});
