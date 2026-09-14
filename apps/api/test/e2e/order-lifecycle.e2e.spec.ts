/**
 * Test de bout en bout du PARCOURS COMPLET d'une commande.
 *
 * Couvre le scenario impose par les cahiers des charges (V1 Annexe A, V2 §39,
 * cahier de mission §48) :
 *
 *   Inscription -> essai 7 jours -> catalogue -> commande -> confirmation ->
 *   preparation -> expedition -> tracking -> livraison
 *
 * puis, dans un second parcours :
 *
 *   commande -> expedition -> retour -> inspection -> remise en stock
 *
 * Tout passe par de VRAIES requetes HTTP : gardes, permissions, validation,
 * serialisation et filtre d'exceptions sont exerces comme en production.
 */

import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { MockCarrierAdapter } from '../../src/modules/shipments/carriers/mock-carrier.adapter';
import { closePrisma, rawPrisma, resetDatabase } from '../support/prisma';
import { buildE2eApp, type E2eApp } from '../support/e2e-app';

describe('parcours complet d une commande', () => {
  let prisma: PrismaClient;
  let api: E2eApp;
  let mockCarrier: MockCarrierAdapter;

  /** Jeton d'acces du proprietaire, et identifiants utiles au scenario. */
  let accessToken: string;
  let tenantId: string;
  let variantId: string;
  let productSku: string;

  beforeAll(async () => {
    prisma = rawPrisma();
    api = await buildE2eApp();
    mockCarrier = api.get(MockCarrierAdapter);
  }, 180_000);

  afterAll(async () => {
    await api.close();
    await closePrisma();
  });

  beforeEach(async () => {
    await resetDatabase();
    mockCarrier.reset();
  });

  // --------------------------------------------------------------------------
  // Outils
  // --------------------------------------------------------------------------

  const url = (path: string): string => `${api.prefix}${path}`;

  /** Serie de numeros de telephone uniques pour les inscriptions du scenario. */
  let phoneCounter = 100_000;

  /**
   * Inscrit un proprietaire et sa boutique par le VRAI parcours :
   * demande de code OTP puis inscription. Le pilote OTP `console` renvoie le
   * code dans la reponse en environnement de test.
   */
  async function registerOwner(suffix = 'a'): Promise<{
    token: string;
    tenantId: string;
    email: string;
  }> {
    // Un mobile algerien compte exactement 10 chiffres (0X XX XX XX XX).
    // Le compteur garantit l'unicite entre les inscriptions du scenario.
    phoneCounter += 1;
    const phone = `0555${phoneCounter.toString().padStart(6, '0')}`;

    const otpResponse = await request(api.server)
      .post(url('/auth/otp/request'))
      .send({ phone })
      .expect(200);

    expect(otpResponse.body.devCode).toBeDefined();

    const email = `proprio-${suffix}-${Date.now()}@boutique.test`;

    const registerResponse = await request(api.server)
      .post(url('/auth/register'))
      .send({
        email,
        password: 'MotDePasseSolide2026',
        fullName: 'Sara Proprietaire',
        storeName: `Boutique ${suffix.toUpperCase()}`,
        phone,
        otpCode: otpResponse.body.devCode,
        acceptTerms: true,
      })
      .expect(201);

    expect(registerResponse.body.tokens.accessToken).toBeDefined();
    expect(registerResponse.body.tenant.id).toBeDefined();

    return {
      token: registerResponse.body.tokens.accessToken,
      tenantId: registerResponse.body.tenant.id,
      email,
    };
  }

  /** Cree un produit avec du stock via l'API. */
  async function createProduct(token: string, stock = 20): Promise<{ variantId: string; sku: string }> {
    const sku = `PRD-${Math.floor(Math.random() * 1_000_000)}`;

    const response = await request(api.server)
      .post(url('/products'))
      .set('authorization', `Bearer ${token}`)
      .send({
        name: 'Robe longue brodee',
        sku,
        categoryName: 'Vetements',
        salePriceCentimes: 450_000,
        purchasePriceCentimes: 250_000,
        initialStock: stock,
      })
      .expect(201);

    return { variantId: response.body.variantIds[0], sku: `${sku}-STD` };
  }

  /** Configure un compte transporteur de test. */
  /**
   * Declare un compte transporteur PAR LA ROUTE REELLE.
   *
   * Cette fixture ecrivait la ligne directement en base, avec un
   * `status: 'CONNECTED'` pose a la main — parce qu'aucune route ne savait
   * creer un compte. Elle contournait donc precisement ce qui manquait au
   * produit, et le parcours nominal restait vert alors qu'aucune boutique
   * reelle n'aurait pu expedier. Passer par HTTP fait du scenario une preuve.
   */
  async function setupCarrier(token: string): Promise<string> {
    const carrier = await prisma.carrier.findUniqueOrThrow({
      where: { code: 'MOCK_CARRIER' },
      select: { id: true },
    });

    const response = await request(api.server)
      .post(url('/carrier-accounts'))
      .set('authorization', `Bearer ${token}`)
      .send({
        carrierId: carrier.id,
        label: 'Transporteur de test',
        credentials: { apiKey: 'cle-de-test' },
        isDefault: true,
      })
      .expect(201);

    // Le compte est utilisable IMMEDIATEMENT : le connecteur a ete interroge
    // dans la foulee, et le statut decrit cette tentative reelle.
    expect(response.body.status).toBe('CONNECTED');

    return response.body.id as string;
  }

  async function createOrder(token: string, sku: string, quantity = 2): Promise<string> {
    const response = await request(api.server)
      .post(url('/orders'))
      .set('authorization', `Bearer ${token}`)
      .send({
        customerName: 'Yacine Client',
        phone: '0661234567',
        wilaya: 'Alger',
        commune: 'Bab Ezzouar',
        addressText: 'Cite 1200 Logements, Bat B4',
        lines: [{ sku, quantity }],
        deliveryFeeCentimes: 50_000,
      })
      .expect(201);

    expect(response.body.reference).toMatch(/^ORD-\d{4}-\d{6}$/);
    return response.body.orderId;
  }

  async function stockOf(variant: string) {
    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId: variant },
      select: { onHand: true, reserved: true, quarantine: true },
    });
    return { ...level, available: level.onHand - level.reserved };
  }

  // ==========================================================================
  describe('inscription et essai gratuit', () => {
    it('cree le compte, la boutique et demarre un essai de 7 jours', async () => {
      const owner = await registerOwner('a');

      const response = await request(api.server)
        .get(url('/subscriptions/current'))
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(response.body.status).toBe('TRIAL_ACTIVE');
      expect(response.body.operational).toBe(true);
      expect(response.body.trialDaysRemaining).toBe(7);
    });

    it('refuse un second essai avec le meme numero verifie', async () => {
      const phone = '0555987654';

      const otp1 = await request(api.server)
        .post(url('/auth/otp/request'))
        .send({ phone })
        .expect(200);

      await request(api.server)
        .post(url('/auth/register'))
        .send({
          email: `premier-${Date.now()}@test.dz`,
          password: 'MotDePasseSolide2026',
          fullName: 'Premier Compte',
          storeName: 'Premiere Boutique',
          phone,
          otpCode: otp1.body.devCode,
          acceptTerms: true,
        })
        .expect(201);

      // Le delai anti-renvoi impose d'attendre : on consomme directement un
      // nouveau code en supprimant le verrou temporel via un nouveau numero
      // serait tricher. On force donc l'expiration du delai en base.
      await prisma.otpChallenge.updateMany({
        where: { phoneE164: '+213555987654' },
        data: { createdAt: new Date(Date.now() - 120_000) },
      });

      const otp2 = await request(api.server)
        .post(url('/auth/otp/request'))
        .send({ phone })
        .expect(200);

      const second = await request(api.server)
        .post(url('/auth/register'))
        .send({
          email: `second-${Date.now()}@test.dz`,
          password: 'MotDePasseSolide2026',
          fullName: 'Second Compte',
          storeName: 'Seconde Boutique',
          phone,
          otpCode: otp2.body.devCode,
          acceptTerms: true,
        })
        .expect(403);

      expect(second.body.code).toBe('TRIAL_ALREADY_USED');
    });

    it('refuse une inscription sans code OTP valide', async () => {
      const response = await request(api.server)
        .post(url('/auth/register'))
        .send({
          email: `sansotp-${Date.now()}@test.dz`,
          password: 'MotDePasseSolide2026',
          fullName: 'Sans OTP',
          storeName: 'Boutique',
          phone: '0555111222',
          otpCode: '000000',
          acceptTerms: true,
        })
        .expect(400);

      expect(response.body.code).toBe('AUTH_OTP_INVALID');
    });

    it('refuse un champ non declare dans le DTO', async () => {
      const response = await request(api.server)
        .post(url('/auth/register'))
        .send({
          email: `injection-${Date.now()}@test.dz`,
          password: 'MotDePasseSolide2026',
          fullName: 'Tentative',
          storeName: 'Boutique',
          phone: '0555333444',
          otpCode: '123456',
          acceptTerms: true,
          // Champ non declare : doit etre REFUSE, pas ignore.
          isPlatformAdmin: true,
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // ==========================================================================
  describe('comptes transporteur', () => {
    beforeEach(async () => {
      const owner = await registerOwner('carrier');
      accessToken = owner.token;
      tenantId = owner.tenantId;
    });

    it('chiffre les identifiants, et ne les renvoie jamais dans la liste', async () => {
      await setupCarrier(accessToken);

      const listed = await request(api.server)
        .get(url('/carrier-accounts'))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      // La liste dit QUELLES cles sont renseignees, jamais leurs valeurs.
      expect(listed.body[0].credentialKeys).toEqual(['apiKey']);
      expect(JSON.stringify(listed.body)).not.toContain('cle-de-test');
      expect(listed.body[0].credentialsEncrypted).toBeUndefined();
      expect(listed.body[0].deletable).toBe(true);
    });

    it('refuse un compte chez un transporteur sans connecteur', async () => {
      // Maystro : les sources publiques se contredisent jusque sur l'hote, donc
      // aucun adaptateur n'est ecrit et la route doit le refuser (D-070).
      const maystro = await prisma.carrier.findUniqueOrThrow({
        where: { code: 'MAYSTRO' },
        select: { id: true },
      });

      const response = await request(api.server)
        .post(url('/carrier-accounts'))
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          carrierId: maystro.id,
          label: 'Maystro',
          credentials: {},
        })
        .expect(501);

      expect(response.body.code).toBe('CARRIER_NOT_CONFIGURED');
    });

    it('annonce les transporteurs non selectionnables et leurs champs', async () => {
      const response = await request(api.server)
        .get(url('/carrier-connectors'))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      const byCode = new Map<string, { selectable: boolean; credentialFields: unknown[] }>(
        response.body.map((entry: { code: string }) => [entry.code, entry]),
      );

      expect(byCode.get('YALIDINE')?.selectable).toBe(true);
      // API ID, token, wilaya d'expedition, et l'URL de base depuis D-070.
      expect(byCode.get('YALIDINE')?.credentialFields).toHaveLength(4);

      // NON VERIFIE reste selectionnable : c'est la seule facon de le
      // confronter un jour a un vrai compte (D-070).
      expect(byCode.get('ECOTRACK')?.selectable).toBe(true);
      // SANS ADAPTATEUR, non.
      expect(byCode.get('MAYSTRO')?.selectable).toBe(false);
    });

    it('refuse un champ non declare dans le DTO', async () => {
      const carrier = await prisma.carrier.findUniqueOrThrow({
        where: { code: 'MOCK_CARRIER' },
        select: { id: true },
      });

      const response = await request(api.server)
        .post(url('/carrier-accounts'))
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          carrierId: carrier.id,
          label: 'Compte',
          credentials: { apiKey: 'x' },
          // Champ non declare : doit etre REFUSE, pas ignore.
          status: 'CONNECTED',
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // ==========================================================================
  describe('parcours nominal : de la commande a la livraison', () => {
    beforeEach(async () => {
      const owner = await registerOwner('b');
      accessToken = owner.token;
      tenantId = owner.tenantId;

      const product = await createProduct(accessToken, 20);
      variantId = product.variantId;
      productSku = product.sku;

      await setupCarrier(accessToken);
    });

    it('mene une commande jusqu a LIVREE, avec un stock coherent', async () => {
      // --- 1. Creation ------------------------------------------------------
      const orderId = await createOrder(accessToken, productSku, 2);

      let order = await request(api.server)
        .get(url(`/orders/${orderId}`))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(order.body.status).toBe('TO_CONFIRM');
      expect(order.body.totalCentimes).toBe(950_000);
      expect(await stockOf(variantId)).toMatchObject({ onHand: 20, reserved: 0 });

      // --- 2. La commande apparait dans la file de confirmation -------------
      const queue = await request(api.server)
        .get(url('/confirmation/queue'))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(queue.body.data.map((entry: { orderId: string }) => entry.orderId)).toContain(orderId);

      // --- 3. Confirmation par l'agent --------------------------------------
      const confirmed = await request(api.server)
        .post(url(`/confirmation/orders/${orderId}/action`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({ action: 'CONFIRM', note: 'Client joint, commande confirmee.' })
        .expect(200);

      expect(confirmed.body.to).toBe('CONFIRMED');
      expect(confirmed.body.attemptNumber).toBe(1);
      // Le stock est reserve, pas encore sorti.
      expect(await stockOf(variantId)).toMatchObject({ onHand: 20, reserved: 2, available: 18 });

      // --- 4. Preparation ----------------------------------------------------
      await request(api.server)
        .post(url(`/orders/${orderId}/status`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({ status: 'IN_PREPARATION' })
        .expect(200);

      // Le preparateur valide les quantites.
      await prisma.orderItem.updateMany({
        where: { orderId },
        data: { preparedQuantity: 2 },
      });

      await request(api.server)
        .post(url(`/orders/${orderId}/status`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({ status: 'READY_TO_SHIP' })
        .expect(200);

      // --- 5. Expedition -----------------------------------------------------
      const shipment = await request(api.server)
        .post(url(`/orders/${orderId}/ship`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({ deliveryType: 'HOME', weightGrams: 800 })
        .expect(201);

      expect(shipment.body.trackingNumber).toMatch(/^MOCK-/);
      expect(shipment.body.alreadyExisted).toBe(false);

      order = await request(api.server)
        .get(url(`/orders/${orderId}`))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(order.body.status).toBe('SHIPPED');
      // La marchandise a physiquement quitte l'entrepot.
      expect(await stockOf(variantId)).toMatchObject({ onHand: 18, reserved: 0, available: 18 });
      // Le cout transporteur alimente le calcul de rentabilite.
      expect(order.body.carrierCostCentimes).toBe(45_000);

      // --- 6. Suivi transporteur --------------------------------------------
      const trackingNumber = shipment.body.trackingNumber as string;
      mockCarrier.advance(trackingNumber, 'IN_TRANSIT', 'Colis en transit.');
      mockCarrier.advance(trackingNumber, 'OUT_FOR_DELIVERY', 'Sorti en livraison.');

      const synced = await request(api.server)
        .post(url(`/shipments/${shipment.body.shipmentId}/sync-tracking`))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(synced.body.newEvents).toBeGreaterThan(0);
      expect(synced.body.orderTransition).toMatchObject({ to: 'IN_DELIVERY' });

      // --- 7. Livraison ------------------------------------------------------
      mockCarrier.advance(trackingNumber, 'DELIVERED', 'Colis remis au client.');

      await request(api.server)
        .post(url(`/shipments/${shipment.body.shipmentId}/sync-tracking`))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      order = await request(api.server)
        .get(url(`/orders/${orderId}`))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(order.body.status).toBe('DELIVERED');
      expect(order.body.deliveredAt).not.toBeNull();

      // --- 8. Le chiffre d'affaires est reconnu -----------------------------
      const profitability = await request(api.server)
        .get(url('/reports/profitability'))
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);

      // CA = 2 x 4500 + 500 = 9500 DA ; COGS = 2 x 2500 = 5000 ; transport 450.
      expect(profitability.body.recognizedRevenueCentimes).toBe(950_000);
      expect(profitability.body.cogsCentimes).toBe(500_000);
      expect(profitability.body.shippingCostCentimes).toBe(45_000);
      expect(profitability.body.netResultCentimes).toBe(405_000);
      expect(profitability.body.realizedLossCentimes).toBe(0);

      // --- 9. Le client est comptabilise comme fiable -----------------------
      const customer = await prisma.customer.findFirstOrThrow({
        where: { tenantId },
        select: { deliveredCount: true, consecutiveFailures: true },
      });
      expect(customer.deliveredCount).toBe(1);
      expect(customer.consecutiveFailures).toBe(0);
    }, 180_000);

    it('rend une seconde expedition inoffensive (idempotence)', async () => {
      const orderId = await createOrder(accessToken, productSku, 1);

      await request(api.server)
        .post(url(`/confirmation/orders/${orderId}/action`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({ action: 'CONFIRM' })
        .expect(200);

      await request(api.server)
        .post(url(`/orders/${orderId}/status`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({ status: 'IN_PREPARATION' })
        .expect(200);

      await prisma.orderItem.updateMany({ where: { orderId }, data: { preparedQuantity: 1 } });

      await request(api.server)
        .post(url(`/orders/${orderId}/status`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({ status: 'READY_TO_SHIP' })
        .expect(200);

      const first = await request(api.server)
        .post(url(`/orders/${orderId}/ship`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(201);

      const second = await request(api.server)
        .post(url(`/orders/${orderId}/ship`))
        .set('authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(201);

      expect(second.body.alreadyExisted).toBe(true);
      expect(second.body.trackingNumber).toBe(first.body.trackingNumber);

      const shipments = await prisma.shipment.count({ where: { orderId } });
      expect(shipments).toBe(1);
    }, 120_000);
  });

  // ==========================================================================
  describe('parcours de retour', () => {
    it('cree le retour, l inspecte et remet la marchandise en stock', async () => {
      const owner = await registerOwner('c');
      const product = await createProduct(owner.token, 10);
      await setupCarrier(owner.token);

      const orderId = await createOrder(owner.token, product.sku, 1);

      // Parcours jusqu a l'expedition.
      await request(api.server)
        .post(url(`/confirmation/orders/${orderId}/action`))
        .set('authorization', `Bearer ${owner.token}`)
        .send({ action: 'CONFIRM' })
        .expect(200);

      await request(api.server)
        .post(url(`/orders/${orderId}/status`))
        .set('authorization', `Bearer ${owner.token}`)
        .send({ status: 'IN_PREPARATION' })
        .expect(200);

      await prisma.orderItem.updateMany({ where: { orderId }, data: { preparedQuantity: 1 } });

      await request(api.server)
        .post(url(`/orders/${orderId}/status`))
        .set('authorization', `Bearer ${owner.token}`)
        .send({ status: 'READY_TO_SHIP' })
        .expect(200);

      const shipment = await request(api.server)
        .post(url(`/orders/${orderId}/ship`))
        .set('authorization', `Bearer ${owner.token}`)
        .send({})
        .expect(201);

      expect(await stockOf(product.variantId)).toMatchObject({ onHand: 9, reserved: 0 });

      // --- Le transporteur signale un retour --------------------------------
      mockCarrier.advance(shipment.body.trackingNumber, 'RETURNING', 'Client absent.');
      mockCarrier.advance(shipment.body.trackingNumber, 'RETURNED', 'Retourne au vendeur.');

      await request(api.server)
        .post(url(`/shipments/${shipment.body.shipmentId}/sync-tracking`))
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200);

      const order = await request(api.server)
        .get(url(`/orders/${orderId}`))
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(order.body.status).toBe('RETURNED');

      // --- Creation du retour ------------------------------------------------
      const created = await request(api.server)
        .post(url(`/orders/${orderId}/returns`))
        .set('authorization', `Bearer ${owner.token}`)
        .send({ reason: 'CUSTOMER_ABSENT', returnCostCentimes: 30_000 })
        .expect(201);

      const returnId = created.body.returnId as string;

      // Le stock n'a PAS bouge : le colis n'est pas encore revenu.
      expect(await stockOf(product.variantId)).toMatchObject({ onHand: 9 });

      // --- Reception et inspection -------------------------------------------
      await request(api.server)
        .post(url(`/returns/${returnId}/received`))
        .set('authorization', `Bearer ${owner.token}`)
        .expect(204);

      const returnDetail = await request(api.server)
        .get(url(`/returns/${returnId}`))
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200);

      const returnItemId = returnDetail.body.items[0].id as string;

      const inspected = await request(api.server)
        .post(url(`/returns/${returnId}/inspect`))
        .set('authorization', `Bearer ${owner.token}`)
        .send({
          lines: [{ returnItemId, condition: 'SELLABLE', stockDecision: 'RESTOCK' }],
          returnCostCentimes: 30_000,
        })
        .expect(200);

      expect(inspected.body.restocked).toBe(1);
      // La marchandise est revenue en stock vendable.
      expect(await stockOf(product.variantId)).toMatchObject({ onHand: 10, reserved: 0 });

      // --- Cloture ------------------------------------------------------------
      await request(api.server)
        .post(url(`/returns/${returnId}/close`))
        .set('authorization', `Bearer ${owner.token}`)
        .expect(204);

      // --- La perte est bien celle du transport, pas de la marchandise -------
      const profitability = await request(api.server)
        .get(url('/reports/profitability'))
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(profitability.body.recognizedRevenueCentimes).toBe(0);
      // 450 (aller) + 300 (retour) = 750 DA de perte reelle.
      expect(profitability.body.realizedLossCentimes).toBe(75_000);
      // La marchandise etant recuperee, elle n'est pas comptee en perte.
      expect(profitability.body.cogsCentimes).toBe(0);
      // Le manque a gagner reste visible, distinct de la perte.
      expect(profitability.body.opportunityLossCentimes).toBe(500_000);
    }, 180_000);
  });

  // ==========================================================================
  describe('isolation entre boutiques', () => {
    it('empeche une boutique de lire la commande d une autre', async () => {
      const boutiqueA = await registerOwner('d');
      const boutiqueB = await registerOwner('e');

      const productA = await createProduct(boutiqueA.token, 5);
      const orderIdA = await createOrder(boutiqueA.token, productA.sku, 1);

      // La boutique B connait l'identifiant mais ne doit rien pouvoir en faire.
      await request(api.server)
        .get(url(`/orders/${orderIdA}`))
        .set('authorization', `Bearer ${boutiqueB.token}`)
        .expect(404);

      await request(api.server)
        .post(url(`/orders/${orderIdA}/status`))
        .set('authorization', `Bearer ${boutiqueB.token}`)
        .send({ status: 'CONFIRMED' })
        .expect(404);

      // La commande de A est intacte.
      const order = await request(api.server)
        .get(url(`/orders/${orderIdA}`))
        .set('authorization', `Bearer ${boutiqueA.token}`)
        .expect(200);
      expect(order.body.status).toBe('TO_CONFIRM');
    }, 180_000);

    it('refuse un en-tete X-Tenant-Id pointant une boutique etrangere', async () => {
      const boutiqueA = await registerOwner('f');
      const boutiqueB = await registerOwner('g');

      const response = await request(api.server)
        .get(url('/orders'))
        .set('authorization', `Bearer ${boutiqueA.token}`)
        .set('x-tenant-id', boutiqueB.tenantId)
        .expect(403);

      expect(response.body.code).toBe('TENANT_ACCESS_DENIED');
    }, 180_000);
  });

  // ==========================================================================
  describe('protection des routes', () => {
    it('refuse toute requete sans jeton', async () => {
      await request(api.server).get(url('/orders')).expect(401);
      await request(api.server).get(url('/customers')).expect(401);
      await request(api.server).get(url('/dashboard/overview')).expect(401);
    });

    it('laisse les plans tarifaires publics', async () => {
      const response = await request(api.server).get(url('/plans')).expect(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('expose les sondes de sante sans prefixe de version', async () => {
      await request(api.server).get('/health/live').expect(200);
      await request(api.server).get('/health/ready').expect(200);
    });
  });
});
