/**
 * Tests d'integration des comptes transporteur — le CRUD qui manquait.
 *
 * CE QUE CES TESTS PROTEGENT
 *   Toute la chaine d'expedition lisait `credentialsEncrypted` — creation de
 *   colis, sondage de suivi, webhooks — et RIEN ne l'ecrivait. La colonne
 *   existait, chiffree, lue par quatre chemins, et restait vide : aucune
 *   boutique reelle ne pouvait expedier. Le premier test ci-dessous verifie
 *   donc la chose la plus simple et la plus longtemps absente — qu'un compte
 *   cree par le formulaire permet reellement d'expedier.
 *
 * TROIS PIEGES, UN TEST CHACUN
 *   1. Un secret laisse vide a la modification n'est pas un secret efface.
 *   2. Un controle de sante ne doit pas RESSUSCITER un compte desactive.
 *   3. Un transporteur PREVU ne doit pas accepter de compte (D-066) : ses
 *      capacites sont declarees, pas verifiees, et rien ne repondrait.
 */

import type { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '@ecomflow/shared';
import { ShipmentsService } from '../../src/modules/shipments/shipments.service';
import { ShipmentsModule } from '../../src/modules/shipments/shipments.module';
import { OrderWorkflowService } from '../../src/modules/orders/workflow/order-workflow.service';
import { EncryptionService } from '../../src/infra/crypto/encryption.service';
import { RequestContextStore } from '../../src/infra/context/request-context';
import {
  createCustomer,
  createOrder,
  createProduct,
  createTenant,
  type TestTenant,
} from '../support/factories';
import { closePrisma, rawPrisma, resetDatabase } from '../support/prisma';
import { buildTestModule, type TestContext } from '../support/test-module';

const ALL_TENANT_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

describe('comptes transporteur', () => {
  let prisma: PrismaClient;
  let context: TestContext;
  let shipments: ShipmentsService;
  let workflow: OrderWorkflowService;
  let encryption: EncryptionService;

  beforeAll(async () => {
    prisma = rawPrisma();
    context = await buildTestModule({ imports: [ShipmentsModule] });
    shipments = context.get(ShipmentsService);
    workflow = context.get(OrderWorkflowService);
    encryption = context.get(EncryptionService);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
    await closePrisma();
  });

  // --------------------------------------------------------------------------

  async function carrierId(code: string): Promise<string> {
    const carrier = await prisma.carrier.findUniqueOrThrow({
      where: { code },
      select: { id: true },
    });
    return carrier.id;
  }

  async function create(
    tenant: TestTenant,
    overrides: Partial<Parameters<ShipmentsService['createCarrierAccount']>[1]> = {},
  ) {
    return RequestContextStore.runWithTenant(tenant.tenantId, async () =>
      shipments.createCarrierAccount(tenant.tenantId, {
        carrierId: await carrierId('MOCK_CARRIER'),
        label: 'Compte principal',
        credentials: { apiKey: 'secret-de-test' },
        ...overrides,
      }),
    );
  }

  async function accounts(tenantId: string) {
    return RequestContextStore.runWithTenant(tenantId, () =>
      shipments.listCarrierAccounts(tenantId),
    );
  }

  // ==========================================================================
  describe('creation', () => {
    it('rend le compte reellement utilisable pour expedier', async () => {
      // LE TEST QUI COMPTE. Avant ce formulaire, aucune ligne de code ne
      // remplissait `credentialsEncrypted` : une boutique reelle ne pouvait pas
      // expedier, quel que soit le soin mis au reste du produit.
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 5 });
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

      const account = await create(tenant);
      expect(account.status).toBe('CONNECTED');

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        workflow.transition({
          tenantId: tenant.tenantId,
          orderId: order.orderId,
          to: 'CONFIRMED',
          actorKind: 'USER',
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
          reason: null,
          source: 'test',
        }),
      );
      await prisma.order.update({
        where: { id: order.orderId },
        data: { carrierAccountId: account.id },
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
      expect(dispatch.archived).toBe(1);

      const parcel = await prisma.shipment.findFirstOrThrow({
        where: { orderId: order.orderId },
        select: { trackingNumber: true },
      });
      expect(parcel.trackingNumber).toBeTruthy();
    });

    it('chiffre les identifiants, et ne les ressort jamais', async () => {
      const tenant = await createTenant(prisma);
      const account = await create(tenant, { credentials: { apiKey: 'jeton-tres-secret' } });

      const row = await prisma.carrierAccount.findUniqueOrThrow({
        where: { id: account.id },
        select: { credentialsEncrypted: true },
      });

      // Le secret n'apparait nulle part en clair dans la colonne.
      expect(row.credentialsEncrypted).not.toBeNull();
      expect(row.credentialsEncrypted).not.toContain('jeton-tres-secret');
      expect(row.credentialsEncrypted!.startsWith('v1.')).toBe(true);

      // Il se relit correctement, lie au tenant par l'AAD.
      expect(
        encryption.decryptJson<Record<string, string>>(
          row.credentialsEncrypted!,
          tenant.tenantId,
        ),
      ).toEqual({ apiKey: 'jeton-tres-secret' });

      // Mais la liste ne rend que les CLES renseignees, jamais les valeurs.
      const listed = (await accounts(tenant.tenantId))[0];
      expect(listed?.credentialKeys).toEqual(['apiKey']);
      expect(JSON.stringify(listed)).not.toContain('jeton-tres-secret');
    });

    it('lie le chiffre au tenant : un blob copie ailleurs devient illisible', async () => {
      const tenant = await createTenant(prisma);
      const other = await createTenant(prisma);
      const account = await create(tenant);

      const row = await prisma.carrierAccount.findUniqueOrThrow({
        where: { id: account.id },
        select: { credentialsEncrypted: true },
      });

      expect(() =>
        encryption.decryptJson(row.credentialsEncrypted!, other.tenantId),
      ).toThrow();
    });

    it('fait du premier compte le compte par defaut, sans le demander', async () => {
      const tenant = await createTenant(prisma);
      const first = await create(tenant, { label: 'Premier' });

      expect(
        (
          await prisma.carrierAccount.findUniqueOrThrow({
            where: { id: first.id },
            select: { isDefault: true },
          })
        ).isDefault,
      ).toBe(true);
    });

    it('ne laisse jamais deux comptes par defaut', async () => {
      // `resolveCarrierAccount` prend le premier `isDefault` venu quand aucun
      // compte n'est precise : deux defauts rendraient le transporteur choisi
      // dependant de l'ordre des lignes.
      const tenant = await createTenant(prisma);
      await create(tenant, { label: 'Premier' });
      await create(tenant, { label: 'Second', isDefault: true });

      const defaults = await prisma.carrierAccount.count({
        where: { tenantId: tenant.tenantId, isDefault: true },
      });
      expect(defaults).toBe(1);

      const second = await prisma.carrierAccount.findFirstOrThrow({
        where: { tenantId: tenant.tenantId, label: 'Second' },
        select: { isDefault: true },
      });
      expect(second.isDefault).toBe(true);
    });

    it('refuse deux comptes de meme nom chez le meme transporteur', async () => {
      const tenant = await createTenant(prisma);
      await create(tenant, { label: 'Agence Alger' });
      await expect(create(tenant, { label: 'Agence Alger' })).rejects.toThrow(/existe deja/i);
    });

    it('refuse un identifiant requis manquant, en le nommant', async () => {
      const tenant = await createTenant(prisma);
      const yalidine = await carrierId('YALIDINE');

      await expect(
        create(tenant, {
          carrierId: yalidine,
          credentials: { apiId: 'A-1' }, // apiToken et fromWilayaName manquent
        }),
      ).rejects.toThrow(/API Token/);
    });

    it('refuse une cle inconnue plutot que de l ignorer', async () => {
      // Une faute de frappe sur `apiToken` produirait sinon un compte qui se
      // cree sans erreur, echoue a la premiere expedition, et dont rien
      // n'indique ce qui manque.
      const tenant = await createTenant(prisma);
      await expect(create(tenant, { credentials: { apiKeyy: 'x' } })).rejects.toThrow(
        /inconnus/i,
      );
    });
  });

  // ==========================================================================
  describe('transporteurs sans connecteur (D-066) et non verifies (D-070)', () => {
    it('refuse la creation d un compte chez un transporteur PREVU', async () => {
      const tenant = await createTenant(prisma);
      const maystro = await carrierId('MAYSTRO');

      await expect(
        create(tenant, { carrierId: maystro, credentials: {} }),
      ).rejects.toThrow(/connecteur/i);

      expect(await prisma.carrierAccount.count({ where: { tenantId: tenant.tenantId } })).toBe(0);
    });

    it('les annonce non selectionnables AVANT la saisie', async () => {
      const connectors = await shipments.listCarrierConnectors();
      const byCode = new Map(connectors.map((entry) => [entry.code, entry]));

      expect(byCode.get('YALIDINE')?.selectable).toBe(true);
      expect(byCode.get('MAYSTRO')?.selectable).toBe(false);
      expect(byCode.get('COLIVRAISON')?.selectable).toBe(false);
      expect(byCode.get('ZR_EXPRESS_V3')?.selectable).toBe(false);

      // Un transporteur sans connecteur n'a aucun champ a proposer : le
      // formulaire n'a rien a dessiner, et ne le dessine pas.
      expect(byCode.get('MAYSTRO')?.credentialFields).toEqual([]);
    });

    /**
     * LE PIEGE CIRCULAIRE QUE D-070 REFERME
     *
     * Un adaptateur ecrit d'apres des sources tierces ne peut etre VERIFIE
     * qu'en tournant contre un compte marchand reel. Si « non verifie »
     * interdisait de brancher un compte, aucun transporteur ajoute apres
     * Yalidine ne pourrait jamais devenir disponible : l'etat serait definitif.
     *
     * C'est la meme impasse que D-068 avait trouvee sur `PENDING_SETUP`, et
     * elle se referme de la meme facon — l'etat « on ne sait pas encore » doit
     * etre traversable.
     */
    it('laisse brancher un compte chez un transporteur NON VERIFIE', async () => {
      const connectors = await shipments.listCarrierConnectors();
      const byCode = new Map(connectors.map((entry) => [entry.code, entry]));

      expect(byCode.get('ZR_EXPRESS')?.implementationStatus).toBe('UNVERIFIED');
      expect(byCode.get('ZR_EXPRESS')?.selectable).toBe(true);
      expect(byCode.get('DHD')?.selectable).toBe(true);
      expect(byCode.get('GUEPEX')?.selectable).toBe(true);
    });

    it('demande son domaine a un revendeur, jamais a Yalidine', async () => {
      const connectors = await shipments.listCarrierConnectors();
      const field = (code: string) =>
        connectors
          .find((entry) => entry.code === code)
          ?.credentialFields.find((entry) => entry.key === 'baseUrl');

      // Guepex, Yalitec et We Can exposent la MEME API que Yalidine, chacun sur
      // un domaine qu'ils ne publient pas : il est demande plutot que devine.
      expect(field('GUEPEX')?.required).toBe(true);
      expect(field('YALIDINE')?.required).toBe(false);
      expect(field('DHD')?.required).toBe(false);
      expect(field('SPEEDMAIL')?.required).toBe(true);
    });

    it('dit POURQUOI le catalogue en sait si peu, transporteur par transporteur', async () => {
      const catalogue = await shipments.listCarrierCatalogue();
      const byCode = new Map(catalogue.map((entry) => [entry.code, entry]));

      // Verifie : rien a expliquer.
      expect(byCode.get('YALIDINE')?.sourceNote).toBeNull();
      // Un adaptateur existe, mais ecrit d'apres des tiers.
      expect(byCode.get('DHD')?.sourceNote).toBe('THIRD_PARTY_SOURCES');
      // Deux raisons DIFFERENTES d'etre PLANNED, et deux gestes suivants
      // differents : demander une documentation n'est pas reprendre un
      // adressage.
      expect(byCode.get('MAYSTRO')?.sourceNote).toBe('DOCUMENTATION_REQUESTED');
      expect(byCode.get('ZR_EXPRESS_V3')?.sourceNote).toBe('ADDRESSING_REWORK');
    });

    it('laisse SANS matrice le transporteur dont on ne sait rien', async () => {
      const catalogue = await shipments.listCarrierCatalogue();
      const colivraison = catalogue.find((entry) => entry.code === 'COLIVRAISON');

      // Dix-huit « false » affirmeraient dix-huit incapacites constatees. On
      // n'a rien constate : `null` dit « non renseignees », et l'ecran l'ecrit.
      expect(colivraison?.capabilities).toBeNull();
      expect(catalogue.find((entry) => entry.code === 'DHD')?.capabilities).not.toBeNull();
    });

    it('n ajoute pas au catalogue un transporteur sans aucune source', async () => {
      const catalogue = await shipments.listCarrierCatalogue();

      // « Nord & Ouest » n'apparait dans aucune fiche. Une ligne de catalogue
      // sans source serait une promesse sans rien derriere.
      expect(catalogue.map((entry) => entry.name)).not.toContain(
        expect.stringMatching(/nord.*ouest/i),
      );
    });

    it('genere les champs depuis le connecteur, pas depuis une liste ecrite a la main', async () => {
      const connectors = await shipments.listCarrierConnectors();
      const yalidine = connectors.find((entry) => entry.code === 'YALIDINE');

      expect(yalidine?.credentialFields.map((field) => field.key)).toEqual([
        'apiId',
        'apiToken',
        'fromWilayaName',
        'baseUrl',
      ]);
      // Le caractere secret vient du connecteur : c'est lui qui sait lequel de
      // ses champs ne doit jamais etre reaffiche.
      expect(yalidine?.credentialFields.find((f) => f.key === 'apiToken')?.secret).toBe(true);
      expect(yalidine?.credentialFields.find((f) => f.key === 'apiId')?.secret).toBe(false);
      // L'URL de base n'est pas un secret : elle se relit et se corrige.
      expect(yalidine?.credentialFields.find((f) => f.key === 'baseUrl')?.secret).toBe(false);
    });
  });

  // ==========================================================================
  describe('modification', () => {
    it('conserve un secret laisse vide', async () => {
      // L'ecran ne recoit jamais les secrets : il ne peut pas les renvoyer.
      // Traiter le vide comme un effacement deconnecterait la boutique au
      // premier reglage modifie.
      const tenant = await createTenant(prisma);
      const yalidine = await carrierId('YALIDINE');
      const account = await create(tenant, {
        carrierId: yalidine,
        credentials: { apiId: 'A-1', apiToken: 'secret-initial', fromWilayaName: 'Alger' },
      });

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.updateCarrierCredentials(tenant.tenantId, account.id, {
          apiId: 'A-1',
          apiToken: '',
          fromWilayaName: 'Oran',
        }),
      );

      const row = await prisma.carrierAccount.findUniqueOrThrow({
        where: { id: account.id },
        select: { credentialsEncrypted: true },
      });
      expect(
        encryption.decryptJson<Record<string, string>>(
          row.credentialsEncrypted!,
          tenant.tenantId,
        ),
      ).toEqual({ apiId: 'A-1', apiToken: 'secret-initial', fromWilayaName: 'Oran' });
    });

    it('renomme, change la nature et la detention du stock', async () => {
      const tenant = await createTenant(prisma);
      const account = await create(tenant);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.updateCarrierAccountSettings(tenant.tenantId, account.id, {
          label: 'Agence Oran',
          kind: 'DELIVERY_AGENT',
          stockHeldByCourier: true,
        }),
      );

      expect(
        await prisma.carrierAccount.findUniqueOrThrow({
          where: { id: account.id },
          select: { label: true, kind: true, stockHeldByCourier: true },
        }),
      ).toMatchObject({
        label: 'Agence Oran',
        kind: 'DELIVERY_AGENT',
        stockHeldByCourier: true,
      });
    });

    it('refuse un nom vide', async () => {
      const tenant = await createTenant(prisma);
      const account = await create(tenant);

      await expect(
        RequestContextStore.runWithTenant(tenant.tenantId, () =>
          shipments.updateCarrierAccountSettings(tenant.tenantId, account.id, { label: '   ' }),
        ),
      ).rejects.toThrow(/vide/i);
    });
  });

  // ==========================================================================
  describe('actif / inactif : une intention, pas un diagnostic', () => {
    it('retire un compte desactive du chemin d expedition', async () => {
      const tenant = await createTenant(prisma);
      const account = await create(tenant);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.updateCarrierAccountSettings(tenant.tenantId, account.id, { enabled: false }),
      );

      expect(
        (
          await prisma.carrierAccount.findUniqueOrThrow({
            where: { id: account.id },
            select: { status: true },
          })
        ).status,
      ).toBe('DISABLED');
    });

    it('un controle de sante ne RESSUSCITE pas un compte desactive', async () => {
      // Le piege : `checkCarrierHealth` ecrivait `CONNECTED` sans condition. Un
      // compte volontairement mis de cote serait revenu en service tout seul, et
      // le Dispatcher l'aurait repropose sans que personne ne l'ait redemande.
      const tenant = await createTenant(prisma);
      const account = await create(tenant);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.updateCarrierAccountSettings(tenant.tenantId, account.id, { enabled: false }),
      );

      const health = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.checkCarrierHealth(tenant.tenantId, account.id),
      );
      expect(health.ok).toBe(true);

      const row = await prisma.carrierAccount.findUniqueOrThrow({
        where: { id: account.id },
        select: { status: true, lastHealthCheckOk: true, lastHealthCheckAt: true },
      });
      expect(row.status).toBe('DISABLED');
      // Le RESULTAT est bien enregistre : on sait que le compte repondrait.
      expect(row.lastHealthCheckOk).toBe(true);
      expect(row.lastHealthCheckAt).not.toBeNull();
    });

    it('cree un compte INACTIF sans que le controle le remette en service', async () => {
      // Le formulaire fusionne porte « Actif / Inactif » des la creation. Si le
      // controle de sante qui suit ecrasait ce choix, « inactif » coche a la
      // saisie serait devenu « connecte » deux secondes plus tard.
      const tenant = await createTenant(prisma);
      const account = await create(tenant, { enabled: false });

      expect(account.status).toBe('DISABLED');
      // Le compte a bien ete interroge : on sait qu'il repondrait.
      expect(account.health.ok).toBe(true);

      const row = await prisma.carrierAccount.findUniqueOrThrow({
        where: { id: account.id },
        select: { status: true, lastHealthCheckOk: true, isDefault: true },
      });
      expect(row.status).toBe('DISABLED');
      expect(row.lastHealthCheckOk).toBe(true);
      // Premier compte de la boutique : il reste le compte par defaut, meme
      // inactif. Le rendre actif est un geste, le designer par defaut en est
      // un autre — les confondre ferait disparaitre le defaut a la premiere
      // mise en sommeil.
      expect(row.isDefault).toBe(true);
    });

    it('reactive vers « configuration en cours », pas vers un diagnostic perime', async () => {
      const tenant = await createTenant(prisma);
      const account = await create(tenant);

      await RequestContextStore.runWithTenant(tenant.tenantId, async () => {
        await shipments.updateCarrierAccountSettings(tenant.tenantId, account.id, {
          enabled: false,
        });
        await shipments.updateCarrierAccountSettings(tenant.tenantId, account.id, {
          enabled: true,
        });
      });

      expect(
        (
          await prisma.carrierAccount.findUniqueOrThrow({
            where: { id: account.id },
            select: { status: true },
          })
        ).status,
      ).toBe('PENDING_SETUP');
    });
  });

  // ==========================================================================
  describe('suppression', () => {
    it('supprime un compte qui n a jamais servi', async () => {
      const tenant = await createTenant(prisma);
      const account = await create(tenant);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.deleteCarrierAccount(tenant.tenantId, account.id),
      );

      expect(await prisma.carrierAccount.count({ where: { id: account.id } })).toBe(0);
    });

    it('refuse un compte qui a porte un colis, et le DIT dans la liste', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 5 });
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
      const account = await create(tenant);

      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        workflow.transition({
          tenantId: tenant.tenantId,
          orderId: order.orderId,
          to: 'CONFIRMED',
          actorKind: 'USER',
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
          reason: null,
          source: 'test',
        }),
      );
      await prisma.order.update({
        where: { id: order.orderId },
        data: { carrierAccountId: account.id },
      });
      await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        shipments.dispatchOrders({
          tenantId: tenant.tenantId,
          orderIds: [order.orderId],
          membershipId: tenant.ownerMembershipId,
          permissions: ALL_TENANT_PERMISSIONS,
        }),
      );

      await expect(
        RequestContextStore.runWithTenant(tenant.tenantId, () =>
          shipments.deleteCarrierAccount(tenant.tenantId, account.id),
        ),
      ).rejects.toThrow(/tracabilite/i);

      // Et surtout : la liste l'annonce AVANT tout clic.
      const listed = (await accounts(tenant.tenantId)).find((row) => row.id === account.id);
      expect(listed?.deletable).toBe(false);
      expect(listed?.shipmentCount).toBe(1);
    });
  });

  // ==========================================================================
  describe('isolation', () => {
    it('ne laisse pas une boutique toucher au compte d une autre', async () => {
      const mine = await createTenant(prisma);
      const theirs = await createTenant(prisma);
      const account = await create(theirs);

      await expect(
        RequestContextStore.runWithTenant(mine.tenantId, () =>
          shipments.updateCarrierAccountSettings(mine.tenantId, account.id, { label: 'Vole' }),
        ),
      ).rejects.toThrow(/introuvable/i);

      expect(await accounts(mine.tenantId)).toEqual([]);
    });
  });
});
