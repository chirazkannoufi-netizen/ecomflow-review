/**
 * Fabriques de donnees de test.
 *
 * Elles ecrivent avec le client BRUT et posent explicitement chaque
 * `tenantId` : une fabrique ne doit jamais dependre du garde d'isolation,
 * sinon les tests qui verifient ce garde tourneraient en rond.
 *
 * Chaque fabrique retourne des identifiants, pas des entites completes : les
 * tests relisent ce dont ils ont besoin, ce qui evite les assertions sur des
 * objets volumineux et fragiles.
 */

import { randomUUID } from 'node:crypto';
import type { OrderStatus, PrismaClient } from '@prisma/client';
import {
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLE_LABELS,
  TENANT_ROLES,
  computeTrialEnd,
  formatOrderReference,
} from '@ecomflow/shared';

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

export interface TestTenant {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly ownerMembershipId: string;
  readonly roleIdByCode: ReadonlyMap<string, string>;
  readonly slug: string;
}

export interface CreateTenantOptions {
  readonly name?: string;
  readonly status?: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  /** Etat de l'abonnement. `expired` simule un essai termine. */
  readonly subscription?: 'trial' | 'expired' | 'active' | 'none';
}

/** Cree une boutique complete : roles, permissions, proprietaire, abonnement. */
export async function createTenant(
  prisma: PrismaClient,
  options: CreateTenantOptions = {},
): Promise<TestTenant> {
  const now = new Date();
  const name = options.name ?? unique('Boutique');
  const slug = unique('boutique').toLowerCase();

  const user = await prisma.user.create({
    data: {
      email: `${unique('user').toLowerCase()}@test.local`,
      passwordHash: 'argon2-placeholder',
      fullName: 'Proprietaire Test',
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  const tenant = await prisma.tenant.create({
    data: { name, slug, status: options.status ?? 'ACTIVE', createdByUserId: user.id },
    select: { id: true },
  });

  await prisma.tenantSettings.create({ data: { tenantId: tenant.id } });
  await prisma.onboardingProgress.create({
    data: { tenantId: tenant.id, currentStep: 'ACTIVATED', completedAt: now },
  });
  await prisma.orderSequence.create({
    data: { tenantId: tenant.id, year: now.getUTCFullYear(), lastValue: 0 },
  });

  // --- Roles -----------------------------------------------------------------
  const permissions = await prisma.permission.findMany({
    where: { isPlatform: false },
    select: { id: true, key: true },
  });
  const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

  const roleIdByCode = new Map<string, string>();
  for (const code of TENANT_ROLES) {
    const role = await prisma.role.create({
      data: {
        tenantId: tenant.id,
        scope: 'TENANT',
        code,
        name: SYSTEM_ROLE_LABELS[code],
        isSystem: true,
      },
      select: { id: true },
    });
    roleIdByCode.set(code, role.id);

    const links = DEFAULT_ROLE_PERMISSIONS[code]
      .map((key) => permissionIdByKey.get(key))
      .filter((id): id is string => Boolean(id))
      .map((permissionId) => ({ roleId: role.id, permissionId }));

    if (links.length > 0) {
      await prisma.rolePermission.createMany({ data: links, skipDuplicates: true });
    }
  }

  const membership = await prisma.membership.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      roleId: roleIdByCode.get('OWNER') as string,
      status: 'ACTIVE',
      joinedAt: now,
    },
    select: { id: true },
  });

  // --- Abonnement ------------------------------------------------------------
  const mode = options.subscription ?? 'trial';
  if (mode !== 'none') {
    const past = new Date(now.getTime() - 30 * 86_400_000);
    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        status: mode === 'trial' ? 'TRIAL_ACTIVE' : mode === 'active' ? 'ACTIVE' : 'TRIAL_ENDED',
        trialStartAt: mode === 'trial' ? now : past,
        trialEndAt: mode === 'trial' ? computeTrialEnd(now) : computeTrialEnd(past),
        currentPeriodStart: mode === 'active' ? now : null,
        currentPeriodEnd: mode === 'active' ? new Date(now.getTime() + 30 * 86_400_000) : null,
        lastEvaluatedAt: now,
      },
    });
  }

  return {
    tenantId: tenant.id,
    ownerUserId: user.id,
    ownerMembershipId: membership.id,
    roleIdByCode,
    slug,
  };
}

export interface TestProduct {
  readonly productId: string;
  readonly variantId: string;
  readonly sku: string;
}

export async function createProduct(
  prisma: PrismaClient,
  tenantId: string,
  options: { stock?: number; salePriceCentimes?: number; purchasePriceCentimes?: number } = {},
): Promise<TestProduct> {
  const sku = unique('SKU').toUpperCase();
  const salePrice = options.salePriceCentimes ?? 450_000;
  const purchasePrice = options.purchasePriceCentimes ?? 250_000;

  const product = await prisma.product.create({
    data: {
      tenantId,
      name: `Produit ${sku}`,
      sku,
      salePriceCentimes: salePrice,
      purchasePriceCentimes: purchasePrice,
    },
    select: { id: true },
  });

  const variant = await prisma.productVariant.create({
    data: {
      tenantId,
      productId: product.id,
      sku: `${sku}-STD`,
      label: 'Standard',
      isDefault: true,
      salePriceCentimes: salePrice,
      purchasePriceCentimes: purchasePrice,
    },
    select: { id: true },
  });

  const stock = options.stock ?? 10;
  await prisma.inventoryLevel.create({
    data: { variantId: variant.id, tenantId, onHand: stock, reserved: 0, quarantine: 0 },
  });

  if (stock > 0) {
    await prisma.inventoryMovement.create({
      data: {
        tenantId,
        variantId: variant.id,
        type: 'INBOUND',
        quantity: stock,
        referenceType: 'MANUAL',
        onHandAfter: stock,
        reservedAfter: 0,
        quarantineAfter: 0,
      },
    });
  }

  return { productId: product.id, variantId: variant.id, sku: `${sku}-STD` };
}

export interface TestCustomer {
  readonly customerId: string;
  readonly addressId: string;
  readonly phoneE164: string;
}

export async function createCustomer(
  prisma: PrismaClient,
  tenantId: string,
  options: { phoneE164?: string; fullName?: string; wilayaCode?: number } = {},
): Promise<TestCustomer> {
  const phoneE164 = options.phoneE164 ?? `+2135${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;

  const customer = await prisma.customer.create({
    data: {
      tenantId,
      fullName: options.fullName ?? 'Client Test',
      phoneE164,
      phoneRaw: phoneE164,
    },
    select: { id: true },
  });

  const address = await prisma.address.create({
    data: {
      tenantId,
      customerId: customer.id,
      wilayaCode: options.wilayaCode ?? 16,
      wilayaName: 'Alger',
      commune: 'Bab Ezzouar',
      addressText: 'Cite 1200 Logements',
      addressNormalized: 'cite 1200 logements',
      isDefault: true,
    },
    select: { id: true },
  });

  return { customerId: customer.id, addressId: address.id, phoneE164 };
}

export interface TestOrder {
  readonly orderId: string;
  readonly reference: string;
  readonly itemId: string;
}

export async function createOrder(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    customerId: string;
    addressId: string;
    variantId: string;
    sku: string;
    status?: OrderStatus;
    quantity?: number;
    unitPriceCentimes?: number;
    deliveryFeeCentimes?: number;
    externalOrderId?: string | null;
  },
): Promise<TestOrder> {
  const now = new Date();
  const sequence = await prisma.orderSequence.upsert({
    where: { tenantId_year: { tenantId: params.tenantId, year: now.getUTCFullYear() } },
    create: { tenantId: params.tenantId, year: now.getUTCFullYear(), lastValue: 1 },
    update: { lastValue: { increment: 1 } },
    select: { lastValue: true },
  });

  const quantity = params.quantity ?? 1;
  const unitPrice = params.unitPriceCentimes ?? 450_000;
  const deliveryFee = params.deliveryFeeCentimes ?? 50_000;
  const itemsTotal = quantity * unitPrice;

  const order = await prisma.order.create({
    data: {
      tenantId: params.tenantId,
      reference: formatOrderReference(now.getUTCFullYear(), sequence.lastValue),
      externalOrderId: params.externalOrderId ?? null,
      source: 'MANUAL',
      status: params.status ?? 'TO_CONFIRM',
      customerId: params.customerId,
      addressId: params.addressId,
      customerNameSnapshot: 'Client Test',
      phoneSnapshot: '+213555123456',
      wilayaCodeSnapshot: 16,
      communeSnapshot: 'Bab Ezzouar',
      addressSnapshot: 'Cite 1200 Logements',
      itemsTotalCentimes: itemsTotal,
      deliveryFeeCentimes: deliveryFee,
      totalCentimes: itemsTotal + deliveryFee,
      orderedAt: now,
    },
    select: { id: true, reference: true },
  });

  const item = await prisma.orderItem.create({
    data: {
      tenantId: params.tenantId,
      orderId: order.id,
      variantId: params.variantId,
      productNameSnapshot: 'Produit Test',
      skuSnapshot: params.sku,
      quantity,
      unitPriceCentimes: unitPrice,
      unitPurchasePriceCentimes: 250_000,
      lineTotalCentimes: itemsTotal,
    },
    select: { id: true },
  });

  return { orderId: order.id, reference: order.reference, itemId: item.id };
}

/** Cree un compte transporteur utilisable pour les tests d'expedition. */
export async function createCarrierAccount(
  prisma: PrismaClient,
  tenantId: string,
  carrierCode = 'MOCK_CARRIER',
): Promise<{ carrierAccountId: string; carrierId: string }> {
  const carrier = await prisma.carrier.findUniqueOrThrow({
    where: { code: carrierCode },
    select: { id: true },
  });

  const account = await prisma.carrierAccount.create({
    data: {
      tenantId,
      carrierId: carrier.id,
      label: unique('compte'),
      status: 'CONNECTED',
      isDefault: true,
      config: {},
    },
    select: { id: true },
  });

  return { carrierAccountId: account.id, carrierId: carrier.id };
}
