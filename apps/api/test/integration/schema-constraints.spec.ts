/**
 * Tests d'integrite du SCHEMA, executes contre un vrai PostgreSQL.
 *
 * Ces tests ne verifient pas du code applicatif : ils verifient que la BASE
 * refuse elle-meme les etats interdits. C'est la derniere ligne de defense,
 * celle qui tient meme si un service contient un bug.
 *
 * Ils couvrent directement les criteres d'acceptation :
 *   - « les donnees de deux boutiques ne sont jamais melangees » (V1 §29) ;
 *   - « le stock respecte les mouvements et regles definis » (V2 §37) ;
 *   - « une resynchronisation ne cree aucun doublon » (V2 §37) ;
 *   - « eviter de creer deux colis pour la meme commande » (V2 §17).
 */

import type { PrismaClient } from '@prisma/client';
import {
  createCarrierAccount,
  createCustomer,
  createOrder,
  createProduct,
  createTenant,
} from '../support/factories';
import { closePrisma, rawPrisma, resetDatabase } from '../support/prisma';

describe('contraintes d integrite du schema', () => {
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

  // ==========================================================================
  describe('isolation multi-tenant garantie par la base', () => {
    it('refuse de rattacher une commande au client d une autre boutique', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);

      const clientDeB = await createCustomer(prisma, boutiqueB.tenantId);
      const produitDeA = await createProduct(prisma, boutiqueA.tenantId);

      // Tentative : une commande de la boutique A pointant vers un client de B.
      // Meme en contournant toute la couche applicative, PostgreSQL refuse.
      await expect(
        prisma.order.create({
          data: {
            tenantId: boutiqueA.tenantId,
            reference: 'ORD-2026-000999',
            source: 'MANUAL',
            status: 'TO_CONFIRM',
            customerId: clientDeB.customerId,
            customerNameSnapshot: 'Client vole',
            phoneSnapshot: '+213555000000',
            itemsTotalCentimes: 0,
            totalCentimes: 0,
          },
        }),
      ).rejects.toThrow();

      // Le produit de A reste bien rattache a A : aucun effet de bord.
      const produit = await prisma.productVariant.findUnique({
        where: { id: produitDeA.variantId },
        select: { tenantId: true },
      });
      expect(produit?.tenantId).toBe(boutiqueA.tenantId);
    });

    it('refuse de rattacher une adresse au client d une autre boutique', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const clientDeB = await createCustomer(prisma, boutiqueB.tenantId);

      await expect(
        prisma.address.create({
          data: {
            tenantId: boutiqueA.tenantId,
            customerId: clientDeB.customerId,
            wilayaCode: 16,
            wilayaName: 'Alger',
            commune: 'Alger Centre',
            addressText: 'Adresse',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse de commander une variante appartenant a une autre boutique', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);

      const clientA = await createCustomer(prisma, boutiqueA.tenantId);
      const produitB = await createProduct(prisma, boutiqueB.tenantId);
      const commandeA = await createOrder(prisma, {
        tenantId: boutiqueA.tenantId,
        customerId: clientA.customerId,
        addressId: clientA.addressId,
        variantId: (await createProduct(prisma, boutiqueA.tenantId)).variantId,
        sku: 'SKU-A',
      });

      await expect(
        prisma.orderItem.create({
          data: {
            tenantId: boutiqueA.tenantId,
            orderId: commandeA.orderId,
            variantId: produitB.variantId,
            productNameSnapshot: 'Produit de la boutique B',
            skuSnapshot: produitB.sku,
            quantity: 1,
            unitPriceCentimes: 100_000,
            lineTotalCentimes: 100_000,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse d affecter une commande a un membre d une autre boutique', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const clientA = await createCustomer(prisma, boutiqueA.tenantId);
      const produitA = await createProduct(prisma, boutiqueA.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutiqueA.tenantId,
        customerId: clientA.customerId,
        addressId: clientA.addressId,
        variantId: produitA.variantId,
        sku: produitA.sku,
      });

      await expect(
        prisma.order.update({
          where: { id: commande.orderId },
          data: { assignedMembershipId: boutiqueB.ownerMembershipId },
        }),
      ).rejects.toThrow();
    });

    it('autorise deux boutiques a utiliser le meme numero de client', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const numero = '+213555111222';

      await createCustomer(prisma, boutiqueA.tenantId, { phoneE164: numero });
      // Le meme client reel peut commander chez deux boutiques differentes :
      // l'unicite est par boutique, pas globale.
      await expect(
        createCustomer(prisma, boutiqueB.tenantId, { phoneE164: numero }),
      ).resolves.toBeDefined();
    });

    it('interdit deux clients au meme numero dans une meme boutique', async () => {
      const boutique = await createTenant(prisma);
      const numero = '+213555333444';
      await createCustomer(prisma, boutique.tenantId, { phoneE164: numero });

      await expect(
        createCustomer(prisma, boutique.tenantId, { phoneE164: numero }),
      ).rejects.toThrow();
    });

    it('autorise la meme reference de commande dans deux boutiques', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);

      for (const boutique of [boutiqueA, boutiqueB]) {
        const client = await createCustomer(prisma, boutique.tenantId);
        await prisma.order.create({
          data: {
            tenantId: boutique.tenantId,
            reference: 'ORD-2026-000001',
            source: 'MANUAL',
            status: 'NEW',
            customerId: client.customerId,
            customerNameSnapshot: 'Client',
            phoneSnapshot: client.phoneE164,
            itemsTotalCentimes: 0,
            totalCentimes: 0,
          },
        });
      }

      const total = await prisma.order.count({ where: { reference: 'ORD-2026-000001' } });
      expect(total).toBe(2);
    });
  });

  // ==========================================================================
  describe('integrite du stock', () => {
    it('refuse un niveau de stock negatif', async () => {
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId, { stock: 5 });

      await expect(
        prisma.inventoryLevel.update({
          where: { variantId: produit.variantId },
          data: { onHand: -1 },
        }),
      ).rejects.toThrow();
    });

    it('refuse une reservation negative', async () => {
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId, { stock: 5 });

      await expect(
        prisma.inventoryLevel.update({
          where: { variantId: produit.variantId },
          data: { reserved: -3 },
        }),
      ).rejects.toThrow();
    });

    it('refuse un mouvement de quantite nulle ou negative', async () => {
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      for (const quantity of [0, -5]) {
        await expect(
          prisma.inventoryMovement.create({
            data: {
              tenantId: boutique.tenantId,
              variantId: produit.variantId,
              type: 'ADJUSTMENT',
              quantity,
              referenceType: 'MANUAL',
              onHandAfter: 10,
              reservedAfter: 0,
              quarantineAfter: 0,
            },
          }),
        ).rejects.toThrow();
      }
    });

    it('refuse une ligne de commande de quantite nulle', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
      });

      await expect(
        prisma.orderItem.create({
          data: {
            tenantId: boutique.tenantId,
            orderId: commande.orderId,
            variantId: produit.variantId,
            productNameSnapshot: 'Produit',
            skuSnapshot: produit.sku,
            quantity: 0,
            unitPriceCentimes: 100_000,
            lineTotalCentimes: 0,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse une quantite preparee superieure a la quantite commandee', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
        quantity: 2,
      });

      await expect(
        prisma.orderItem.update({
          where: { id: commande.itemId },
          data: { preparedQuantity: 3 },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.orderItem.update({
          where: { id: commande.itemId },
          data: { preparedQuantity: 2 },
        }),
      ).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  describe('lots de stock', () => {
    it('refuse un lot de quantite nulle ou negative', async () => {
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      for (const quantity of [0, -3]) {
        await expect(
          prisma.stockBatch.create({
            data: {
              tenantId: boutique.tenantId,
              variantId: produit.variantId,
              quantity,
              remainingQuantity: Math.max(quantity, 0),
              costCentimes: 100_000,
            },
          }),
        ).rejects.toThrow();
      }
    });

    it('refuse qu un lot ait un reste superieur a ce qui est entre', async () => {
      // Le defaut que cette contrainte rend impossible : une erreur de calcul
      // de consommation qui « rendrait » du stock jamais recu.
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      await expect(
        prisma.stockBatch.create({
          data: {
            tenantId: boutique.tenantId,
            variantId: produit.variantId,
            quantity: 10,
            remainingQuantity: 11,
            costCentimes: 100_000,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse un reste negatif', async () => {
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      const lot = await prisma.stockBatch.create({
        data: {
          tenantId: boutique.tenantId,
          variantId: produit.variantId,
          quantity: 10,
          remainingQuantity: 10,
          costCentimes: 100_000,
        },
        select: { id: true },
      });

      await expect(
        prisma.stockBatch.update({ where: { id: lot.id }, data: { remainingQuantity: -1 } }),
      ).rejects.toThrow();
    });

    it('refuse un cout d achat negatif', async () => {
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      await expect(
        prisma.stockBatch.create({
          data: {
            tenantId: boutique.tenantId,
            variantId: produit.variantId,
            quantity: 5,
            remainingQuantity: 5,
            costCentimes: -1,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse un lot rattache a la variante d une autre boutique', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const produitDeB = await createProduct(prisma, boutiqueB.tenantId);

      await expect(
        prisma.stockBatch.create({
          data: {
            tenantId: boutiqueA.tenantId,
            variantId: produitDeB.variantId,
            quantity: 5,
            remainingQuantity: 5,
            costCentimes: 100_000,
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  describe('ventes complementaires', () => {
    it('refuse qu un produit se propose lui-meme', async () => {
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      await expect(
        prisma.productCrossSell.create({
          data: {
            tenantId: boutique.tenantId,
            productId: produit.productId,
            crossSellProductId: produit.productId,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse de proposer le produit d une autre boutique', async () => {
      // Le cas qui compte : les DEUX cotes du lien doivent etre scopes, pas
      // seulement celui qui porte la relation principale.
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const produitDeA = await createProduct(prisma, boutiqueA.tenantId);
      const produitDeB = await createProduct(prisma, boutiqueB.tenantId);

      await expect(
        prisma.productCrossSell.create({
          data: {
            tenantId: boutiqueA.tenantId,
            productId: produitDeA.productId,
            crossSellProductId: produitDeB.productId,
          },
        }),
      ).rejects.toThrow();
    });

    it('accepte un lien entre deux produits de la meme boutique', async () => {
      const boutique = await createTenant(prisma);
      const principal = await createProduct(prisma, boutique.tenantId);
      const accessoire = await createProduct(prisma, boutique.tenantId);

      await expect(
        prisma.productCrossSell.create({
          data: {
            tenantId: boutique.tenantId,
            productId: principal.productId,
            crossSellProductId: accessoire.productId,
          },
        }),
      ).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  describe('grille de frais de livraison', () => {
    it('accepte le code 0, sentinelle de la ligne « Toutes les wilayas »', async () => {
      const boutique = await createTenant(prisma);

      await expect(
        prisma.tenantDeliveryFee.create({
          data: {
            tenantId: boutique.tenantId,
            wilayaCode: 0,
            homeFeeCentimes: 60_000,
            pickupPointFeeCentimes: 40_000,
          },
        }),
      ).resolves.toBeDefined();
    });

    it('refuse un code de wilaya hors 0..58', async () => {
      const boutique = await createTenant(prisma);

      for (const wilayaCode of [-1, 59, 99]) {
        await expect(
          prisma.tenantDeliveryFee.create({
            data: {
              tenantId: boutique.tenantId,
              wilayaCode,
              homeFeeCentimes: 60_000,
              pickupPointFeeCentimes: 40_000,
            },
          }),
        ).rejects.toThrow();
      }
    });

    it('refuse un tarif negatif', async () => {
      const boutique = await createTenant(prisma);

      await expect(
        prisma.tenantDeliveryFee.create({
          data: {
            tenantId: boutique.tenantId,
            wilayaCode: 16,
            homeFeeCentimes: -1,
            pickupPointFeeCentimes: 40_000,
          },
        }),
      ).rejects.toThrow();
    });

    it('n admet qu une ligne par wilaya et par boutique', async () => {
      const boutique = await createTenant(prisma);
      const ligne = {
        tenantId: boutique.tenantId,
        wilayaCode: 16,
        homeFeeCentimes: 60_000,
        pickupPointFeeCentimes: 40_000,
      };

      await prisma.tenantDeliveryFee.create({ data: ligne });
      await expect(prisma.tenantDeliveryFee.create({ data: ligne })).rejects.toThrow();
    });

    it('refuse une surcharge produit qui ne surcharge rien', async () => {
      // Une ligne aux deux tarifs absents ferait croire a un tarif particulier
      // la ou la grille de boutique s applique.
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      await expect(
        prisma.productDeliveryFeeOverride.create({
          data: {
            tenantId: boutique.tenantId,
            productId: produit.productId,
            wilayaCode: 16,
          },
        }),
      ).rejects.toThrow();
    });

    it('accepte une surcharge portant sur un seul mode de livraison', async () => {
      // Le cas de la livraison offerte : 0 est une valeur, pas une absence.
      const boutique = await createTenant(prisma);
      const produit = await createProduct(prisma, boutique.tenantId);

      await expect(
        prisma.productDeliveryFeeOverride.create({
          data: {
            tenantId: boutique.tenantId,
            productId: produit.productId,
            wilayaCode: 16,
            homeFeeCentimes: 0,
          },
        }),
      ).resolves.toBeDefined();
    });

    it('refuse une surcharge sur le produit d une autre boutique', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const produitDeB = await createProduct(prisma, boutiqueB.tenantId);

      await expect(
        prisma.productDeliveryFeeOverride.create({
          data: {
            tenantId: boutiqueA.tenantId,
            productId: produitDeB.productId,
            wilayaCode: 16,
            homeFeeCentimes: 10_000,
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  describe('capacites et couverture des transporteurs', () => {
    /** Transporteur de plateforme, hors perimetre tenant. */
    async function createCarrier(): Promise<string> {
      const carrier = await prisma.carrier.create({
        data: {
          code: `TEST_${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
          name: 'Transporteur de test',
        },
        select: { id: true },
      });
      return carrier.id;
    }

    it('refuse un annuaire de bureaux sans livraison au bureau', async () => {
      // La seconde capacite presuppose la premiere : lister des bureaux chez un
      // transporteur qui n y livre pas ne veut rien dire.
      const carrierId = await createCarrier();

      await expect(
        prisma.carrierCapability.create({
          data: { carrierId, pickupPointDelivery: false, pickupPointDirectory: true },
        }),
      ).rejects.toThrow();
    });

    it('accepte un annuaire quand la livraison au bureau existe', async () => {
      const carrierId = await createCarrier();

      await expect(
        prisma.carrierCapability.create({
          data: { carrierId, pickupPointDelivery: true, pickupPointDirectory: true },
        }),
      ).resolves.toBeDefined();
    });

    it('n admet qu une seule matrice par transporteur', async () => {
      const carrierId = await createCarrier();

      await prisma.carrierCapability.create({ data: { carrierId } });
      await expect(prisma.carrierCapability.create({ data: { carrierId } })).rejects.toThrow();
    });

    it('refuse une couverture qui ne couvre aucun mode', async () => {
      // L absence de ligne dit deja « couverture inconnue » : une ligne vide
      // brouillerait la distinction avec « non desservie ».
      const carrierId = await createCarrier();

      await expect(
        prisma.carrierWilayaCoverage.create({
          data: { carrierId, wilayaCode: 16, homeDelivery: false, pickupPoint: false },
        }),
      ).rejects.toThrow();
    });

    it('refuse un code de wilaya hors du decoupage, sentinelle comprise', async () => {
      // Contrairement a la grille tarifaire de la boutique, il n y a pas de
      // ligne « toutes les wilayas » ici : 0 doit etre refuse.
      const carrierId = await createCarrier();

      for (const wilayaCode of [0, 59, -3]) {
        await expect(
          prisma.carrierWilayaCoverage.create({
            data: { carrierId, wilayaCode, homeDelivery: true },
          }),
        ).rejects.toThrow();
      }
    });

    it('refuse un delai indicatif negatif', async () => {
      const carrierId = await createCarrier();

      await expect(
        prisma.carrierWilayaCoverage.create({
          data: { carrierId, wilayaCode: 16, homeDelivery: true, leadTimeDays: -1 },
        }),
      ).rejects.toThrow();
    });

    it('n admet qu une ligne par couple transporteur / wilaya', async () => {
      const carrierId = await createCarrier();
      const ligne = { carrierId, wilayaCode: 16, homeDelivery: true };

      await prisma.carrierWilayaCoverage.create({ data: ligne });
      await expect(prisma.carrierWilayaCoverage.create({ data: ligne })).rejects.toThrow();
    });

    it('supprime capacites et couverture avec le transporteur', async () => {
      const carrierId = await createCarrier();
      await prisma.carrierCapability.create({ data: { carrierId } });
      await prisma.carrierWilayaCoverage.create({
        data: { carrierId, wilayaCode: 16, homeDelivery: true },
      });

      await prisma.carrier.delete({ where: { id: carrierId } });

      expect(await prisma.carrierCapability.findUnique({ where: { carrierId } })).toBeNull();
      expect(await prisma.carrierWilayaCoverage.count({ where: { carrierId } })).toBe(0);
    });
  });

  // ==========================================================================
  describe('coherence des donnees metier', () => {
    it('refuse un code de wilaya hors du referentiel algerien', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);

      for (const wilayaCode of [0, 59, 99]) {
        await expect(
          prisma.address.create({
            data: {
              tenantId: boutique.tenantId,
              customerId: client.customerId,
              wilayaCode,
              wilayaName: 'Inconnue',
              commune: 'X',
              addressText: 'Y',
            },
          }),
        ).rejects.toThrow();
      }
    });

    it('refuse un montant de commande negatif', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);

      await expect(
        prisma.order.create({
          data: {
            tenantId: boutique.tenantId,
            reference: 'ORD-2026-000500',
            source: 'MANUAL',
            status: 'NEW',
            customerId: client.customerId,
            customerNameSnapshot: 'Client',
            phoneSnapshot: client.phoneE164,
            itemsTotalCentimes: -1,
            totalCentimes: -1,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse un score de fiabilite hors de la plage 0-100', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);

      await expect(
        prisma.customer.update({
          where: { id: client.customerId },
          data: { reliabilityScore: 150 },
        }),
      ).rejects.toThrow();
    });

    it('refuse un essai dont la fin precede le debut', async () => {
      const boutique = await createTenant(prisma, { subscription: 'none' });
      const now = new Date();

      await expect(
        prisma.subscription.create({
          data: {
            tenantId: boutique.tenantId,
            status: 'TRIAL_ACTIVE',
            trialStartAt: now,
            trialEndAt: new Date(now.getTime() - 86_400_000),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuse un role de plateforme rattache a une boutique', async () => {
      const boutique = await createTenant(prisma);

      await expect(
        prisma.role.create({
          data: {
            tenantId: boutique.tenantId,
            scope: 'PLATFORM',
            code: 'FAUX_SUPER_ADMIN',
            name: 'Tentative d elevation',
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  describe('idempotence garantie par index uniques', () => {
    it('interdit deux commandes pour la meme ligne source', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);

      await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
        externalOrderId: 'SHEET-ROW-42',
      });

      await expect(
        prisma.order.create({
          data: {
            tenantId: boutique.tenantId,
            reference: 'ORD-2026-000777',
            source: 'MANUAL',
            externalOrderId: 'SHEET-ROW-42',
            status: 'NEW',
            customerId: client.customerId,
            customerNameSnapshot: 'Client',
            phoneSnapshot: client.phoneE164,
            itemsTotalCentimes: 0,
            totalCentimes: 0,
          },
        }),
      ).rejects.toThrow();
    });

    it('autorise plusieurs commandes sans identifiant externe', async () => {
      // NULL n'est jamais egal a NULL en SQL : l'unicite ne s'applique pas
      // aux commandes saisies manuellement, qui n'ont pas d'identifiant source.
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);

      for (let i = 0; i < 3; i += 1) {
        await expect(
          createOrder(prisma, {
            tenantId: boutique.tenantId,
            customerId: client.customerId,
            addressId: client.addressId,
            variantId: produit.variantId,
            sku: produit.sku,
          }),
        ).resolves.toBeDefined();
      }
    });

    it('interdit deux colis actifs pour la meme commande', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
        status: 'READY_TO_SHIP',
      });
      const compte = await createCarrierAccount(prisma, boutique.tenantId);

      await prisma.shipment.create({
        data: {
          tenantId: boutique.tenantId,
          orderId: commande.orderId,
          carrierId: compte.carrierId,
          carrierAccountId: compte.carrierAccountId,
          idempotencyKey: 'ship-1',
          status: 'CREATED',
          trackingNumber: 'TRK-1',
        },
      });

      await expect(
        prisma.shipment.create({
          data: {
            tenantId: boutique.tenantId,
            orderId: commande.orderId,
            carrierId: compte.carrierId,
            carrierAccountId: compte.carrierAccountId,
            idempotencyKey: 'ship-2',
            status: 'CREATED',
            trackingNumber: 'TRK-2',
          },
        }),
      ).rejects.toThrow();
    });

    it('autorise un nouveau colis apres annulation du precedent', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
        status: 'READY_TO_SHIP',
      });
      const compte = await createCarrierAccount(prisma, boutique.tenantId);

      const premier = await prisma.shipment.create({
        data: {
          tenantId: boutique.tenantId,
          orderId: commande.orderId,
          carrierId: compte.carrierId,
          carrierAccountId: compte.carrierAccountId,
          idempotencyKey: 'ship-a',
          status: 'CREATED',
          trackingNumber: 'TRK-A',
        },
        select: { id: true },
      });

      await prisma.shipment.update({
        where: { id: premier.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      // Un colis annule ne doit pas bloquer une nouvelle expedition :
      // c'est exactement le cas d'un changement de transporteur.
      await expect(
        prisma.shipment.create({
          data: {
            tenantId: boutique.tenantId,
            orderId: commande.orderId,
            carrierId: compte.carrierId,
            carrierAccountId: compte.carrierAccountId,
            idempotencyKey: 'ship-b',
            status: 'CREATED',
            trackingNumber: 'TRK-B',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('interdit deux retours ouverts pour la meme commande', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
        status: 'RETURNED',
      });

      await prisma.return.create({
        data: {
          tenantId: boutique.tenantId,
          orderId: commande.orderId,
          reference: 'RET-1',
          reason: 'CUSTOMER_ABSENT',
          status: 'PENDING',
        },
      });

      await expect(
        prisma.return.create({
          data: {
            tenantId: boutique.tenantId,
            orderId: commande.orderId,
            reference: 'RET-2',
            reason: 'CUSTOMER_REFUSED',
            status: 'PENDING',
          },
        }),
      ).rejects.toThrow();
    });

    it('autorise un nouveau retour apres cloture du precedent', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
        status: 'DELIVERED',
      });

      const premier = await prisma.return.create({
        data: {
          tenantId: boutique.tenantId,
          orderId: commande.orderId,
          reference: 'RET-A',
          reason: 'CUSTOMER_ABSENT',
          status: 'PENDING',
        },
        select: { id: true },
      });

      await prisma.return.update({
        where: { id: premier.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });

      // Un SAV ulterieur sur la meme commande reste possible.
      await expect(
        prisma.return.create({
          data: {
            tenantId: boutique.tenantId,
            orderId: commande.orderId,
            reference: 'RET-B',
            reason: 'PRODUCT_NOT_CONFORM',
            status: 'PENDING',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('interdit deux evenements transporteur identiques (webhook rejoue)', async () => {
      const boutique = await createTenant(prisma);
      const client = await createCustomer(prisma, boutique.tenantId);
      const produit = await createProduct(prisma, boutique.tenantId);
      const commande = await createOrder(prisma, {
        tenantId: boutique.tenantId,
        customerId: client.customerId,
        addressId: client.addressId,
        variantId: produit.variantId,
        sku: produit.sku,
      });
      const compte = await createCarrierAccount(prisma, boutique.tenantId);

      const colis = await prisma.shipment.create({
        data: {
          tenantId: boutique.tenantId,
          orderId: commande.orderId,
          carrierId: compte.carrierId,
          carrierAccountId: compte.carrierAccountId,
          idempotencyKey: 'ship-evt',
          status: 'IN_TRANSIT',
          trackingNumber: 'TRK-EVT',
        },
        select: { id: true },
      });

      const evenement = {
        tenantId: boutique.tenantId,
        shipmentId: colis.id,
        providerStatus: 'EN_COURS',
        normalizedStatus: 'IN_TRANSIT' as const,
        occurredAt: new Date(),
        fingerprint: 'evt-hash-1',
      };

      await prisma.shipmentEvent.create({ data: evenement });
      await expect(prisma.shipmentEvent.create({ data: evenement })).rejects.toThrow();
    });

    it('interdit deux boutiques liees au meme numero verifie', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const numero = '+213555999888';

      await prisma.trialRegistration.create({
        data: {
          tenantId: boutiqueA.tenantId,
          userId: boutiqueA.ownerUserId,
          verifiedPhoneE164: numero,
          emailNormalized: 'a@test.local',
          decision: 'ALLOW',
        },
      });

      await expect(
        prisma.trialRegistration.create({
          data: {
            tenantId: boutiqueB.tenantId,
            userId: boutiqueB.ownerUserId,
            verifiedPhoneE164: numero,
            emailNormalized: 'b@test.local',
            decision: 'ALLOW',
          },
        }),
      ).rejects.toThrow();
    });

    it('autorise plusieurs inscriptions sans numero verifie', async () => {
      // L'index unique est PARTIEL : les lignes sans numero ne se bloquent pas
      // entre elles.
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);

      for (const boutique of [boutiqueA, boutiqueB]) {
        await expect(
          prisma.trialRegistration.create({
            data: {
              tenantId: boutique.tenantId,
              userId: boutique.ownerUserId,
              verifiedPhoneE164: null,
              emailNormalized: `${boutique.slug}@test.local`,
              decision: 'ALLOW',
            },
          }),
        ).resolves.toBeDefined();
      }
    });
  });

  // ==========================================================================
  describe('unicite conditionnelle des elements par defaut', () => {
    it('interdit deux transporteurs par defaut dans une boutique', async () => {
      const boutique = await createTenant(prisma);
      await createCarrierAccount(prisma, boutique.tenantId, 'MOCK_CARRIER');

      const autre = await prisma.carrier.findUniqueOrThrow({
        where: { code: 'YALIDINE' },
        select: { id: true },
      });

      await expect(
        prisma.carrierAccount.create({
          data: {
            tenantId: boutique.tenantId,
            carrierId: autre.id,
            label: 'second',
            status: 'CONNECTED',
            isDefault: true,
          },
        }),
      ).rejects.toThrow();
    });

    it('autorise plusieurs transporteurs non prioritaires', async () => {
      const boutique = await createTenant(prisma);
      await createCarrierAccount(prisma, boutique.tenantId, 'MOCK_CARRIER');

      const autre = await prisma.carrier.findUniqueOrThrow({
        where: { code: 'YALIDINE' },
        select: { id: true },
      });

      await expect(
        prisma.carrierAccount.create({
          data: {
            tenantId: boutique.tenantId,
            carrierId: autre.id,
            label: 'secours',
            status: 'CONNECTED',
            isDefault: false,
          },
        }),
      ).resolves.toBeDefined();
    });
  });
});
