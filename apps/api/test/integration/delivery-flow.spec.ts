/**
 * Tests d'integration du flux ENTRANT : ce que le transporteur nous apprend.
 *
 * Les autres tests du workflow poussent la commande vers l'avant, geste apres
 * geste. Ceux-ci font l'inverse : ils font parler le transporteur, et verifient
 * que ce qu'il dit atterrit au bon endroit.
 *
 * TROIS FAITS QUI NE DOIVENT JAMAIS SE RECOUVRIR
 *   Une tentative echouee, une livraison, un echec definitif sont trois
 *   evenements distincts. Le reflexe naturel — garder le dernier statut connu —
 *   effacerait les deux premiers, et avec eux la seule explication d'un delai
 *   ou d'un retour. Les tests ci-dessous verifient qu'ils COEXISTENT.
 *
 * ET UN QUATRIEME, QUI N'EST PAS UN STATUT
 *   « Livre » ne dit pas si l'argent est rentre. En paiement a la livraison,
 *   l'encaissement est un fait separe, souvent annonce des semaines plus tard.
 *   Il a ses propres colonnes, et surtout ses TROIS etats — encaisse, en
 *   attente, non publie par le transporteur — parce que confondre les deux
 *   derniers ferait lire une creance la ou il n'y a qu'une ignorance.
 *
 * Chaque test s'execute contre une vraie base, par le chemin reel
 * (`TrackingService.applyEvents`) — celui qu'empruntent aussi bien le webhook
 * que le releve periodique.
 */

import type { PrismaClient } from '@prisma/client';
import { PERMISSIONS, type OrderStatus } from '@ecomflow/shared';
import { OrderWorkflowService } from '../../src/modules/orders/workflow/order-workflow.service';
import { ShipmentsService } from '../../src/modules/shipments/shipments.service';
import { ShipmentsModule } from '../../src/modules/shipments/shipments.module';
import { TrackingService } from '../../src/modules/shipments/tracking.service';
import type { TrackingEvent } from '../../src/modules/shipments/carriers/carrier-adapter.interface';
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

const ALL_TENANT_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

describe('flux entrant : livraison, encaissement, retour', () => {
  let prisma: PrismaClient;
  let context: TestContext;
  let workflow: OrderWorkflowService;
  let shipments: ShipmentsService;
  let tracking: TrackingService;

  beforeAll(async () => {
    prisma = rawPrisma();
    context = await buildTestModule({ imports: [ShipmentsModule] });
    workflow = context.get(OrderWorkflowService);
    shipments = context.get(ShipmentsService);
    tracking = context.get(TrackingService);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
    await closePrisma();
  });

  // --------------------------------------------------------------------------
  // Fixtures
  // --------------------------------------------------------------------------

  /**
   * Amene une commande jusqu'a EXPEDIEE, colis reellement cree.
   *
   * Passe par `dispatchOrders` et non par des ecritures directes : le garde sur
   * `preparedQuantity` et celui sur l'existence d'un colis actif sont ainsi
   * reellement exerces, comme en production.
   */
  async function shipped(): Promise<{
    tenant: TestTenant;
    orderId: string;
    shipmentId: string;
    carrierId: string;
  }> {
    const tenant = await createTenant(prisma);
    const product = await createProduct(prisma, tenant.tenantId, { stock: 10 });
    const customer = await createCustomer(prisma, tenant.tenantId);
    const order = await createOrder(prisma, {
      tenantId: tenant.tenantId,
      customerId: customer.customerId,
      addressId: customer.addressId,
      variantId: product.variantId,
      sku: product.sku,
      status: 'TO_CONFIRM',
      quantity: 1,
    });
    const carrier = await createCarrierAccount(prisma, tenant.tenantId);

    await move(tenant, order.orderId, 'CONFIRMED');
    await prisma.order.update({
      where: { id: order.orderId },
      data: { carrierAccountId: carrier.carrierAccountId },
    });

    const dispatch = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
      shipments.dispatchOrders({
        tenantId: tenant.tenantId,
        orderIds: [order.orderId],
        membershipId: tenant.ownerMembershipId,
        permissions: ALL_TENANT_PERMISSIONS,
      }),
    );
    expect(dispatch.skipped).toEqual([]);

    const parcel = await prisma.shipment.findFirstOrThrow({
      where: { orderId: order.orderId },
      select: { id: true, carrierId: true },
    });

    return {
      tenant,
      orderId: order.orderId,
      shipmentId: parcel.id,
      carrierId: parcel.carrierId,
    };
  }

  async function move(tenant: TestTenant, orderId: string, to: OrderStatus) {
    return RequestContextStore.runWithTenant(tenant.tenantId, () =>
      workflow.transition({
        tenantId: tenant.tenantId,
        orderId,
        to,
        actorKind: 'USER',
        membershipId: tenant.ownerMembershipId,
        permissions: ALL_TENANT_PERMISSIONS,
        reason: null,
        source: 'test',
      }),
    );
  }

  /** Injecte des evenements transporteur par le chemin REEL d'application. */
  async function feed(
    tenantId: string,
    shipmentId: string,
    events: readonly (Omit<TrackingEvent, 'fingerprint'> & { fingerprint?: string })[],
  ) {
    return RequestContextStore.runWithTenant(tenantId, () =>
      tracking.applyEvents(
        tenantId,
        shipmentId,
        events.map((event) => ({
          ...event,
          fingerprint:
            event.fingerprint ?? `${event.providerStatus}-${event.occurredAt.toISOString()}`,
        })),
        'test',
      ),
    );
  }

  async function statusOf(orderId: string): Promise<string> {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    return order.status;
  }

  async function queue(tenantId: string, stage: 'IN_DELIVERY' | 'DELIVERED', orderId: string) {
    const page = await RequestContextStore.runWithTenant(tenantId, () =>
      shipments.listDeliveryQueue(tenantId, { stage }),
    );
    return page.data.find((item) => item.id === orderId);
  }

  // ==========================================================================
  describe('avancement de la commande', () => {
    it('fait passer la commande en livraison puis livree', async () => {
      const { tenant, orderId, shipmentId } = await shipped();

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'en cours de livraison',
          normalizedStatus: 'OUT_FOR_DELIVERY',
          occurredAt: new Date('2026-09-01T09:00:00Z'),
        },
      ]);
      expect(await statusOf(orderId)).toBe('IN_DELIVERY');

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-01T14:00:00Z'),
        },
      ]);
      expect(await statusOf(orderId)).toBe('DELIVERED');
    });

    it('n avance pas la commande sur une simple tentative echouee', async () => {
      // Une tentative n'est pas un statut de commande : le colis est toujours
      // en cours de livraison. Ce qu'elle change, c'est le COMPTEUR.
      const { tenant, orderId, shipmentId } = await shipped();

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'client absent',
          normalizedStatus: 'FAILED_ATTEMPT',
          occurredAt: new Date('2026-09-01T09:00:00Z'),
        },
      ]);

      expect(await statusOf(orderId)).toBe('SHIPPED');
    });
  });

  // ==========================================================================
  describe('les tentatives sont des faits distincts', () => {
    it('conserve CHAQUE tentative, meme apres une livraison reussie', async () => {
      // L'exigence centrale. Trois echecs avant d'aboutir doivent rester
      // lisibles : ils expliquent le delai, et ils comptent pour la fiabilite
      // du client. Ne garder que le dernier evenement les effacerait tous.
      const { tenant, orderId, shipmentId } = await shipped();

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'tentative 1 : client absent',
          normalizedStatus: 'FAILED_ATTEMPT',
          occurredAt: new Date('2026-09-01T09:00:00Z'),
        },
        {
          providerStatus: 'tentative 2 : numero injoignable',
          normalizedStatus: 'FAILED_ATTEMPT',
          occurredAt: new Date('2026-09-02T09:00:00Z'),
        },
        {
          providerStatus: 'tentative 3 : reporte par le client',
          normalizedStatus: 'FAILED_ATTEMPT',
          occurredAt: new Date('2026-09-03T09:00:00Z'),
        },
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-04T11:00:00Z'),
        },
      ]);

      expect(await statusOf(orderId)).toBe('DELIVERED');

      const entry = await queue(tenant.tenantId, 'DELIVERED', orderId);
      expect(entry?.failedAttempts).toBe(3);
      expect(entry?.lastAttemptAt).toEqual(new Date('2026-09-03T09:00:00Z'));
    });

    it('ne compte pas deux fois une tentative rejouee', async () => {
      // Webhook et releve periodique rapportent souvent le meme evenement. Le
      // compteur doit rester juste quel que soit le nombre de passages.
      const { tenant, orderId, shipmentId } = await shipped();
      const attempt = {
        providerStatus: 'client absent',
        normalizedStatus: 'FAILED_ATTEMPT' as const,
        occurredAt: new Date('2026-09-01T09:00:00Z'),
      };

      await feed(tenant.tenantId, shipmentId, [attempt]);
      const replay = await feed(tenant.tenantId, shipmentId, [attempt]);

      expect(replay.duplicateEvents).toBe(1);
      expect(replay.newEvents).toBe(0);

      const page = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.listDeliveryQueue(tenant.tenantId, { stage: 'IN_DELIVERY' }),
      );
      expect(page.data.find((item) => item.id === orderId)).toBeUndefined();

      const events = await prisma.shipmentEvent.count({
        where: { shipmentId, normalizedStatus: 'FAILED_ATTEMPT' },
      });
      expect(events).toBe(1);
    });
  });

  // ==========================================================================
  describe('encaissement : trois etats, jamais deux', () => {
    it('lit « en attente » quand le transporteur publie mais n a pas reverse', async () => {
      const { tenant, orderId, shipmentId } = await shipped();
      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-01T14:00:00Z'),
        },
      ]);

      // Le transporteur de test PUBLIE les bons : rien encaisse = creance.
      expect((await queue(tenant.tenantId, 'DELIVERED', orderId))?.collection.kind).toBe('PENDING');
    });

    it('enregistre le montant, la date et la reference du bon', async () => {
      const { tenant, orderId, shipmentId } = await shipped();

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-01T14:00:00Z'),
        },
      ]);
      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'versement effectue',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-20T10:00:00Z'),
          collection: {
            amountCentimes: 450_000,
            collectedAt: new Date('2026-09-20T10:00:00Z'),
            reference: 'BON-2026-0042',
          },
        },
      ]);

      const entry = await queue(tenant.tenantId, 'DELIVERED', orderId);
      expect(entry?.collection).toMatchObject({
        kind: 'COLLECTED',
        amountCentimes: 450_000,
        reference: 'BON-2026-0042',
      });
    });

    it('n efface pas un montant deja connu avec un evenement plus recent sans montant', async () => {
      // Le piege : le reversement est souvent annonce AVANT une mise a jour de
      // statut sans rapport. Prendre le montant du DERNIER evenement remettrait
      // la somme a zero alors qu'elle est bien rentree.
      const { tenant, orderId, shipmentId } = await shipped();

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'versement effectue',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-20T10:00:00Z'),
          collection: {
            amountCentimes: 450_000,
            collectedAt: new Date('2026-09-20T10:00:00Z'),
            reference: 'BON-2026-0042',
          },
        },
        {
          providerStatus: 'dossier clos',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-21T08:00:00Z'),
        },
      ]);

      expect((await queue(tenant.tenantId, 'DELIVERED', orderId))?.collection).toMatchObject({
        kind: 'COLLECTED',
        amountCentimes: 450_000,
      });
    });

    it('annonce « non publie » quand le transporteur ne fournit pas la donnee', async () => {
      // Le cas de Yalidine — le seul connecteur reellement implemente. Il ne
      // publie pas les bons d'encaissement, et l'ecran doit le DIRE plutot que
      // de laisser un vide que l'exploitant lira comme un impaye.
      const { tenant, orderId, shipmentId, carrierId } = await shipped();
      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-01T14:00:00Z'),
        },
      ]);

      // La matrice est un REFERENTIEL preserve entre les tests : on la remet
      // dans son etat d'origine, sous peine de contaminer les suivants.
      await prisma.carrierCapability.update({
        where: { carrierId },
        data: { realtimeCollectionVouchers: false },
      });
      try {
        expect((await queue(tenant.tenantId, 'DELIVERED', orderId))?.collection.kind).toBe(
          'UNSUPPORTED',
        );
      } finally {
        await prisma.carrierCapability.update({
          where: { carrierId },
          data: { realtimeCollectionVouchers: true },
        });
      }
    });

    it('lit « non publie » pour un transporteur sans ligne de matrice du tout', async () => {
      // Cas degenere mais reel : un transporteur ajoute au catalogue sans que
      // sa matrice ait ete renseignee. L'absence d'information ne doit pas se
      // lire comme une promesse non tenue.
      const { tenant, orderId, shipmentId, carrierId } = await shipped();
      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-01T14:00:00Z'),
        },
      ]);

      const saved = await prisma.carrierCapability.findUniqueOrThrow({ where: { carrierId } });
      await prisma.carrierCapability.delete({ where: { carrierId } });
      try {
        expect((await queue(tenant.tenantId, 'DELIVERED', orderId))?.collection.kind).toBe(
          'UNSUPPORTED',
        );
      } finally {
        await prisma.carrierCapability.create({ data: saved });
      }
    });
  });

  // ==========================================================================
  describe('retour : la marchandise revient, quelqu un doit en decider', () => {
    it('cree un RETOUR quand le transporteur rend le colis', async () => {
      // Le trou constate : la commande passait bien en RETOURNEE, mais l'ecran
      // /retours restait vide. La marchandise revenait sans que personne n'ait
      // a decider de son sort.
      const { tenant, orderId, shipmentId } = await shipped();

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'retourne a l expediteur',
          normalizedStatus: 'RETURNED',
          occurredAt: new Date('2026-09-05T10:00:00Z'),
        },
      ]);

      expect(await statusOf(orderId)).toBe('RETURNED');

      const created = await prisma.return.findFirst({
        where: { orderId },
        select: { reason: true, reasonDetail: true, shipmentId: true, status: true },
      });
      expect(created).not.toBeNull();
      // `OTHER` et non un motif invente : le transporteur signale QU'IL rend le
      // colis, rarement POURQUOI. Son libelle brut est conserve pour qu'un
      // humain affine au controle.
      expect(created?.reason).toBe('OTHER');
      expect(created?.reasonDetail).toContain('retourne a l expediteur');
      expect(created?.shipmentId).toBe(shipmentId);
    });

    it('ne cree pas un second retour si l evenement est rejoue', async () => {
      const { tenant, orderId, shipmentId } = await shipped();
      const event = {
        providerStatus: 'retourne a l expediteur',
        normalizedStatus: 'RETURNED' as const,
        occurredAt: new Date('2026-09-05T10:00:00Z'),
      };

      await feed(tenant.tenantId, shipmentId, [event]);
      await feed(tenant.tenantId, shipmentId, [event]);

      expect(await prisma.return.count({ where: { orderId } })).toBe(1);
    });

    it('conserve les tentatives qui ont precede le retour', async () => {
      // C'est le dossier du retour : trois passages infructueux, puis le renvoi.
      // Sans eux, le retour arrive sans explication.
      const { tenant, orderId, shipmentId } = await shipped();

      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'tentative 1 : client absent',
          normalizedStatus: 'FAILED_ATTEMPT',
          occurredAt: new Date('2026-09-01T09:00:00Z'),
        },
        {
          providerStatus: 'tentative 2 : client absent',
          normalizedStatus: 'FAILED_ATTEMPT',
          occurredAt: new Date('2026-09-02T09:00:00Z'),
        },
        {
          providerStatus: 'retourne a l expediteur',
          normalizedStatus: 'RETURNED',
          occurredAt: new Date('2026-09-05T10:00:00Z'),
        },
      ]);

      const attempts = await prisma.shipmentEvent.count({
        where: { shipmentId, normalizedStatus: 'FAILED_ATTEMPT' },
      });
      expect(attempts).toBe(2);
      expect(await prisma.return.count({ where: { orderId } })).toBe(1);
    });
  });

  // ==========================================================================
  describe('la file de livraison', () => {
    it('separe les deux etapes', async () => {
      const inTransit = await shipped();
      const done = await shipped();

      await feed(inTransit.tenant.tenantId, inTransit.shipmentId, [
        {
          providerStatus: 'en cours de livraison',
          normalizedStatus: 'OUT_FOR_DELIVERY',
          occurredAt: new Date('2026-09-01T09:00:00Z'),
        },
      ]);
      await feed(done.tenant.tenantId, done.shipmentId, [
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-01T14:00:00Z'),
        },
      ]);

      const enCours = await RequestContextStore.runWithTenant(inTransit.tenant.tenantId, () =>
        shipments.listDeliveryQueue(inTransit.tenant.tenantId, { stage: 'IN_DELIVERY' }),
      );
      expect(enCours.data.map((item) => item.id)).toEqual([inTransit.orderId]);

      const livrees = await RequestContextStore.runWithTenant(done.tenant.tenantId, () =>
        shipments.listDeliveryQueue(done.tenant.tenantId, { stage: 'DELIVERED' }),
      );
      expect(livrees.data.map((item) => item.id)).toEqual([done.orderId]);
    });

    it('ne montre a une boutique que ses propres commandes', async () => {
      const mine = await shipped();
      const theirs = await shipped();

      for (const scenario of [mine, theirs]) {
        await feed(scenario.tenant.tenantId, scenario.shipmentId, [
          {
            providerStatus: 'livre au client',
            normalizedStatus: 'DELIVERED',
            occurredAt: new Date('2026-09-01T14:00:00Z'),
          },
        ]);
      }

      const page = await RequestContextStore.runWithTenant(mine.tenant.tenantId, () =>
        shipments.listDeliveryQueue(mine.tenant.tenantId, { stage: 'DELIVERED' }),
      );
      expect(page.data.map((item) => item.id)).toEqual([mine.orderId]);
    });

    it('filtre par transporteur et par recherche libre', async () => {
      const { tenant, orderId, shipmentId } = await shipped();
      await feed(tenant.tenantId, shipmentId, [
        {
          providerStatus: 'livre au client',
          normalizedStatus: 'DELIVERED',
          occurredAt: new Date('2026-09-01T14:00:00Z'),
        },
      ]);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { reference: true, carrierAccountId: true },
      });

      const byCarrier = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.listDeliveryQueue(tenant.tenantId, {
          stage: 'DELIVERED',
          carrierAccountId: order.carrierAccountId ?? '',
        }),
      );
      expect(byCarrier.data.map((item) => item.id)).toEqual([orderId]);

      const byReference = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.listDeliveryQueue(tenant.tenantId, {
          stage: 'DELIVERED',
          search: order.reference,
        }),
      );
      expect(byReference.data.map((item) => item.id)).toEqual([orderId]);

      const nothing = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.listDeliveryQueue(tenant.tenantId, {
          stage: 'DELIVERED',
          search: 'introuvable-xyz',
        }),
      );
      expect(nothing.data).toEqual([]);
    });
  });
});
