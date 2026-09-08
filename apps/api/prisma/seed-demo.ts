/**
 * Boutique de demonstration.
 *
 * Objectif : permettre de decouvrir EcomFlow avec des donnees realistes, et
 * donner aux tests manuels une base stable. Active par `npm run seed -- --with-demo`.
 *
 * Les donnees sont fictives mais COHERENTES : les totaux correspondent aux
 * lignes, les mouvements de stock aux statuts, les compteurs clients a
 * l'historique reel des commandes. Une demonstration incoherente ferait perdre
 * confiance dans les calculs du produit.
 *
 * Ce script n'est JAMAIS execute automatiquement en production : il est
 * declenche explicitement par un operateur.
 */

import type { OrderStatus, PrismaClient } from '@prisma/client';
import { Algorithm, hash as argonHash } from '@node-rs/argon2';
import {
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_LABELS,
  TENANT_ROLES,
  computeTrialEnd,
  formatOrderReference,
  normalizeForComparison,
  normalizePhone,
  resolveWilaya,
  type SystemRole,
} from '@ecomflow/shared';

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const DEMO_SLUG = 'boutique-demo';
const DEMO_PASSWORD = 'DemoEcomFlow2026';

export interface DemoSeedResult {
  readonly tenantId: string;
  readonly slug: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
  readonly orderCount: number;
}

interface DemoOrderSpec {
  readonly customerIndex: number;
  readonly productSku: string;
  readonly quantity: number;
  readonly status: OrderStatus;
  readonly daysAgo: number;
}

/** Scenario de demonstration : couvre tout le cycle de vie d'une commande. */
const DEMO_ORDERS: readonly DemoOrderSpec[] = [
  { customerIndex: 0, productSku: 'ROB-001-M-RGE', quantity: 1, status: 'DELIVERED', daysAgo: 21 },
  { customerIndex: 0, productSku: 'SAC-001-STD', quantity: 1, status: 'DELIVERED', daysAgo: 14 },
  { customerIndex: 0, productSku: 'ROB-001-L-NOI', quantity: 2, status: 'DELIVERED', daysAgo: 6 },
  { customerIndex: 1, productSku: 'MON-001-STD', quantity: 1, status: 'RETURNED', daysAgo: 18 },
  { customerIndex: 1, productSku: 'SAC-001-STD', quantity: 1, status: 'REFUSED', daysAgo: 11 },
  { customerIndex: 1, productSku: 'ROB-001-M-RGE', quantity: 1, status: 'CANCELLED', daysAgo: 4 },
  { customerIndex: 2, productSku: 'MON-001-STD', quantity: 1, status: 'IN_DELIVERY', daysAgo: 2 },
  { customerIndex: 2, productSku: 'ROB-001-L-NOI', quantity: 1, status: 'SHIPPED', daysAgo: 1 },
  { customerIndex: 3, productSku: 'SAC-001-STD', quantity: 2, status: 'READY_TO_SHIP', daysAgo: 1 },
  { customerIndex: 3, productSku: 'ROB-001-M-RGE', quantity: 1, status: 'CONFIRMED', daysAgo: 0 },
  { customerIndex: 4, productSku: 'MON-001-STD', quantity: 1, status: 'TO_CONFIRM', daysAgo: 0 },
  { customerIndex: 5, productSku: 'ROB-001-L-NOI', quantity: 1, status: 'TO_CONFIRM', daysAgo: 0 },
  { customerIndex: 6, productSku: 'SAC-001-STD', quantity: 1, status: 'NO_ANSWER', daysAgo: 1 },
  { customerIndex: 7, productSku: 'MON-001-STD', quantity: 3, status: 'CALL_BACK', daysAgo: 1 },
  // Les trois statuts ci-dessous completent la couverture du workflow : sans
  // eux, l'ecran de preparation et la file de confirmation auraient des
  // colonnes vides, et l'on ne saurait pas si elles fonctionnent.
  { customerIndex: 4, productSku: 'ROB-001-M-RGE', quantity: 1, status: 'IN_PREPARATION', daysAgo: 0 },
  { customerIndex: 5, productSku: 'SAC-001-STD', quantity: 1, status: 'POSTPONED', daysAgo: 2 },
  { customerIndex: 8, productSku: 'MON-001-STD', quantity: 1, status: 'WRONG_NUMBER', daysAgo: 3 },
  { customerIndex: 9, productSku: 'ROB-001-L-NOI', quantity: 2, status: 'NEW', daysAgo: 0 },
  { customerIndex: 9, productSku: 'SAC-001-STD', quantity: 1, status: 'DELIVERED', daysAgo: 30 },
];

/**
 * Clients de demonstration.
 *
 * `locale` renseigne la langue dans laquelle CHACUN recoit ses messages
 * WhatsApp. Le jeu melange volontairement les deux langues et laisse certains
 * clients sans preference : c'est la situation reelle d'une boutique
 * algerienne, et cela permet de verifier que la resolution de langue
 * (client -> boutique -> defaut) fonctionne dans les trois cas.
 */
const DEMO_CUSTOMERS = [
  { name: 'Sara Benali', phone: '0555123456', wilaya: 'Alger', commune: 'Bab Ezzouar', address: 'Cite 1200 Logements, Bat B4', locale: 'fr' },
  { name: 'Yacine Meziane', phone: '0661234567', wilaya: 'Oran', commune: 'Bir El Djir', address: 'Rue des Freres Bouadjadj, 12', locale: null },
  { name: 'Amina Cherif', phone: '0770987654', wilaya: 'Constantine', commune: 'El Khroub', address: 'Cite Massinissa, Villa 8', locale: 'ar' },
  { name: 'Karim Haddad', phone: '0555998877', wilaya: 'Setif', commune: 'Ain Arnat', address: 'Lotissement El Bez, N 45', locale: 'ar' },
  { name: 'Nadia Boumediene', phone: '0662334455', wilaya: 'Blida', commune: 'Boufarik', address: 'Rue Emir Abdelkader, 3', locale: 'fr' },
  { name: 'Sofiane Belkacem', phone: '0771223344', wilaya: 'Tizi Ouzou', commune: 'Draa Ben Khedda', address: 'Cite des Oliviers', locale: null },
  { name: 'Lila Ait Ahmed', phone: '0556677889', wilaya: 'Bejaia', commune: 'Akbou', address: 'Village Ighzer Amokrane', locale: 'fr' },
  { name: 'Riad Zerrouki', phone: '0663344556', wilaya: 'Annaba', commune: 'El Bouni', address: 'Cite Sidi Salem, Bat 12', locale: 'ar' },
  { name: 'Fatima Belaid', phone: '0557788990', wilaya: 'Tlemcen', commune: 'Mansourah', address: 'Cite Kiffane, Bat C2', locale: 'ar' },
  { name: 'Mehdi Ouali', phone: '0664455667', wilaya: 'Batna', commune: 'Tazoult', address: 'Rue Larbi Ben M Hidi, 27', locale: 'fr' },
] as const;

const DEMO_PRODUCTS = [
  {
    sku: 'ROB-001',
    name: 'Robe longue brodee',
    category: 'Vetements',
    purchasePriceCentimes: 220_000,
    salePriceCentimes: 450_000,
    variants: [
      { sku: 'ROB-001-M-RGE', label: 'Rouge / M', attributes: { couleur: 'Rouge', taille: 'M' }, stock: 24 },
      { sku: 'ROB-001-L-NOI', label: 'Noir / L', attributes: { couleur: 'Noir', taille: 'L' }, stock: 18 },
    ],
  },
  {
    sku: 'SAC-001',
    name: 'Sac a main cuir',
    category: 'Accessoires',
    purchasePriceCentimes: 180_000,
    salePriceCentimes: 380_000,
    variants: [
      { sku: 'SAC-001-STD', label: 'Standard', attributes: {}, stock: 12 },
    ],
  },
  {
    sku: 'MON-001',
    name: 'Montre connectee',
    category: 'Electronique',
    purchasePriceCentimes: 520_000,
    salePriceCentimes: 890_000,
    variants: [
      { sku: 'MON-001-STD', label: 'Standard', attributes: {}, stock: 6 },
    ],
  },
] as const;

const DELIVERY_FEE_CENTIMES = 50_000;
const CARRIER_COST_CENTIMES = 45_000;
const RETURN_COST_CENTIMES = 30_000;

export async function seedDemoTenant(prisma: PrismaClient): Promise<DemoSeedResult> {
  const existing = await prisma.tenant.findUnique({
    where: { slug: DEMO_SLUG },
    select: { id: true },
  });

  if (existing) {
    // Rejouer le seed ne doit pas dupliquer la demonstration ni ecraser des
    // modifications faites pendant une session de decouverte.
    const orderCount = await prisma.order.count({ where: { tenantId: existing.id } });
    return {
      tenantId: existing.id,
      slug: DEMO_SLUG,
      ownerEmail: 'demo@ecomflow.local',
      ownerPassword: DEMO_PASSWORD,
      orderCount,
    };
  }

  const now = new Date();
  const passwordHash = await argonHash(DEMO_PASSWORD, ARGON2_OPTIONS);

  return prisma.$transaction(
    async (tx) => {
      // --- Utilisateurs -----------------------------------------------------
      const owner = await tx.user.create({
        data: {
          email: 'demo@ecomflow.local',
          passwordHash,
          fullName: 'Sara Demo',
          phoneE164: '+213555000001',
          phoneVerifiedAt: now,
          emailVerifiedAt: now,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      const agent = await tx.user.create({
        data: {
          email: 'agent@ecomflow.local',
          passwordHash,
          fullName: 'Nabil Agent',
          status: 'ACTIVE',
          emailVerifiedAt: now,
        },
        select: { id: true },
      });

      const preparer = await tx.user.create({
        data: {
          email: 'preparateur@ecomflow.local',
          passwordHash,
          fullName: 'Hakim Preparateur',
          status: 'ACTIVE',
          emailVerifiedAt: now,
        },
        select: { id: true },
      });

      // --- Boutique ---------------------------------------------------------
      const tenant = await tx.tenant.create({
        data: {
          name: 'Boutique Demo',
          slug: DEMO_SLUG,
          status: 'ACTIVE',
          createdByUserId: owner.id,
        },
        select: { id: true },
      });

      await tx.tenantSettings.create({
        data: { tenantId: tenant.id, whatsappFilterEnabled: false },
      });

      await tx.onboardingProgress.create({
        data: {
          tenantId: tenant.id,
          completedSteps: [
            'ACCOUNT_CREATED',
            'STORE_CREATED',
            'ORDER_SOURCE_CONNECTED',
            'COLUMN_MAPPING_CONFIGURED',
            'TEST_IMPORT_PASSED',
            'CARRIER_CONFIGURED',
            'ACTIVATED',
          ],
          currentStep: 'ACTIVATED',
          completedAt: now,
        },
      });

      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          status: 'TRIAL_ACTIVE',
          trialStartAt: now,
          trialEndAt: computeTrialEnd(now),
          lastEvaluatedAt: now,
        },
      });

      await tx.orderSequence.create({
        data: { tenantId: tenant.id, year: now.getUTCFullYear(), lastValue: 0 },
      });

      // --- Roles ------------------------------------------------------------
      const permissions = await tx.permission.findMany({
        where: { isPlatform: false },
        select: { id: true, key: true },
      });
      const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

      const roleIdByCode = new Map<string, string>();
      for (const code of TENANT_ROLES) {
        const role = await tx.role.create({
          data: {
            tenantId: tenant.id,
            scope: 'TENANT',
            code,
            name: SYSTEM_ROLE_LABELS[code as SystemRole],
            description: SYSTEM_ROLE_DESCRIPTIONS[code as SystemRole],
            isSystem: true,
          },
          select: { id: true },
        });
        roleIdByCode.set(code, role.id);

        const links = DEFAULT_ROLE_PERMISSIONS[code as SystemRole]
          .map((key) => permissionIdByKey.get(key))
          .filter((id): id is string => Boolean(id))
          .map((permissionId) => ({ roleId: role.id, permissionId }));

        if (links.length > 0) {
          await tx.rolePermission.createMany({ data: links, skipDuplicates: true });
        }
      }

      const ownerMembership = await tx.membership.create({
        data: {
          tenantId: tenant.id,
          userId: owner.id,
          roleId: roleIdByCode.get('OWNER') as string,
          status: 'ACTIVE',
          joinedAt: now,
        },
        select: { id: true },
      });

      const agentMembership = await tx.membership.create({
        data: {
          tenantId: tenant.id,
          userId: agent.id,
          roleId: roleIdByCode.get('CONFIRMATION_AGENT') as string,
          status: 'ACTIVE',
          joinedAt: now,
        },
        select: { id: true },
      });

      const preparerMembership = await tx.membership.create({
        data: {
          tenantId: tenant.id,
          userId: preparer.id,
          roleId: roleIdByCode.get('PREPARER') as string,
          status: 'ACTIVE',
          joinedAt: now,
        },
        select: { id: true },
      });

      // --- Catalogue --------------------------------------------------------
      const variantBySku = new Map<
        string,
        { id: string; productName: string; label: string | null; salePrice: number; purchasePrice: number }
      >();

      for (const productSpec of DEMO_PRODUCTS) {
        const category = await tx.productCategory.upsert({
          where: {
            tenantId_slug: { tenantId: tenant.id, slug: slugifyDemo(productSpec.category) },
          },
          create: {
            tenantId: tenant.id,
            name: productSpec.category,
            slug: slugifyDemo(productSpec.category),
          },
          update: {},
          select: { id: true },
        });

        const product = await tx.product.create({
          data: {
            tenantId: tenant.id,
            categoryId: category.id,
            name: productSpec.name,
            sku: productSpec.sku,
            purchasePriceCentimes: productSpec.purchasePriceCentimes,
            salePriceCentimes: productSpec.salePriceCentimes,
            isActive: true,
          },
          select: { id: true },
        });

        for (const [index, variantSpec] of productSpec.variants.entries()) {
          const variant = await tx.productVariant.create({
            data: {
              tenantId: tenant.id,
              productId: product.id,
              sku: variantSpec.sku,
              label: variantSpec.label,
              attributes: variantSpec.attributes,
              purchasePriceCentimes: productSpec.purchasePriceCentimes,
              salePriceCentimes: productSpec.salePriceCentimes,
              isDefault: index === 0,
              isActive: true,
            },
            select: { id: true },
          });

          await tx.inventoryLevel.create({
            data: {
              variantId: variant.id,
              tenantId: tenant.id,
              onHand: variantSpec.stock,
              reserved: 0,
              quarantine: 0,
            },
          });

          await tx.inventoryMovement.create({
            data: {
              tenantId: tenant.id,
              variantId: variant.id,
              type: 'INBOUND',
              quantity: variantSpec.stock,
              referenceType: 'MANUAL',
              actorId: ownerMembership.id,
              note: 'Stock initial de demonstration',
              onHandAfter: variantSpec.stock,
              reservedAfter: 0,
              quarantineAfter: 0,
            },
          });

          variantBySku.set(variantSpec.sku, {
            id: variant.id,
            productName: productSpec.name,
            label: variantSpec.label,
            salePrice: productSpec.salePriceCentimes,
            purchasePrice: productSpec.purchasePriceCentimes,
          });
        }
      }

      // --- Clients ----------------------------------------------------------
      const customerIds: { id: string; addressId: string; name: string; phone: string; wilayaCode: number; commune: string; address: string }[] = [];

      for (const customerSpec of DEMO_CUSTOMERS) {
        const phoneE164 = normalizePhone(customerSpec.phone) as string;
        const wilaya = resolveWilaya(customerSpec.wilaya);

        const customer = await tx.customer.create({
          data: {
            tenantId: tenant.id,
            fullName: customerSpec.name,
            phoneE164,
            phoneRaw: customerSpec.phone,
            locale: customerSpec.locale,
          },
          select: { id: true },
        });

        const address = await tx.address.create({
          data: {
            tenantId: tenant.id,
            customerId: customer.id,
            wilayaCode: wilaya?.code ?? 16,
            wilayaName: wilaya?.name ?? 'Alger',
            commune: customerSpec.commune,
            addressText: customerSpec.address,
            addressNormalized: normalizeForComparison(customerSpec.address),
            isDefault: true,
          },
          select: { id: true },
        });

        customerIds.push({
          id: customer.id,
          addressId: address.id,
          name: customerSpec.name,
          phone: phoneE164,
          wilayaCode: wilaya?.code ?? 16,
          commune: customerSpec.commune,
          address: customerSpec.address,
        });
      }

      // --- Commandes --------------------------------------------------------
      let sequence = 0;

      for (const spec of DEMO_ORDERS) {
        sequence += 1;
        const customer = customerIds[spec.customerIndex];
        const variant = variantBySku.get(spec.productSku);
        if (!customer || !variant) continue;

        const orderedAt = new Date(now.getTime() - spec.daysAgo * 86_400_000);
        const itemsTotal = variant.salePrice * spec.quantity;
        const total = itemsTotal + DELIVERY_FEE_CENTIMES;

        const shipped = ['SHIPPED', 'IN_DELIVERY', 'DELIVERED', 'REFUSED', 'RETURNED'].includes(
          spec.status,
        );
        const returned = ['RETURNED', 'REFUSED'].includes(spec.status);

        const order = await tx.order.create({
          data: {
            tenantId: tenant.id,
            reference: formatOrderReference(orderedAt.getUTCFullYear(), sequence),
            source: 'GOOGLE_SHEETS',
            status: spec.status,
            customerId: customer.id,
            addressId: customer.addressId,
            customerNameSnapshot: customer.name,
            phoneSnapshot: customer.phone,
            wilayaCodeSnapshot: customer.wilayaCode,
            communeSnapshot: customer.commune,
            addressSnapshot: customer.address,
            itemsTotalCentimes: itemsTotal,
            deliveryFeeCentimes: DELIVERY_FEE_CENTIMES,
            totalCentimes: total,
            carrierCostCentimes: shipped ? CARRIER_COST_CENTIMES : 0,
            returnCostCentimes: returned ? RETURN_COST_CENTIMES : 0,
            assignedMembershipId: agentMembership.id,
            preparedByMembershipId: shipped ? preparerMembership.id : null,
            confirmationChannel: 'HUMAN_AGENT',
            stockReserved: false,
            orderedAt,
            createdAt: orderedAt,
            confirmedAt: spec.status === 'TO_CONFIRM' || spec.status === 'NO_ANSWER' || spec.status === 'CALL_BACK' ? null : orderedAt,
            shippedAt: shipped ? new Date(orderedAt.getTime() + 86_400_000) : null,
            deliveredAt: spec.status === 'DELIVERED' ? new Date(orderedAt.getTime() + 3 * 86_400_000) : null,
            returnedAt: spec.status === 'RETURNED' ? new Date(orderedAt.getTime() + 5 * 86_400_000) : null,
            cancelledAt: spec.status === 'CANCELLED' ? new Date(orderedAt.getTime() + 86_400_000) : null,
          },
          select: { id: true },
        });

        await tx.orderItem.create({
          data: {
            tenantId: tenant.id,
            orderId: order.id,
            variantId: variant.id,
            productNameSnapshot: variant.productName,
            skuSnapshot: spec.productSku,
            variantLabelSnapshot: variant.label,
            quantity: spec.quantity,
            unitPriceCentimes: variant.salePrice,
            unitPurchasePriceCentimes: variant.purchasePrice,
            lineTotalCentimes: itemsTotal,
          },
        });

        await tx.orderStatusHistory.create({
          data: {
            tenantId: tenant.id,
            orderId: order.id,
            oldStatus: null,
            newStatus: 'NEW',
            actorKind: 'SYSTEM',
            source: 'demo-seed',
            createdAt: orderedAt,
          },
        });

        await tx.orderStatusHistory.create({
          data: {
            tenantId: tenant.id,
            orderId: order.id,
            oldStatus: 'NEW',
            newStatus: spec.status,
            actorKind: 'SYSTEM',
            source: 'demo-seed',
            note: 'Etat initial du jeu de demonstration',
            createdAt: orderedAt,
          },
        });
      }

      // --- Compteurs clients coherents avec l'historique --------------------
      for (const customer of customerIds) {
        const orders = await tx.order.findMany({
          where: { tenantId: tenant.id, customerId: customer.id },
          select: { status: true, orderedAt: true },
        });

        const count = (status: OrderStatus): number =>
          orders.filter((order) => order.status === status).length;

        const lastOrderAt = orders.reduce<Date | null>(
          (latest, order) => (!latest || order.orderedAt > latest ? order.orderedAt : latest),
          null,
        );

        await tx.customer.update({
          where: { id: customer.id },
          data: {
            ordersCount: orders.length,
            deliveredCount: count('DELIVERED'),
            cancelledCount: count('CANCELLED'),
            refusedCount: count('REFUSED'),
            returnedCount: count('RETURNED'),
            lastOrderAt,
          },
        });
      }

      await tx.orderSequence.update({
        where: { tenantId_year: { tenantId: tenant.id, year: now.getUTCFullYear() } },
        data: { lastValue: sequence },
      });

      return {
        tenantId: tenant.id,
        slug: DEMO_SLUG,
        ownerEmail: 'demo@ecomflow.local',
        ownerPassword: DEMO_PASSWORD,
        orderCount: DEMO_ORDERS.length,
      };
    },
    // Le jeu de demonstration ecrit plusieurs centaines de lignes : le delai
    // par defaut de Prisma (5 s) est insuffisant sur un poste modeste.
    { timeout: 120_000, maxWait: 30_000 },
  );
}

function slugifyDemo(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
