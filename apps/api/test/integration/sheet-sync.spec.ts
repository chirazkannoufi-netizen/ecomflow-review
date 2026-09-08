/**
 * Tests d'integration de la synchronisation Google Sheets.
 *
 * Couvre les criteres d'acceptation les plus structurants du cahier des charges :
 *   - « une nouvelle ligne Google Sheets valide cree UNE SEULE commande » ;
 *   - « une resynchronisation ne cree aucun doublon » ;
 *   - « les erreurs d'import sont visibles avec la ligne et une explication » ;
 *   - « HTTP 429 declenche une reprise automatique, aucune commande perdue »
 *     (Addendum §39).
 *
 * L'API Google est remplacee par un double controlable : on teste NOTRE logique
 * de synchronisation, pas la disponibilite du service de Google. Tout le reste
 * — base, transactions, contraintes, workflow — est reel.
 */

import type { PrismaClient } from '@prisma/client';
import { GoogleOAuthService } from '../../src/modules/integrations/google/google-oauth.service';
import {
  GoogleQuotaExceededError,
  GoogleSheetsApiError,
  GoogleSheetsClient,
  type SheetRange,
} from '../../src/modules/integrations/google/google-sheets.client';
import { SheetSyncService } from '../../src/modules/integrations/google/sheet-sync.service';
import { IntegrationsModule } from '../../src/modules/integrations/integrations.module';
import { RequestContextStore } from '../../src/infra/context/request-context';
import { createProduct, createTenant, type TestTenant } from '../support/factories';
import { closePrisma, rawPrisma, resetDatabase } from '../support/prisma';
import { buildTestModule, type TestContext } from '../support/test-module';

/**
 * Double de l'API Google Sheets.
 *
 * Il expose exactement la surface utilisee par `SheetSyncService` et permet de
 * declencher a volonte un quota depasse ou une panne, ce qui serait impossible
 * contre le vrai service.
 */
class FakeSheetsClient {
  /** Lignes retournees a la prochaine lecture. */
  rows: string[][] = [];
  /** Erreur a lever a la prochaine lecture, puis remise a zero. */
  nextError: Error | null = null;
  /** Nombre de lectures effectuees, pour verifier l'economie de quota. */
  readCount = 0;

  getValues(): Promise<SheetRange> {
    this.readCount += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return Promise.reject(error);
    }
    return Promise.resolve({ range: 'A2:Z100', values: this.rows });
  }

  getSpreadsheet(): Promise<never> {
    throw new Error('Non utilise par ces tests.');
  }

  listSpreadsheets(): Promise<never> {
    throw new Error('Non utilise par ces tests.');
  }

  updateCell(): Promise<void> {
    return Promise.resolve();
  }
}

/** Double du service OAuth : renvoie un jeton constant. */
class FakeOAuthService {
  getAccessToken(): Promise<string> {
    return Promise.resolve('jeton-de-test');
  }
  isConfigured(): boolean {
    return true;
  }
}

/** Mapping du format de reference de la V2 (annexe §40). */
const REFERENCE_MAPPING = {
  date: 0,
  customerName: 1,
  phone: 2,
  wilaya: 3,
  commune: 4,
  address: 5,
  productName: 6,
  sku: 7,
  quantity: 8,
  unitPrice: 9,
  deliveryFee: 10,
  total: 11,
  sourceStatus: 12,
};

describe('synchronisation Google Sheets', () => {
  let prisma: PrismaClient;
  let context: TestContext;
  let sync: SheetSyncService;
  let sheets: FakeSheetsClient;

  beforeAll(async () => {
    prisma = rawPrisma();
    sheets = new FakeSheetsClient();

    context = await buildTestModule({
      imports: [IntegrationsModule],
      overrides: [
        [GoogleSheetsClient, sheets],
        [GoogleOAuthService, new FakeOAuthService()],
      ],
    });

    sync = context.get(SheetSyncService);
  });

  beforeEach(async () => {
    await resetDatabase();
    sheets.rows = [];
    sheets.nextError = null;
    sheets.readCount = 0;
  });

  afterAll(async () => {
    await context.close();
    await closePrisma();
  });

  // --------------------------------------------------------------------------

  async function setupSheet(tenant: TestTenant, sku: string) {
    const integration = await prisma.integration.create({
      data: {
        tenantId: tenant.tenantId,
        type: 'ORDER_SOURCE',
        provider: 'GOOGLE_SHEETS',
        status: 'CONNECTED',
        accountLabel: 'test@boutique.dz',
        connectedAt: new Date(),
      },
      select: { id: true },
    });

    const config = await prisma.sheetSyncConfig.create({
      data: {
        tenantId: tenant.tenantId,
        integrationId: integration.id,
        spreadsheetId: 'classeur-test',
        sheetName: 'Commandes',
        sheetGid: '0',
        headerRow: 1,
        firstDataRow: 2,
        columnMapping: REFERENCE_MAPPING,
        isActive: true,
      },
      select: { id: true },
    });

    return { configId: config.id, integrationId: integration.id, sku };
  }

  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    return [
      overrides.date ?? '29/08/2026',
      overrides.name ?? 'Sara Benali',
      overrides.phone ?? '0555123456',
      overrides.wilaya ?? 'Alger',
      overrides.commune ?? 'Bab Ezzouar',
      overrides.address ?? 'Cite 1200 Logements',
      overrides.product ?? 'Robe longue',
      overrides.sku ?? 'SKU-TEST',
      overrides.quantity ?? '1',
      overrides.price ?? '4500',
      overrides.delivery ?? '500',
      overrides.total ?? '5000',
      overrides.status ?? 'NEW',
    ];
  }

  async function runSync(tenant: TestTenant, configId: string, dryRun = false) {
    return RequestContextStore.runWithTenant(tenant.tenantId, () =>
      sync.sync(tenant.tenantId, configId, 'MANUAL', { dryRun }),
    );
  }

  // ==========================================================================
  describe('import nominal', () => {
    it('cree une commande a partir d une ligne valide', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 50 });
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku })];

      const result = await runSync(tenant, configId);

      expect(result.status).toBe('SUCCESS');
      expect(result.rowsImported).toBe(1);
      expect(result.rowsFailed).toBe(0);

      const orders = await prisma.order.findMany({
        where: { tenantId: tenant.tenantId },
        include: { items: true },
      });

      expect(orders).toHaveLength(1);
      const order = orders[0];
      expect(order?.source).toBe('GOOGLE_SHEETS');
      // La commande entre directement dans la file de confirmation.
      expect(order?.status).toBe('TO_CONFIRM');
      expect(order?.customerNameSnapshot).toBe('Sara Benali');
      // Le numero a bien ete normalise en E.164.
      expect(order?.phoneSnapshot).toBe('+213555123456');
      expect(order?.wilayaCodeSnapshot).toBe(16);
      expect(order?.itemsTotalCentimes).toBe(450_000);
      expect(order?.deliveryFeeCentimes).toBe(50_000);
      expect(order?.totalCentimes).toBe(500_000);
      expect(order?.reference).toMatch(/^ORD-\d{4}-\d{6}$/);
      expect(order?.items).toHaveLength(1);
    });

    it('cree le client et son adresse au passage', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku })];
      await runSync(tenant, configId);

      const customer = await prisma.customer.findFirst({
        where: { tenantId: tenant.tenantId },
        include: { addresses: true },
      });

      expect(customer?.phoneE164).toBe('+213555123456');
      expect(customer?.ordersCount).toBe(1);
      expect(customer?.addresses).toHaveLength(1);
      expect(customer?.addresses[0]?.wilayaCode).toBe(16);
      expect(customer?.addresses[0]?.isDefault).toBe(true);
    });

    it('importe plusieurs lignes en une execution', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 100 });
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [
        row({ sku: product.sku, phone: '0555111111', name: 'Client A' }),
        row({ sku: product.sku, phone: '0555222222', name: 'Client B' }),
        row({ sku: product.sku, phone: '0555333333', name: 'Client C' }),
      ];

      const result = await runSync(tenant, configId);

      expect(result.rowsImported).toBe(3);
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(3);
    });

    it('ignore les lignes entierement vides', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku }), ['', '', '', '', ''], []];

      const result = await runSync(tenant, configId);

      expect(result.rowsScanned).toBe(1);
      expect(result.rowsImported).toBe(1);
    });
  });

  // ==========================================================================
  describe('idempotence', () => {
    it('ne recree aucune commande lors d une resynchronisation', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 100 });
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [
        row({ sku: product.sku, phone: '0555111111' }),
        row({ sku: product.sku, phone: '0555222222' }),
      ];

      const first = await runSync(tenant, configId);
      expect(first.rowsImported).toBe(2);

      // Le curseur ayant avance, une seconde execution ne relit rien.
      // On le remet a zero pour simuler une relecture complete de la feuille,
      // qui est le cas le plus severe.
      await prisma.sheetSyncConfig.update({
        where: { id: configId },
        data: { lastProcessedRow: 0 },
      });

      const second = await runSync(tenant, configId);

      expect(second.rowsImported).toBe(0);
      expect(second.rowsSkipped).toBe(2);
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(2);
    });

    it('resiste a dix resynchronisations consecutives', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 100 });
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku })];

      for (let i = 0; i < 10; i += 1) {
        await prisma.sheetSyncConfig.update({
          where: { id: configId },
          data: { lastProcessedRow: 0 },
        });
        await runSync(tenant, configId);
      }

      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(1);
    });

    it('n est pas trompee par l insertion d une ligne au milieu de la feuille', async () => {
      // Piege classique : utiliser le numero de ligne comme cle d'idempotence.
      // Inserer une ligne decalerait toutes les suivantes et recreerait des
      // commandes deja importees.
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 100 });
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [
        row({ sku: product.sku, phone: '0555111111', name: 'Client A' }),
        row({ sku: product.sku, phone: '0555222222', name: 'Client B' }),
      ];
      await runSync(tenant, configId);

      // Une nouvelle ligne est inseree EN TETE : les deux precedentes
      // descendent d'un cran.
      sheets.rows = [
        row({ sku: product.sku, phone: '0555999999', name: 'Client Z' }),
        row({ sku: product.sku, phone: '0555111111', name: 'Client A' }),
        row({ sku: product.sku, phone: '0555222222', name: 'Client B' }),
      ];
      await prisma.sheetSyncConfig.update({
        where: { id: configId },
        data: { lastProcessedRow: 0 },
      });

      const result = await runSync(tenant, configId);

      // Seule la nouvelle ligne est importee.
      expect(result.rowsImported).toBe(1);
      expect(result.rowsSkipped).toBe(2);
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(3);
    });

    it('trace chaque ligne source avec son empreinte', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku })];
      await runSync(tenant, configId);

      const imports = await prisma.sheetRowImport.findMany({
        where: { tenantId: tenant.tenantId },
        select: { fingerprint: true, status: true, orderId: true, sourceRowNumber: true },
      });

      expect(imports).toHaveLength(1);
      expect(imports[0]?.status).toBe('IMPORTED');
      expect(imports[0]?.orderId).not.toBeNull();
      expect(imports[0]?.fingerprint).toHaveLength(40);
      expect(imports[0]?.sourceRowNumber).toBe(2);
    });
  });

  // ==========================================================================
  describe('journal des erreurs', () => {
    it('rejette une ligne au telephone invalide, avec la raison', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku, phone: 'a confirmer' })];

      const result = await runSync(tenant, configId);

      expect(result.rowsFailed).toBe(1);
      expect(result.status).toBe('FAILED');
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(0);

      const failure = await prisma.sheetRowImport.findFirstOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      expect(failure.status).toBe('FAILED');
      expect(failure.errorCode).toBe('INVALID_PHONE');
      expect(failure.errorMessage).toContain('a confirmer');
      expect(failure.sourceRowNumber).toBe(2);
      // Les valeurs brutes sont conservees pour permettre un rejeu.
      expect(failure.rawValues).not.toBeNull();
    });

    it('rejette une wilaya inconnue sans deviner', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku, wilaya: 'Casablanca' })];

      await runSync(tenant, configId);

      const failure = await prisma.sheetRowImport.findFirstOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      expect(failure.errorCode).toBe('UNKNOWN_WILAYA');
    });

    it('rejette un SKU absent du catalogue', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: 'SKU-INEXISTANT' })];

      const result = await runSync(tenant, configId);

      expect(result.rowsFailed).toBe(1);
      const failure = await prisma.sheetRowImport.findFirstOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      expect(failure.errorMessage).toContain('SKU-INEXISTANT');
    });

    it('importe les lignes valides malgre la presence de lignes en erreur', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 50 });
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [
        row({ sku: product.sku, phone: '0555111111' }),
        row({ sku: product.sku, phone: 'invalide' }),
        row({ sku: product.sku, phone: '0555333333' }),
      ];

      const result = await runSync(tenant, configId);

      // Une ligne fautive ne doit jamais bloquer les autres commandes.
      expect(result.rowsImported).toBe(2);
      expect(result.rowsFailed).toBe(1);
      expect(result.status).toBe('PARTIAL_SUCCESS');
    });

    it('permet de rejouer une ligne corrigee sans relire la feuille', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 10 });
      const { configId } = await setupSheet(tenant, product.sku);

      // Echec initial : SKU inconnu.
      sheets.rows = [row({ sku: 'SKU-ABSENT' })];
      await runSync(tenant, configId);
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(0);

      // Le commercant cree le produit manquant, puis rejoue.
      await prisma.productVariant.updateMany({
        where: { tenantId: tenant.tenantId },
        data: { sku: 'SKU-ABSENT' },
      });

      const readsBefore = sheets.readCount;
      const retry = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        sync.retryFailedRows(tenant.tenantId, configId),
      );

      expect(retry.succeeded).toBe(1);
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(1);
      // Aucun appel supplementaire a Google : le rejeu ne consomme pas de quota.
      expect(sheets.readCount).toBe(readsBefore);
    });
  });

  // ==========================================================================
  describe('quota Google depasse (HTTP 429)', () => {
    it('programme une reprise sans perdre de commande', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      const retryAt = new Date(Date.now() + 120_000);
      sheets.nextError = new GoogleQuotaExceededError(retryAt, 4);

      const result = await runSync(tenant, configId);

      expect(result.status).toBe('RATE_LIMITED');
      expect(result.retryAt?.getTime()).toBe(retryAt.getTime());

      const config = await prisma.sheetSyncConfig.findUniqueOrThrow({
        where: { id: configId },
        select: { backoffUntil: true, lastProcessedRow: true },
      });

      // La reprise est programmee et la position de lecture est intacte :
      // la prochaine execution repartira exactement d'ou elle s'est arretee.
      expect(config.backoffUntil?.getTime()).toBe(retryAt.getTime());
      expect(config.lastProcessedRow).toBe(0);
    });

    it('notifie la boutique du quota atteint', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.nextError = new GoogleQuotaExceededError(new Date(Date.now() + 60_000), 4);
      await runSync(tenant, configId);

      const events = await prisma.outboxEvent.findMany({
        where: { tenantId: tenant.tenantId, eventType: 'sync.rate_limited' },
      });
      expect(events).toHaveLength(1);
    });

    it('reprend automatiquement une fois le delai ecoule', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 10 });
      const { configId } = await setupSheet(tenant, product.sku);

      // 1. Quota atteint.
      sheets.nextError = new GoogleQuotaExceededError(new Date(Date.now() + 60_000), 4);
      await runSync(tenant, configId);
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(0);

      // 2. Le delai s'ecoule.
      await prisma.sheetSyncConfig.update({
        where: { id: configId },
        data: { backoffUntil: new Date(Date.now() - 1_000) },
      });

      // 3. La synchronisation reprend et importe la commande en attente.
      sheets.rows = [row({ sku: product.sku })];
      const result = await runSync(tenant, configId);

      expect(result.status).toBe('SUCCESS');
      expect(result.rowsImported).toBe(1);
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(1);

      // Le blocage est leve.
      const config = await prisma.sheetSyncConfig.findUniqueOrThrow({
        where: { id: configId },
        select: { backoffUntil: true },
      });
      expect(config.backoffUntil).toBeNull();
    });

    it('respecte le delai de reprise sur une execution planifiee', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      await prisma.sheetSyncConfig.update({
        where: { id: configId },
        data: { backoffUntil: new Date(Date.now() + 300_000) },
      });

      sheets.rows = [row({ sku: product.sku })];
      const result = await RequestContextStore.runWithTenant(tenant.tenantId, () =>
        sync.sync(tenant.tenantId, configId, 'SCHEDULED'),
      );

      expect(result.status).toBe('RATE_LIMITED');
      // Aucune lecture n'a eu lieu : le quota est preserve.
      expect(sheets.readCount).toBe(0);
    });

    it('exclut du planning les feuilles en attente de reprise', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      await prisma.sheetSyncConfig.update({
        where: { id: configId },
        data: { backoffUntil: new Date(Date.now() + 300_000) },
      });

      const due = await sync.findDueConfigs();
      expect(due.map((entry) => entry.configId)).not.toContain(configId);
    });
  });

  // ==========================================================================
  describe('autres pannes Google', () => {
    it('marque l integration en erreur quand l acces est revoque', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId, integrationId } = await setupSheet(tenant, product.sku);

      sheets.nextError = new GoogleSheetsApiError(
        403,
        'GOOGLE_AUTH_REVOKED',
        'Acces refuse par Google.',
      );

      const result = await runSync(tenant, configId);

      expect(result.status).toBe('FAILED');

      const integration = await prisma.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { status: true, lastErrorCode: true },
      });
      expect(integration.status).toBe('ERROR');
      expect(integration.lastErrorCode).toBe('GOOGLE_AUTH_REVOKED');
    });

    it('degrade sans bloquer quand la feuille est introuvable', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId, integrationId } = await setupSheet(tenant, product.sku);

      sheets.nextError = new GoogleSheetsApiError(
        404,
        'GOOGLE_SHEET_NOT_FOUND',
        'Feuille introuvable.',
      );

      await runSync(tenant, configId);

      const integration = await prisma.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { status: true },
      });
      // L'acces Google reste valide : seule cette feuille pose probleme.
      expect(integration.status).toBe('DEGRADED');
    });

    it('compte les echecs consecutifs', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      for (let i = 0; i < 3; i += 1) {
        sheets.nextError = new GoogleSheetsApiError(500, 'GOOGLE_API_UNAVAILABLE', 'Panne.');
        await runSync(tenant, configId);
      }

      const config = await prisma.sheetSyncConfig.findUniqueOrThrow({
        where: { id: configId },
        select: { consecutiveFailures: true },
      });
      expect(config.consecutiveFailures).toBe(3);
    });
  });

  // ==========================================================================
  describe('test d import (mode simulation)', () => {
    it('valide le mapping sans creer aucune commande', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku }), row({ sku: product.sku, phone: '0555222222' })];

      const result = await runSync(tenant, configId, true);

      expect(result.rowsImported).toBe(2);
      // Le mode simulation n'ecrit rien : ni commande, ni trace d'import.
      expect(await prisma.order.count({ where: { tenantId: tenant.tenantId } })).toBe(0);
      expect(await prisma.sheetRowImport.count({ where: { tenantId: tenant.tenantId } })).toBe(0);
    });

    it('signale les lignes en erreur sans les enregistrer', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId } = await setupSheet(tenant, product.sku);

      sheets.rows = [row({ sku: product.sku, phone: 'invalide' })];

      const result = await runSync(tenant, configId, true);

      expect(result.rowsFailed).toBe(1);
      expect(await prisma.sheetRowImport.count({ where: { tenantId: tenant.tenantId } })).toBe(0);
    });
  });

  // ==========================================================================
  describe('concurrence', () => {
    it('refuse une seconde synchronisation pendant qu une autre tourne', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId);
      const { configId, integrationId } = await setupSheet(tenant, product.sku);

      await prisma.syncRun.create({
        data: {
          tenantId: tenant.tenantId,
          integrationId,
          configId,
          trigger: 'SCHEDULED',
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });

      await expect(runSync(tenant, configId)).rejects.toMatchObject({
        response: { code: 'SYNC_ALREADY_RUNNING' },
      });
    });

    it('cloture une execution bloquee depuis trop longtemps', async () => {
      const tenant = await createTenant(prisma);
      const product = await createProduct(prisma, tenant.tenantId, { stock: 10 });
      const { configId, integrationId } = await setupSheet(tenant, product.sku);

      // Execution abandonnee il y a 30 minutes (processus tue).
      // L'anciennete est calculee sur l'horloge FIGEE du contexte de test :
      // utiliser `Date.now()` produirait un ecart negatif et la ligne ne
      // serait pas consideree comme perimee.
      await prisma.syncRun.create({
        data: {
          tenantId: tenant.tenantId,
          integrationId,
          configId,
          trigger: 'SCHEDULED',
          status: 'RUNNING',
          startedAt: new Date(context.clock.timestamp() - 30 * 60_000),
        },
      });

      sheets.rows = [row({ sku: product.sku })];
      const result = await runSync(tenant, configId);

      expect(result.status).toBe('SUCCESS');
    });
  });

  // ==========================================================================
  describe('isolation multi-tenant', () => {
    it('n importe jamais dans la boutique d une autre', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const produitA = await createProduct(prisma, boutiqueA.tenantId, { stock: 10 });
      await createProduct(prisma, boutiqueB.tenantId, { stock: 10 });
      const { configId } = await setupSheet(boutiqueA, produitA.sku);

      sheets.rows = [row({ sku: produitA.sku })];
      await runSync(boutiqueA, configId);

      expect(await prisma.order.count({ where: { tenantId: boutiqueA.tenantId } })).toBe(1);
      expect(await prisma.order.count({ where: { tenantId: boutiqueB.tenantId } })).toBe(0);
    });

    it('permet a deux boutiques d importer le meme client sans collision', async () => {
      const boutiqueA = await createTenant(prisma);
      const boutiqueB = await createTenant(prisma);
      const produitA = await createProduct(prisma, boutiqueA.tenantId, { stock: 10 });
      const produitB = await createProduct(prisma, boutiqueB.tenantId, { stock: 10 });
      const configA = await setupSheet(boutiqueA, produitA.sku);
      const configB = await setupSheet(boutiqueB, produitB.sku);

      sheets.rows = [row({ sku: produitA.sku, phone: '0555777888' })];
      await runSync(boutiqueA, configA.configId);

      sheets.rows = [row({ sku: produitB.sku, phone: '0555777888' })];
      await runSync(boutiqueB, configB.configId);

      const customers = await prisma.customer.findMany({
        where: { phoneE164: '+213555777888' },
        select: { tenantId: true },
      });

      // Le meme client reel existe dans les deux boutiques, sans partage
      // d'historique.
      expect(customers).toHaveLength(2);
    });
  });
});
