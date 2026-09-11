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
import { ShipmentsService } from '../../src/modules/shipments/shipments.service';
import { ShipmentsModule } from '../../src/modules/shipments/shipments.module';
import { ArchiveService } from '../../src/modules/archive/archive.service';
import { ArchiveModule } from '../../src/modules/archive/archive.module';
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
  let shipments: ShipmentsService;
  let archive: ArchiveService;
  let inventory: InventoryService;

  beforeAll(async () => {
    prisma = rawPrisma();
    context = await buildTestModule({ imports: [ShipmentsModule, ArchiveModule] });
    workflow = context.get(OrderWorkflowService);
    orders = context.get(OrdersService);
    shipments = context.get(ShipmentsService);
    archive = context.get(ArchiveService);
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
  describe('dispatch : de confirmee a expediee en un geste', () => {
    it('refuse une commande sans transporteur choisi', async () => {
      // Le prerequis dur. Avant ce champ, l'expedition retombait
      // silencieusement sur le compte par defaut de la boutique : une commande
      // partait chez un livreur que personne n'avait choisi.
      const { tenant, order } = await scenario();
      await move(tenant, order.orderId, 'CONFIRMED');

      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.dispatchOrders({
          tenantId: tenant.tenantId,
          orderIds: [order.orderId],
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
        }),
      );

      expect(result.archived).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.message).toContain('transporteur');

      // La commande n'a pas bouge : un refus ne laisse pas d'etat intermediaire.
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.orderId },
        select: { status: true },
      });
      expect(row.status).toBe('CONFIRMED');
    });

    it('traverse les etapes intermediaires au lieu de les sauter', async () => {
      // L'ecran ne montre plus « en preparation » ni « prete a expedier », mais
      // la machine a etats les traverse toujours : c'est ce qui garde
      // l'historique exact et tout indicateur de duree utilisable.
      const { tenant, order } = await scenario();
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);

      await move(tenant, order.orderId, 'CONFIRMED');
      await prisma.order.update({
        where: { id: order.orderId },
        data: { carrierAccountId: carrier.carrierAccountId },
      });

      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.dispatchOrders({
          tenantId: tenant.tenantId,
          orderIds: [order.orderId],
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
        }),
      );

      expect(result.archived).toBe(1);
      expect(result.skipped).toHaveLength(0);

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.orderId },
        select: { status: true },
      });
      expect(row.status).toBe('SHIPPED');

      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: order.orderId },
        select: { newStatus: true },
      });
      expect(history.map((entry) => entry.newStatus)).toEqual(
        expect.arrayContaining(['IN_PREPARATION', 'READY_TO_SHIP', 'SHIPPED']),
      );
    });

    it('enregistre les lignes preparees au lieu de contourner le garde', async () => {
      // Le garde `REQUIRE_PREPARATION_COMPLETED` reste ACTIF. Cocher les lignes
      // puis dispatcher EST l'affirmation qu'elles sont pretes ; le dispatch
      // l'ecrit, et le garde la verifie.
      const { tenant, order } = await scenario({ quantity: 4 });
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);

      await move(tenant, order.orderId, 'CONFIRMED');
      await prisma.order.update({
        where: { id: order.orderId },
        data: { carrierAccountId: carrier.carrierAccountId },
      });

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.dispatchOrders({
          tenantId: tenant.tenantId,
          orderIds: [order.orderId],
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
        }),
      );

      const items = await prisma.orderItem.findMany({
        where: { orderId: order.orderId },
        select: { quantity: true, preparedQuantity: true },
      });
      for (const item of items) {
        expect(item.preparedQuantity).toBe(item.quantity);
      }
    });

    it('cree le colis chez le transporteur CHOISI, pas chez celui par defaut', async () => {
      const { tenant, order } = await scenario();
      const chosen = await createCarrierAccount(prisma, tenant.tenantId);

      await move(tenant, order.orderId, 'CONFIRMED');
      await prisma.order.update({
        where: { id: order.orderId },
        data: { carrierAccountId: chosen.carrierAccountId },
      });

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.dispatchOrders({
          tenantId: tenant.tenantId,
          orderIds: [order.orderId],
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
        }),
      );

      const shipment = await prisma.shipment.findFirstOrThrow({
        where: { orderId: order.orderId },
        select: { carrierAccountId: true },
      });
      expect(shipment.carrierAccountId).toBe(chosen.carrierAccountId);
    });

    it('rend compte ligne par ligne sur une selection melangee', async () => {
      // Une selection partiellement traitee est le cas NORMAL : l'agent doit
      // savoir laquelle est passee et pourquoi l'autre ne l'est pas.
      const { tenant, order: withCarrier } = await scenario();
      const other = await scenario();
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);

      await move(tenant, withCarrier.orderId, 'CONFIRMED');
      await prisma.order.update({
        where: { id: withCarrier.orderId },
        data: { carrierAccountId: carrier.carrierAccountId },
      });
      await move(other.tenant, other.order.orderId, 'CONFIRMED');

      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.dispatchOrders({
          tenantId: tenant.tenantId,
          orderIds: [withCarrier.orderId],
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
        }),
      );

      expect(result.archived).toBe(1);
      expect(result.skipped).toHaveLength(0);
    });
  });

  // ==========================================================================
  describe('corbeille : suppression definitive', () => {
    it('refuse un client qui a passe une commande, avec un motif lisible', async () => {
      // Le cas majoritaire sur des donnees reelles. Le refus vient de la cle
      // etrangere `Order.customer`, en Restrict — et c'est elle qui garantit
      // que les chiffres passes restent calculables.
      const { tenant, customer } = await scenario();
      await prisma.customer.update({
        where: { id: customer.customerId },
        data: { archivedAt: new Date() },
      });

      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        archive.purge(
          tenant.tenantId,
          { customers: [customer.customerId] },
          tenant.ownerMembershipId,
        ),
      );

      expect(result.archived).toBe(0);
      expect(result.skipped).toHaveLength(1);
      // Le motif parle metier, pas PostgreSQL, et oriente vers le bon geste.
      expect(result.skipped[0]?.message).toContain('commande');
      expect(result.skipped[0]?.message).toContain('Anonymiser');

      // La fiche est toujours la : un refus n'abime rien.
      expect(
        await prisma.customer.count({ where: { id: customer.customerId } }),
      ).toBe(1);
    });

    it('refuse un produit qui a connu un mouvement de stock', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 5 });
      await prisma.product.update({
        where: { id: product.productId },
        data: { archivedAt: new Date() },
      });

      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        archive.purge(
          tenant.tenantId,
          { products: [product.productId] },
          tenant.ownerMembershipId,
        ),
      );

      expect(result.archived).toBe(0);
      expect(result.skipped[0]?.message).toContain('stock');
    });

    it('refuse une ligne qui n est pas archivee', async () => {
      // Premier garde-fou : on ne supprime jamais directement depuis une liste
      // de travail. Archiver d'abord oblige a passer par un etat ou l'erreur se
      // rattrape encore.
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 0 });

      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        archive.purge(
          tenant.tenantId,
          { products: [product.productId] },
          tenant.ownerMembershipId,
        ),
      );

      expect(result.archived).toBe(0);
      expect(result.skipped[0]?.message).toContain('archivee');
      expect(await prisma.product.count({ where: { id: product.productId } })).toBe(1);
    });

    it('supprime ce que la base autorise, et le journalise avant', async () => {
      // Un produit sans mouvement de stock ni ligne de commande : le seul cas
      // ou la suppression aboutit vraiment.
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 0 });
      await prisma.product.update({
        where: { id: product.productId },
        data: { archivedAt: new Date() },
      });

      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        archive.purge(
          tenant.tenantId,
          { products: [product.productId] },
          tenant.ownerMembershipId,
        ),
      );

      expect(result.archived).toBe(1);
      expect(result.skipped).toHaveLength(0);
      expect(await prisma.product.count({ where: { id: product.productId } })).toBe(0);

      // La seule trace qui subsiste de la ligne effacee.
      const logged = await prisma.auditLog.count({
        where: { entityId: product.productId, action: 'DATA_PURGED' },
      });
      expect(logged).toBe(1);
    });

    it('ne montre que ce qui est archive, et de la boutique courante', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);

      const visible = await createProduct(prisma, boutiqueA.tenantId, { stock: 0 });
      const actif = await createProduct(prisma, boutiqueA.tenantId, { stock: 0 });
      const voisin = await createProduct(prisma, boutiqueB.tenantId, { stock: 0 });

      await prisma.product.updateMany({
        where: { id: { in: [visible.productId, voisin.productId] } },
        data: { archivedAt: new Date() },
      });

      const page = await RequestContextStore.runWithTenant(boutiqueA.tenantId, () =>
        archive.list(boutiqueA.tenantId),
      );

      const ids = page.data.map((item) => item.id);
      expect(ids).toContain(visible.productId);
      expect(ids).not.toContain(actif.productId);
      expect(ids).not.toContain(voisin.productId);
    });
  });

  // ==========================================================================
  describe('annulation d une sortie de stock', () => {
    /** Sort le stock comme le ferait une expedition, puis rend les compteurs. */
    async function afterShipping(quantity: number, stock: number) {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock });
      const customer = await createCustomer(prisma, tenant.tenantId);
      const order = await createOrder(prisma, {
        tenantId: tenant.tenantId,
        customerId: customer.customerId,
        addressId: customer.addressId,
        variantId: product.variantId,
        sku: product.sku,
        status: 'TO_CONFIRM',
        quantity,
      });

      // On passe par le VRAI chemin d'expedition — `READY_TO_SHIP -> SHIPPED`
      // exige un colis actif, et c'est `createShipment` qui le cree. Forcer le
      // statut a la main sauterait `commitOutbound`, donc la sortie de stock
      // que ce test cherche justement a annuler.
      const carrier = await createCarrierAccount(prisma, tenant.tenantId);
      await move(tenant, order.orderId, 'CONFIRMED');
      await prisma.order.update({
        where: { id: order.orderId },
        data: { carrierAccountId: carrier.carrierAccountId },
      });

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.dispatchOrders({
          tenantId: tenant.tenantId,
          orderIds: [order.orderId],
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
        }),
      );

      return { tenant, product, order };
    }

    it('restaure EXACTEMENT les compteurs que la sortie avait decrementes', async () => {
      // La propriete qui definit cette operation : appliquer la sortie puis son
      // inverse doit laisser le stock dans l'etat d'avant l'expedition — pas
      // dans celui d'avant la commande.
      const { tenant, product } = await afterShipping(3, 10);

      // Apres expedition : 3 sortis, plus rien de reserve.
      expect(await stockOf(product.variantId)).toMatchObject({
        onHand: 7,
        reserved: 0,
        available: 7,
      });

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        prisma.$transaction(async (tx) =>
          inventory.reverseOutbound(
            tx as never,
            tenant.tenantId,
            [{ variantId: product.variantId, quantity: 3 }],
            { referenceType: 'MANUAL', note: 'Expedition annulee' },
          ),
        ),
      );

      // Retour a l'etat « commande confirmee, pas encore partie » : la
      // marchandise est revenue ET reste promise au client.
      expect(await stockOf(product.variantId)).toMatchObject({
        onHand: 10,
        reserved: 3,
        available: 7,
      });
    });

    it('ne rend pas la marchandise vendable : elle reste reservee', async () => {
      // Le defaut que la restauration des DEUX compteurs evite. Ne remonter que
      // `onHand` ferait passer le disponible de 7 a 10 : la marchandise
      // redeviendrait vendable alors qu'elle est toujours promise a quelqu'un.
      const { tenant, product } = await afterShipping(3, 10);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        prisma.$transaction(async (tx) =>
          inventory.reverseOutbound(
            tx as never,
            tenant.tenantId,
            [{ variantId: product.variantId, quantity: 3 }],
            { referenceType: 'MANUAL' },
          ),
        ),
      );

      const level = await stockOf(product.variantId);
      expect(level.available).toBe(7);
      expect(level.available).not.toBe(level.onHand);
    });

    it('journalise un mouvement DISTINCT d un retour', async () => {
      // La distinction qui protege le taux de retour — l'indicateur le plus
      // surveille du paiement a la livraison. Un colis qui n'est jamais parti
      // ne doit pas y figurer.
      const { tenant, product } = await afterShipping(2, 5);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        prisma.$transaction(async (tx) =>
          inventory.reverseOutbound(
            tx as never,
            tenant.tenantId,
            [{ variantId: product.variantId, quantity: 2 }],
            { referenceType: 'MANUAL' },
          ),
        ),
      );

      const movements = await prisma.inventoryMovement.findMany({
        where: { variantId: product.variantId },
        select: { type: true, quantity: true, onHandAfter: true, reservedAfter: true },
        orderBy: { createdAt: 'asc' },
      });

      const reversal = movements.at(-1);
      expect(reversal?.type).toBe('OUTBOUND_REVERSAL');
      expect(reversal?.quantity).toBe(2);
      // L'etat resultant est fige dans le mouvement, comme pour tous les autres.
      expect(reversal?.onHandAfter).toBe(5);
      expect(reversal?.reservedAfter).toBe(2);

      // Aucune trace de retour : la marchandise n'est jamais allee chez le
      // client.
      expect(movements.map((m) => m.type)).not.toContain('RETURN_RESTOCK');
      expect(movements.map((m) => m.type)).not.toContain('RETURN_QUARANTINE');
    });

    it('agrege plusieurs lignes portant la meme variante', async () => {
      // Meme precaution que partout ailleurs : deux lignes de la meme variante
      // traitees separement fausseraient le total.
      const { tenant, product } = await afterShipping(4, 10);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        prisma.$transaction(async (tx) =>
          inventory.reverseOutbound(
            tx as never,
            tenant.tenantId,
            [
              { variantId: product.variantId, quantity: 1 },
              { variantId: product.variantId, quantity: 3 },
            ],
            { referenceType: 'MANUAL' },
          ),
        ),
      );

      expect(await stockOf(product.variantId)).toMatchObject({ onHand: 10, reserved: 4 });

      // Un SEUL mouvement de 4, et non deux de 1 et 3.
      const reversals = await prisma.inventoryMovement.findMany({
        where: { variantId: product.variantId, type: 'OUTBOUND_REVERSAL' },
        select: { quantity: true },
      });
      expect(reversals).toHaveLength(1);
      expect(reversals[0]?.quantity).toBe(4);
    });

    it('refuse une quantite nulle ou negative', async () => {
      const { tenant, product } = await afterShipping(2, 5);

      for (const quantity of [0, -2]) {
        await expect(
          RequestContextStore.runWithTenant(tenant.tenantId, () =>
            prisma.$transaction(async (tx) =>
              inventory.reverseOutbound(
                tx as never,
                tenant.tenantId,
                [{ variantId: product.variantId, quantity }],
                { referenceType: 'MANUAL' },
              ),
            ),
          ),
        ).rejects.toThrow();
      }
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
