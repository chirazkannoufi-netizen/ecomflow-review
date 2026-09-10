/**
 * Classification des modeles Prisma vis-a-vis du multi-tenant.
 *
 * Cette liste est le CONTRAT du garde d'isolation. Elle est verifiee par un
 * test unitaire (`tenant-guard.spec.ts`) qui compare son contenu au modele
 * Prisma reel : tout nouveau modele doit etre classe explicitement, sinon le
 * test echoue. Il est donc impossible d'ajouter une table portant des donnees
 * de boutique sans decider consciemment de son perimetre.
 */

/**
 * Modeles portant une colonne `tenantId` NON NULLE.
 * Le garde injecte systematiquement le filtre et refuse une requete non scopee.
 */
export const TENANT_SCOPED_MODELS = [
  'TenantSettings',
  'OnboardingProgress',
  'Membership',
  'Customer',
  'Address',
  'ProductCategory',
  'Product',
  'ProductVariant',
  'InventoryLevel',
  'InventoryMovement',
  'StockBatch',
  'ProductCrossSell',
  'TenantDeliveryFee',
  'ProductDeliveryFeeOverride',
  'OrderSequence',
  'Order',
  'OrderItem',
  'OrderStatusHistory',
  'OrderCallAttempt',
  'OrderDuplicateFlag',
  'CarrierAccount',
  'Shipment',
  'ShipmentEvent',
  'Return',
  'ReturnItem',
  'Integration',
  'SheetSyncConfig',
  'SheetRowImport',
  'SyncRun',
  'ImportJob',
  'ExportJob',
  'IdempotencyKey',
  'WhatsappThread',
  'Subscription',
  'Payment',
  'TrialRegistration',
  'Notification',
  'NotificationPreference',
] as const;

/**
 * Modeles dont la colonne `tenantId` est NULLABLE : ils peuvent porter une
 * ligne de plateforme (tenantId = null) ou une ligne de boutique.
 * Le garde injecte le filtre quand un tenant est actif, et laisse passer les
 * lectures de plateforme en mode non scope.
 */
export const TENANT_OPTIONAL_MODELS = ['Role', 'AuditLog', 'Incident', 'OutboxEvent'] as const;

/**
 * Modeles GLOBAUX, volontairement hors perimetre tenant.
 * Chacun est justifie ci-dessous : aucune de ces tables ne doit contenir de
 * donnee metier d'une boutique.
 */
export const GLOBAL_MODELS = [
  // Identites : un utilisateur existe avant tout rattachement a une boutique.
  'User',
  'RefreshToken',
  'PasswordResetToken',
  'OtpChallenge',
  'PlatformRoleAssignment',
  // Referentiels de plateforme.
  'Tenant',
  'Permission',
  'RolePermission',
  'Plan',
  'Carrier',
  // Capacites et couverture : des faits du RESEAU du transporteur, identiques
  // pour toutes les boutiques. Ce que chaque boutique en fait est porte par
  // `CarrierAccount`, lui bien scope.
  'CarrierCapability',
  'CarrierWilayaCoverage',
  // Deduplication des webhooks : doit avoir lieu AVANT la resolution du tenant.
  'ProcessedWebhook',
  // Fils de conversation WhatsApp : portes par WhatsappThread, deja scope.
  'WhatsappMessage',
  // Acheminement des notifications : porte par Notification, deja scope.
  'NotificationDelivery',
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];
export type TenantOptionalModel = (typeof TENANT_OPTIONAL_MODELS)[number];
export type GlobalModel = (typeof GLOBAL_MODELS)[number];

const scopedSet: ReadonlySet<string> = new Set(TENANT_SCOPED_MODELS);
const optionalSet: ReadonlySet<string> = new Set(TENANT_OPTIONAL_MODELS);
const globalSet: ReadonlySet<string> = new Set(GLOBAL_MODELS);

export function isTenantScopedModel(model: string): boolean {
  return scopedSet.has(model);
}

export function isTenantOptionalModel(model: string): boolean {
  return optionalSet.has(model);
}

export function isGlobalModel(model: string): boolean {
  return globalSet.has(model);
}

export function isKnownModel(model: string): boolean {
  return scopedSet.has(model) || optionalSet.has(model) || globalSet.has(model);
}

export const ALL_CLASSIFIED_MODELS: readonly string[] = [
  ...TENANT_SCOPED_MODELS,
  ...TENANT_OPTIONAL_MODELS,
  ...GLOBAL_MODELS,
];
