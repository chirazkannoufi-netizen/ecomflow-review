/**
 * Jeu de donnees de developpement — execute contre un VRAI PostgreSQL.
 *
 * POURQUOI CE TEST EXISTE
 *   Un script de seed casse ne se voit qu'au moment ou quelqu'un installe le
 *   projet — c'est-a-dire au pire moment, sur le poste d'un nouvel arrivant.
 *   Le vérifier en CI le transforme en garantie plutot qu'en promesse.
 *
 *   Il ne se contente pas de constater que le script « passe » : il verifie
 *   que le jeu produit est REELLEMENT exploitable, c'est-a-dire que chaque
 *   ecran du produit aura de quoi s'afficher. Un seed qui remplit la base sans
 *   couvrir le workflow laisse une file de confirmation vide et un tableau de
 *   bord a zero, ce qui ne vaut guere mieux qu'une base vierge.
 *
 *   Il verifie enfin le garde-fou de production, qui est une regle de SECURITE :
 *   les comptes de demonstration ont un mot de passe publie dans ce depot.
 */

import type { PrismaClient } from '@prisma/client';
import { ORDER_STATUSES, TENANT_ROLES } from '@ecomflow/shared';
import { runSeed } from '../../prisma/seed';
import { seedDemoTenant } from '../../prisma/seed-demo';
import { closePrisma, rawPrisma, resetDatabase } from '../support/prisma';

/**
 * Statuts que le jeu de donnees doit obligatoirement couvrir.
 *
 * Chacun alimente un ecran precis : sans `IN_PREPARATION`, la colonne « en
 * cours » du depot reste vide ; sans `RETURNED`, la rentabilite n'affiche
 * aucune perte reelle et l'on ne peut pas verifier le calcul.
 */
const REQUIRED_STATUSES = [
  'NEW',
  'TO_CONFIRM',
  'CONFIRMED',
  'IN_PREPARATION',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_DELIVERY',
  'DELIVERED',
  'NO_ANSWER',
  'CALL_BACK',
  'POSTPONED',
  'WRONG_NUMBER',
  'CANCELLED',
  'REFUSED',
  'RETURNED',
] as const;

describe('jeu de donnees de developpement', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = rawPrisma();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePrisma();
  });

  describe('boutique de demonstration', () => {
    it('cree une boutique complete et exploitable', async () => {
      const result = await seedDemoTenant(prisma);

      expect(result.slug).toBe('boutique-demo');
      expect(result.orderCount).toBeGreaterThan(0);

      const tenant = await prisma.tenant.findUnique({
        where: { id: result.tenantId },
        select: { name: true, status: true },
      });
      expect(tenant?.status).toBe('ACTIVE');
    });

    it('couvre TOUS les statuts du workflow', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const rows = await prisma.order.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: true,
      });
      const covered = new Set(rows.map((row) => row.status));

      const missing = REQUIRED_STATUSES.filter((status) => !covered.has(status));
      expect(missing).toEqual([]);
    });

    it('n invente aucun statut inconnu', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const rows = await prisma.order.groupBy({ by: ['status'], where: { tenantId } });
      for (const row of rows) {
        expect(ORDER_STATUSES).toContain(row.status);
      }
    });

    it('installe les roles de boutique et des membres sur plusieurs d entre eux', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const roles = await prisma.role.findMany({
        where: { tenantId },
        select: { code: true, memberships: { select: { id: true } } },
      });

      // Tous les roles systeme existent…
      const codes = roles.map((role) => role.code).sort();
      expect(codes).toEqual([...TENANT_ROLES].sort());

      // …et plusieurs sont REELLEMENT occupes : un jeu de donnees ou tout le
      // monde est proprietaire ne permet pas de tester les permissions.
      const staffed = roles.filter((role) => role.memberships.length > 0).map((role) => role.code);
      expect(staffed).toContain('OWNER');
      expect(staffed.length).toBeGreaterThanOrEqual(3);
    });

    it('cree des clients algeriens avec des numeros normalises', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const customers = await prisma.customer.findMany({
        where: { tenantId },
        select: { fullName: true, phoneE164: true, locale: true },
      });

      expect(customers.length).toBeGreaterThanOrEqual(8);
      for (const customer of customers) {
        expect(customer.fullName.trim().length).toBeGreaterThan(0);
        // Numero algerien au format international : c'est la forme stockee.
        expect(customer.phoneE164).toMatch(/^\+213[5-7]\d{8}$/);
      }
    });

    it('couvre plusieurs wilayas, pas seulement Alger', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const addresses = await prisma.address.findMany({
        where: { tenantId },
        select: { wilayaCode: true },
      });
      const wilayas = new Set(addresses.map((address) => address.wilayaCode));

      // Une base ou tout se passe a Alger ne revele rien de la ventilation
      // par wilaya du tableau de rentabilite.
      expect(wilayas.size).toBeGreaterThanOrEqual(5);
      for (const code of wilayas) {
        expect(code).toBeGreaterThanOrEqual(1);
        expect(code).toBeLessThanOrEqual(58);
      }
    });

    it('melange les langues des clients, y compris l absence de preference', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const customers = await prisma.customer.findMany({
        where: { tenantId },
        select: { locale: true },
      });
      const locales = customers.map((customer) => customer.locale);

      // Les trois cas doivent exister pour exercer la resolution de langue
      // des messages WhatsApp : client francophone, arabophone, et sans
      // preference (on retombe alors sur le reglage de la boutique).
      expect(locales).toContain('fr');
      expect(locales).toContain('ar');
      expect(locales).toContain(null);
    });

    it('cree un catalogue avec des variantes et du stock', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const products = await prisma.product.findMany({
        where: { tenantId },
        select: {
          purchasePriceCentimes: true,
          salePriceCentimes: true,
          variants: { select: { id: true } },
        },
      });

      expect(products.length).toBeGreaterThanOrEqual(3);
      expect(products.some((product) => product.variants.length > 1)).toBe(true);

      for (const product of products) {
        // Sans prix d'achat, la rentabilite affichee serait partielle et le
        // jeu de donnees ne permettrait pas de verifier le calcul de marge.
        expect(product.purchasePriceCentimes).not.toBeNull();
        expect(product.salePriceCentimes).toBeGreaterThan(0);
      }

      const levels = await prisma.inventoryLevel.findMany({
        where: { tenantId },
        select: { onHand: true },
      });
      expect(levels.length).toBeGreaterThan(0);
      expect(levels.some((level) => level.onHand > 0)).toBe(true);
    });

    it('produit des compteurs client coherents avec l historique', async () => {
      const { tenantId } = await seedDemoTenant(prisma);

      const customers = await prisma.customer.findMany({
        where: { tenantId },
        select: {
          id: true,
          ordersCount: true,
          deliveredCount: true,
          orders: { select: { status: true } },
        },
      });

      for (const customer of customers) {
        expect(customer.ordersCount).toBe(customer.orders.length);

        const delivered = customer.orders.filter((order) => order.status === 'DELIVERED').length;
        expect(customer.deliveredCount).toBe(delivered);
      }
    });

    it('peut etre rejoue sans dupliquer la boutique', async () => {
      const first = await seedDemoTenant(prisma);
      const second = await seedDemoTenant(prisma);

      expect(second.tenantId).toBe(first.tenantId);
      expect(second.orderCount).toBe(first.orderCount);

      const tenants = await prisma.tenant.count({ where: { slug: 'boutique-demo' } });
      expect(tenants).toBe(1);
    });
  });

  describe('amorcage complet', () => {
    it('installe les referentiels sans la demo par defaut', async () => {
      const report = await runSeed(prisma, { silent: true });

      expect(report.permissions).toBeGreaterThan(0);
      expect(report.carriers).toBeGreaterThan(0);
      expect(report.plans).toBeGreaterThan(0);
      // Sans `withDemo`, aucune donnee de demonstration : c'est ce qui rend
      // `npm run seed` sur pour une installation vierge.
      expect(report.demoSlug).toBeNull();
      expect(await prisma.order.count()).toBe(0);
    });

    it('installe la demo quand elle est demandee', async () => {
      const report = await runSeed(prisma, { silent: true, withDemo: true });

      expect(report.demoSlug).toBe('boutique-demo');
      expect(await prisma.order.count()).toBeGreaterThan(0);
    });

    it('REFUSE la demo en production', async () => {
      // Les comptes de demonstration ont un mot de passe publie dans ce depot :
      // les creer en production ouvrirait un acces connu de tous.
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        await expect(runSeed(prisma, { silent: true, withDemo: true })).rejects.toThrow(
          /NODE_ENV=production/,
        );
        expect(await prisma.order.count()).toBe(0);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    it('installe tout de meme les referentiels en production', async () => {
      // Le garde-fou vise la DEMONSTRATION, pas l'amorcage : une production a
      // besoin de ses permissions, de ses plans et de ses transporteurs.
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const report = await runSeed(prisma, { silent: true });
        expect(report.permissions).toBeGreaterThan(0);
        expect(report.demoSlug).toBeNull();
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });
});
