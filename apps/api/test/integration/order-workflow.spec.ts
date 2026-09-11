/**
 * Tests d'integration du moteur de workflow des commandes.
 *
 * Couvre les criteres d'acceptation V2 §37 :
 *   - « un agent peut confirmer, rappeler, reporter ou annuler selon ses
 *      permissions » ;
 *   - « une commande confirmee peut suivre tout le workflow prevu » ;
 *   - « le stock respecte les mouvements et regles definis » ;
 *   - « les evenements critiques sont historises ».
 *
 * Chaque test s'execute contre une vraie base : les mouvements de stock, les
 * contraintes SQL et les transactions sont donc reellement exerces.
 */

import type { PrismaClient } from '@prisma/client';
import { PERMISSIONS, type OrderStatus } from '@ecomflow/shared';
import { OrderWorkflowService } from '../../src/modules/orders/workflow/order-workflow.service';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { RequestContextStore } from '../../src/infra/context/request-context';
import {
  createCarrierAccount,
  createCustomer,
  createOrder,
  createProduct,
  createTenant,
  type TestTenant,
} from '../support/factories';
import { closePrisma, rawPrisma, resetDatabase } from '../support/prisma';
import { buildTestModule, type TestContext } from '../support/test-module';

/** Permissions d'un OWNER : tout ce qui est attribuable a une boutique. */
const ALL_TENANT_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

describe('workflow des commandes', () => {
  let prisma: PrismaClient;
  let context: TestContext;
  let workflow: OrderWorkflowService;
  let orders: OrdersService;
  let inventory: InventoryService;

  beforeAll(async () => {
    prisma = rawPrisma();
    context = await buildTestModule();
    workflow = context.get(OrderWorkflowService);
    orders = context.get(OrdersService);
    inventory = context.get(InventoryService);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
    await closePrisma();
  });

  // --------------------------------------------------------------------------
  // Fixture : une boutique avec un produit en stock, un client et une commande
  // --------------------------------------------------------------------------
  async function scenario(options: { stock?: number; quantity?: number } = {}) {
    const tenant = await createTenant(prisma);
    const product = await createProduct(prisma, tenant.tenantId, { stock: options.stock ?? 10 });
    const customer = await createCustomer(prisma, tenant.tenantId);
    const order = await createOrder(prisma, {
      tenantId: tenant.tenantId,
      customerId: customer.customerId,
      addressId: customer.addressId,
      variantId: product.variantId,
      sku: product.sku,
      status: 'TO_CONFIRM',
      quantity: options.quantity ?? 1,
    });
    return { tenant, product, customer, order };
  }

  /** Raccourci : execute une transition en tant qu'OWNER. */
  async function move(
    tenant: TestTenant,
    orderId: string,
    to: OrderStatus,
    overrides: { reason?: string; actorKind?: 'USER' | 'SYSTEM' } = {},
  ) {
    return RequestContextStore.runWithTenant(tenant.tenantId, () =>
      workflow.transition({
        tenantId: tenant.tenantId,
        orderId,
        to,
        actorKind: overrides.actorKind ?? 'USER',
        membershipId: tenant.ownerMembershipId,
        permissions: ALL_TENANT_PERMISSIONS,
        reason: overrides.reason ?? null,
        source: 'test',
      }),
    );
  }

  async function stockOf(variantId: string) {
    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId },
      select: { onHand: true, reserved: true, quarantine: true },
    });
    return { ...level, available: level.onHand - level.reserved };
  }

  // ==========================================================================
  describe('parcours nominal complet', () => {
    it('mene une commande de A CONFIRMER jusqu a LIVREE', async () => {
      const { tenant, product, order } = await scenario({ stock: 10 });
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);

      // --- Confirmation : le stock est reserve, pas encore sorti ------------
      await move(tenant, order.orderId, 'CONFIRMED');
      expect(await stockOf(product.variantId)).toMatchObject({
        onHand: 10,
        reserved: 1,
        available: 9,
      });

      // --- Preparation ------------------------------------------------------
      await move(tenant, order.orderId, 'IN_PREPARATION');
      await prisma.orderItem.updateMany({
        where: { orderId: order.orderId },
        data: { preparedQuantity: 1 },
      });
      await move(tenant, order.orderId, 'READY_TO_SHIP');

      // --- Expedition : necessite un colis actif ---------------------------
      await prisma.shipment.create({
        data: {
          tenantId: tenant.tenantId,
          orderId: order.orderId,
          carrierId: carrier.carrierId,
          carrierAccountId: carrier.carrierAccountId,
          idempotencyKey: `ship-${order.orderId}`,
          status: 'CREATED',
          trackingNumber: 'TRK-NOMINAL',
        },
      });
      await move(tenant, order.orderId, 'SHIPPED');

      // La marchandise a physiquement quitte l'entrepot.
      expect(await stockOf(product.variantId)).toMatchObject({
        onHand: 9,
        reserved: 0,
        available: 9,
      });

      // --- Livraison --------------------------------------------------------
      await move(tenant, order.orderId, 'IN_DELIVERY');
      const result = await move(tenant, order.orderId, 'DELIVERED');

      expect(result.to).toBe('DELIVERED');

      const final = await prisma.order.findUniqueOrThrow({
        where: { id: order.orderId },
        select: {
          status: true,
          confirmedAt: true,
          preparedAt: true,
          shippedAt: true,
          deliveredAt: true,
        },
      });

      expect(final.status).toBe('DELIVERED');
      // Chaque date metier a bien ete horodatee (V1 §7).
      expect(final.confirmedAt).not.toBeNull();
      expect(final.preparedAt).not.toBeNull();
      expect(final.shippedAt).not.toBeNull();
      expect(final.deliveredAt).not.toBeNull();
    });

    it('historise chaque transition avec son acteur et sa source', async () => {
      const { tenant, order } = await scenario();

      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');

      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: order.orderId },
        orderBy: { createdAt: 'asc' },
        select: { oldStatus: true, newStatus: true, actorKind: true, actorId: true, source: true },
      });

      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        oldStatus: 'TO_CONFIRM',
        newStatus: 'CONFIRMED',
        actorKind: 'USER',
        actorId: tenant.ownerMembershipId,
        source: 'test',
      });
      expect(history[1]).toMatchObject({
        oldStatus: 'CONFIRMED',
        newStatus: 'IN_PREPARATION',
      });
    });

    it('publie un evenement par transition, dans la meme transaction', async () => {
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');

      const events = await prisma.outboxEvent.findMany({
        where: { tenantId: tenant.tenantId, eventType: 'order.status_changed' },
        select: { payload: true, status: true },
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe('PENDING');
      expect(events[0]?.payload).toMatchObject({
        orderId: order.orderId,
        from: 'TO_CONFIRM',
        to: 'CONFIRMED',
      });
    });
  });

  // ==========================================================================
  describe('transitions refusees', () => {
    it('refuse une transition absente de la machine a etats', async () => {
      const { tenant, order } = await scenario();

      await expect(move(tenant, order.orderId, 'DELIVERED')).rejects.toMatchObject({
        response: { code: 'ORDER_INVALID_TRANSITION' },
      });

      const unchanged = await prisma.order.findUniqueOrThrow({
        where: { id: order.orderId },
        select: { status: true },
      });
      expect(unchanged.status).toBe('TO_CONFIRM');
    });

    it('refuse une transition sans la permission requise', async () => {
      const { tenant, order } = await scenario();

      await expect(
        RequestContextStore.runWithTenant(tenant.tenantId, () =>
          workflow.transition({
            tenantId: tenant.tenantId,
            orderId: order.orderId,
            to: 'CONFIRMED',
            actorKind: 'USER',
            membershipId: tenant.ownerMembershipId,
            // Un preparateur ne possede pas `confirmation.manage`.
            permissions: new Set([PERMISSIONS.PREPARATION_MANAGE]),
            source: 'test',
          }),
        ),
      ).rejects.toMatchObject({ response: { code: 'PERMISSION_DENIED' } });
    });

    it('exige un motif pour une annulation', async () => {
      const { tenant, order } = await scenario();

      await expect(move(tenant, order.orderId, 'CANCELLED')).rejects.toMatchObject({
        response: { code: 'ORDER_REASON_REQUIRED' },
      });

      await expect(
        move(tenant, order.orderId, 'CANCELLED', { reason: 'Client injoignable' }),
      ).resolves.toMatchObject({ to: 'CANCELLED' });
    });

    it('interdit au systeme de preparer a la place d un humain', async () => {
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');

      await expect(
        move(tenant, order.orderId, 'IN_PREPARATION', { actorKind: 'SYSTEM' }),
      ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    });

    it('refuse de changer le statut d une commande archivee', async () => {
      const { tenant, order } = await scenario();
      await prisma.order.update({
        where: { id: order.orderId },
        data: { archivedAt: new Date() },
      });

      await expect(move(tenant, order.orderId, 'CONFIRMED')).rejects.toMatchObject({
        response: { code: 'ORDER_ARCHIVED' },
      });
    });
  });

  // ==========================================================================
  describe('gardes metier', () => {
    it('refuse la confirmation quand le stock est insuffisant', async () => {
      const { tenant, product, order } = await scenario({ stock: 0, quantity: 2 });

      await expect(move(tenant, order.orderId, 'CONFIRMED')).rejects.toMatchObject({
        response: {
          code: 'ORDER_TRANSITION_GUARD_FAILED',
          details: { guard: 'REQUIRE_STOCK_AVAILABLE' },
        },
      });

      // Aucun effet de bord : le stock n'a pas bouge.
      expect(await stockOf(product.variantId)).toMatchObject({ onHand: 0, reserved: 0 });
    });

    it('detaille precisement ce qui manque en stock', async () => {
      const { tenant, product, order } = await scenario({ stock: 1, quantity: 5 });

      await expect(move(tenant, order.orderId, 'CONFIRMED')).rejects.toMatchObject({
        response: {
          details: {
            shortages: [{ sku: product.sku, requested: 5, available: 1 }],
          },
        },
      });
    });

    it('autorise la survente si la boutique l a explicitement activee', async () => {
      const { tenant, order } = await scenario({ stock: 0, quantity: 3 });
      await prisma.tenantSettings.update({
        where: { tenantId: tenant.tenantId },
        data: { allowOversell: true },
      });

      await expect(move(tenant, order.orderId, 'CONFIRMED')).resolves.toMatchObject({
        to: 'CONFIRMED',
      });
    });

    it('refuse de marquer prete a expedier une preparation incomplete', async () => {
      const { tenant, order } = await scenario({ quantity: 3 });
      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');

      await prisma.orderItem.updateMany({
        where: { orderId: order.orderId },
        data: { preparedQuantity: 2 },
      });

      await expect(move(tenant, order.orderId, 'READY_TO_SHIP')).rejects.toMatchObject({
        response: {
          code: 'ORDER_TRANSITION_GUARD_FAILED',
          details: { guard: 'REQUIRE_PREPARATION_COMPLETED' },
        },
      });
    });

    it('refuse d expedier sans colis actif', async () => {
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');
      await prisma.orderItem.updateMany({
        where: { orderId: order.orderId },
        data: { preparedQuantity: 1 },
      });
      await move(tenant, order.orderId, 'READY_TO_SHIP');

      await expect(move(tenant, order.orderId, 'SHIPPED')).rejects.toMatchObject({
        response: { details: { guard: 'REQUIRE_ACTIVE_SHIPMENT' } },
      });
    });

    it('refuse d annuler une commande dont le colis est encore actif', async () => {
      const { tenant, order } = await scenario();
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);

      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');
      await prisma.orderItem.updateMany({
        where: { orderId: order.orderId },
        data: { preparedQuantity: 1 },
      });
      await move(tenant, order.orderId, 'READY_TO_SHIP');

      await prisma.shipment.create({
        data: {
          tenantId: tenant.tenantId,
          orderId: order.orderId,
          carrierId: carrier.carrierId,
          carrierAccountId: carrier.carrierAccountId,
          idempotencyKey: 'ship-actif',
          status: 'CREATED',
          trackingNumber: 'TRK-ACTIF',
        },
      });

      await expect(
        move(tenant, order.orderId, 'CANCELLED', { reason: 'Erreur de saisie' }),
      ).rejects.toMatchObject({
        response: { details: { guard: 'REQUIRE_NO_ACTIVE_SHIPMENT' } },
      });
    });

    it('bloque la confirmation quand l abonnement est expire', async () => {
      const tenant = await createTenant(prisma, { subscription: 'expired' });
      const product = await createProduct(prisma, tenant.tenantId);
      const customer = await createCustomer(prisma, tenant.tenantId);
      const order = await createOrder(prisma, {
        tenantId: tenant.tenantId,
        customerId: customer.customerId,
        addressId: customer.addressId,
        variantId: product.variantId,
        sku: product.sku,
      });

      await expect(move(tenant, order.orderId, 'CONFIRMED')).rejects.toMatchObject({
        response: { code: 'SUBSCRIPTION_REQUIRED' },
      });
    });
  });

  // ==========================================================================
  describe('retour au centre de confirmation', () => {
    it('libere le stock reserve en repassant a TO_CONFIRM', async () => {
      // C'est la raison d'etre de cette transition. Sans liberation, la
      // marchandise resterait bloquee sur une commande qui n'est plus promise
      // a personne, et le defaut ne se verrait qu'au moment ou une AUTRE
      // commande serait refusee faute de stock.
      const { tenant, product, order } = await scenario({ stock: 5, quantity: 2 });

      await move(tenant, order.orderId, 'CONFIRMED');
      expect(await stockOf(product.variantId)).toMatchObject({ reserved: 2, available: 3 });

      await move(tenant, order.orderId, 'TO_CONFIRM', {
        reason: 'Le client veut changer de taille',
      });

      expect(await stockOf(product.variantId)).toMatchObject({ reserved: 0, available: 5 });
    });

    it('exige un motif', async () => {
      // Un retour en file sans motif oblige l'agent suivant a rappeler le
      // client pour decouvrir ce que le preparateur savait deja.
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');

      await expect(move(tenant, order.orderId, 'TO_CONFIRM')).rejects.toThrow();
    });

    it('n annule pas la commande', async () => {
      // La distinction est tout l'interet : une commande renvoyee en file n'est
      // pas une commande perdue, et ne doit peser ni sur les indicateurs
      // d'annulation ni sur le score de fiabilite du client.
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'TO_CONFIRM', { reason: 'Adresse a verifier' });

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.orderId },
        select: { status: true, cancelledAt: true },
      });

      expect(row.status).toBe('TO_CONFIRM');
      expect(row.cancelledAt).toBeNull();
    });

    it('laisse la commande a nouveau confirmable', async () => {
      const { tenant, product, order } = await scenario({ stock: 5, quantity: 2 });

      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'TO_CONFIRM', { reason: 'Rappeler demain' });
      await move(tenant, order.orderId, 'CONFIRMED');

      // Le stock est re-reserve : le cycle est complet, pas une impasse.
      expect(await stockOf(product.variantId)).toMatchObject({ reserved: 2, available: 3 });
    });
  });

  // ==========================================================================
  describe('enchainement « colis pret » depuis une commande confirmee', () => {
    it('refuse le saut direct de CONFIRMED a READY_TO_SHIP', async () => {
      // La garantie qui rend l'enchainement necessaire : si ce test tombe, le
      // lot pourrait se contenter d'un seul appel, et la colonne du milieu
      // perdrait son sens.
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');

      await expect(move(tenant, order.orderId, 'READY_TO_SHIP')).rejects.toThrow();
    });

    it('declare le colis pret en enregistrant les lignes preparees', async () => {
      // Le correctif : `markPreparationReady` fournit le geste qui manquait.
      // Il remplit `preparedQuantity`, puis franchit la garde — au lieu de la
      // contourner.
      const { tenant, order } = await scenario({ quantity: 3 });
      await move(tenant, order.orderId, 'CONFIRMED');

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        orders.markPreparationReady(
          tenant.tenantId,
          order.orderId,
          tenant.ownerMembershipId,
          ALL_TENANT_PERMISSIONS,
        ),
      );

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.orderId },
        select: { status: true },
      });
      expect(row.status).toBe('READY_TO_SHIP');

      // Les lignes portent la quantite reellement preparee, egale a la
      // quantite commandee : c'est ce que « colis pret » affirme.
      const items = await prisma.orderItem.findMany({
        where: { orderId: order.orderId },
        select: { quantity: true, preparedQuantity: true },
      });
      for (const item of items) {
        expect(item.preparedQuantity).toBe(item.quantity);
      }

      // Et l'etape intermediaire est bien tracee : le colis n'a pas saute
      // « en preparation ».
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: order.orderId },
        select: { newStatus: true },
      });
      expect(history.map((entry) => entry.newStatus)).toEqual(
        expect.arrayContaining(['IN_PREPARATION', 'READY_TO_SHIP']),
      );
    });

    it('refuse aussi le passage a READY_TO_SHIP sans lignes preparees', async () => {
      // La SECONDE garde, decouverte en ecrivant ces tests : la transition
      // exige `preparedQuantity` sur chaque ligne. Aucun code ne l'ecrivait,
      // ce qui rendait le bouton « Colis pret » systematiquement refuse — un
      // message decrivant une action que l'interface n'offrait pas.
      //
      // Ce test fige la garde : c'est le GESTE qui manquait, pas la regle.
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');

      await expect(move(tenant, order.orderId, 'READY_TO_SHIP')).rejects.toThrow();
    });
  });

  // ==========================================================================
  describe('effets sur le stock', () => {
    it('libere la reservation lors d une annulation apres confirmation', async () => {
      const { tenant, product, order } = await scenario({ stock: 10, quantity: 3 });

      await move(tenant, order.orderId, 'CONFIRMED');
      expect(await stockOf(product.variantId)).toMatchObject({ reserved: 3, available: 7 });

      await move(tenant, order.orderId, 'CANCELLED', { reason: 'Le client s est retracte' });
      expect(await stockOf(product.variantId)).toMatchObject({
        onHand: 10,
        reserved: 0,
        available: 10,
      });
    });

    it('ne reserve jamais deux fois la meme commande', async () => {
      const { tenant, product, order } = await scenario({ stock: 10, quantity: 2 });

      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');
      // Retour en arriere puis nouvelle avancee : la reservation ne doit pas
      // etre appliquee une seconde fois.
      await move(tenant, order.orderId, 'CONFIRMED', { reason: 'Correction de preparation' });
      await move(tenant, order.orderId, 'IN_PREPARATION');

      expect(await stockOf(product.variantId)).toMatchObject({ reserved: 2, available: 8 });
    });

    it('trace chaque mouvement avec l etat resultant', async () => {
      const { tenant, product, order } = await scenario({ stock: 10, quantity: 4 });
      await move(tenant, order.orderId, 'CONFIRMED');

      const movements = await prisma.inventoryMovement.findMany({
        where: { tenantId: tenant.tenantId, variantId: product.variantId },
        orderBy: { createdAt: 'asc' },
        select: {
          type: true,
          quantity: true,
          onHandAfter: true,
          reservedAfter: true,
          referenceType: true,
          referenceId: true,
        },
      });

      // Mouvement d'entree initial + reservation.
      expect(movements).toHaveLength(2);
      expect(movements[1]).toMatchObject({
        type: 'RESERVATION',
        quantity: 4,
        onHandAfter: 10,
        reservedAfter: 4,
        referenceType: 'ORDER',
        referenceId: order.orderId,
      });
    });

    it('agrege les quantites quand deux lignes portent la meme variante', async () => {
      const { tenant, product, order } = await scenario({ stock: 5, quantity: 3 });

      // Seconde ligne sur la meme variante : 3 + 3 = 6 > 5 disponibles.
      await prisma.orderItem.create({
        data: {
          tenantId: tenant.tenantId,
          orderId: order.orderId,
          variantId: product.variantId,
          productNameSnapshot: 'Produit Test',
          skuSnapshot: product.sku,
          quantity: 3,
          unitPriceCentimes: 450_000,
          lineTotalCentimes: 1_350_000,
        },
      });

      await expect(move(tenant, order.orderId, 'CONFIRMED')).rejects.toMatchObject({
        response: { details: { guard: 'REQUIRE_STOCK_AVAILABLE' } },
      });
    });

    it('n applique aucun mouvement quand la transition echoue', async () => {
      const { tenant, product, order } = await scenario({ stock: 2, quantity: 5 });

      await expect(move(tenant, order.orderId, 'CONFIRMED')).rejects.toThrow();

      const movements = await prisma.inventoryMovement.count({
        where: { tenantId: tenant.tenantId, variantId: product.variantId, type: 'RESERVATION' },
      });
      expect(movements).toBe(0);
    });
  });

  // ==========================================================================
  describe('compteurs client', () => {
    it('met a jour les compteurs et le score a la livraison', async () => {
      const { tenant, order, customer } = await scenario();
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);

      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');
      await prisma.orderItem.updateMany({
        where: { orderId: order.orderId },
        data: { preparedQuantity: 1 },
      });
      await move(tenant, order.orderId, 'READY_TO_SHIP');
      await prisma.shipment.create({
        data: {
          tenantId: tenant.tenantId,
          orderId: order.orderId,
          carrierId: carrier.carrierId,
          carrierAccountId: carrier.carrierAccountId,
          idempotencyKey: 'ship-stats',
          status: 'CREATED',
          trackingNumber: 'TRK-STATS',
        },
      });
      await move(tenant, order.orderId, 'SHIPPED');
      await move(tenant, order.orderId, 'DELIVERED');

      const updated = await prisma.customer.findUniqueOrThrow({
        where: { id: customer.customerId },
        select: { deliveredCount: true, consecutiveFailures: true, reliabilityUpdatedAt: true },
      });

      expect(updated.deliveredCount).toBe(1);
      expect(updated.consecutiveFailures).toBe(0);
      expect(updated.reliabilityUpdatedAt).not.toBeNull();
    });

    it('incremente les echecs consecutifs sur une annulation', async () => {
      const { tenant, order, customer } = await scenario();

      await move(tenant, order.orderId, 'CANCELLED', { reason: 'Refus du client' });

      const updated = await prisma.customer.findUniqueOrThrow({
        where: { id: customer.customerId },
        select: { cancelledCount: true, consecutiveFailures: true },
      });

      expect(updated.cancelledCount).toBe(1);
      expect(updated.consecutiveFailures).toBe(1);
    });
  });

  // ==========================================================================
  describe('isolation multi-tenant du workflow', () => {
    it('refuse d agir sur la commande d une autre boutique', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const produitB = await createProduct(prisma, boutiqueB.tenantId);
      const clientB = await createCustomer(prisma, boutiqueB.tenantId);
      const commandeB = await createOrder(prisma, {
        tenantId: boutiqueB.tenantId,
        customerId: clientB.customerId,
        addressId: clientB.addressId,
        variantId: produitB.variantId,
        sku: produitB.sku,
      });

      // La boutique A tente d'agir sur une commande de B en fournissant son
      // propre tenantId : la commande devient simplement introuvable.
      await expect(
        move(boutiqueA, commandeB.orderId, 'CONFIRMED'),
      ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_FOUND' } });

      const unchanged = await prisma.order.findUniqueOrThrow({
        where: { id: commandeB.orderId },
        select: { status: true },
      });
      expect(unchanged.status).toBe('TO_CONFIRM');
    });
  });

  // ==========================================================================
  describe('transitions disponibles', () => {
    it('ne propose que les actions permises par le role', async () => {
      const { tenant, order } = await scenario();

      const available = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        workflow.listAvailableTransitions(
          tenant.tenantId,
          order.orderId,
          new Set([PERMISSIONS.CONFIRMATION_MANAGE]),
        ),
      );

      const targets = available.map((entry) => entry.to);
      expect(targets).toEqual(
        expect.arrayContaining(['CONFIRMED', 'NO_ANSWER', 'CALL_BACK', 'POSTPONED', 'CANCELLED']),
      );
      // `orders.change_status` n'est pas accorde : aucune action ne doit
      // l'exiger dans cette liste.
      expect(available.every((entry) => entry.permission === 'confirmation.manage')).toBe(true);
    });

    it('signale les actions exigeant un motif', async () => {
      const { tenant, order } = await scenario();

      const available = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        workflow.listAvailableTransitions(tenant.tenantId, order.orderId, ALL_TENANT_PERMISSIONS),
      );

      const cancel = available.find((entry) => entry.to === 'CANCELLED');
      expect(cancel?.requiresReason).toBe(true);

      const confirm = available.find((entry) => entry.to === 'CONFIRMED');
      expect(confirm?.requiresReason).toBe(false);
    });
  });

  // ==========================================================================
  describe('reconciliation du stock', () => {
    it('ne signale aucun ecart apres un parcours nominal', async () => {
      const { tenant, order } = await scenario({ stock: 10, quantity: 2 });
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);

      await move(tenant, order.orderId, 'CONFIRMED');
      await move(tenant, order.orderId, 'IN_PREPARATION');
      await prisma.orderItem.updateMany({
        where: { orderId: order.orderId },
        data: { preparedQuantity: 2 },
      });
      await move(tenant, order.orderId, 'READY_TO_SHIP');
      await prisma.shipment.create({
        data: {
          tenantId: tenant.tenantId,
          orderId: order.orderId,
          carrierId: carrier.carrierId,
          carrierAccountId: carrier.carrierAccountId,
          idempotencyKey: 'ship-recon',
          status: 'CREATED',
          trackingNumber: 'TRK-RECON',
        },
      });
      await move(tenant, order.orderId, 'SHIPPED');

      const discrepancies = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        inventory.findDiscrepancies(tenant.tenantId),
      );

      expect(discrepancies).toEqual([]);
    });
  });
});
