/**
 * Enumerations metier transverses.
 *
 * Ces valeurs sont dupliquees en enums Prisma cote base (apps/api/prisma/schema.prisma).
 * `packages/shared` reste la reference lisible cote produit ; un test de coherence
 * (apps/api/test/unit/shared-enums.spec.ts) verifie que les deux restent alignes.
 */

// ---------------------------------------------------------------------------
// Sources de commande (V1 §6, V2 §12)
// ---------------------------------------------------------------------------

export const ORDER_SOURCES = [
  'GOOGLE_SHEETS',
  'MANUAL',
  'CSV_IMPORT',
  'EXCEL_IMPORT',
  'API',
  'WEBSITE',
  'SOCIAL',
  'ABANDONED_CART',
  'SHOPIFY',
  'WOOCOMMERCE',
  'YOUCAN',
  'LIGHTFUNNELS',
  'FACEBOOK',
  'TIKTOK',
] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = {
  GOOGLE_SHEETS: 'Google Sheets',
  MANUAL: 'Saisie manuelle',
  CSV_IMPORT: 'Import CSV',
  EXCEL_IMPORT: 'Import Excel',
  API: 'API',
  WEBSITE: 'Site web',
  SOCIAL: 'Reseaux sociaux',
  ABANDONED_CART: 'Panier abandonne',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  YOUCAN: 'Youcan',
  LIGHTFUNNELS: 'Lightfunnels',
  FACEBOOK: 'Prospect Facebook',
  TIKTOK: 'Prospect TikTok',
};

/**
 * Provenances qu'un agent peut choisir A LA SAISIE.
 *
 * `API` et `CSV_IMPORT` en sont exclus : ce ne sont pas des choix, ce sont des
 * constats poses par le systeme qui a cree la commande. Les proposer dans un
 * menu laisserait croire qu'un humain peut se declarer « API ».
 */
export const MANUAL_ORDER_SOURCES: readonly OrderSource[] = [
  'MANUAL',
  'ABANDONED_CART',
  'FACEBOOK',
  'TIKTOK',
  'SHOPIFY',
  'WOOCOMMERCE',
  'YOUCAN',
  'LIGHTFUNNELS',
  'WEBSITE',
  'SOCIAL',
];

// ---------------------------------------------------------------------------
// Canal de confirmation (Addendum §31)
// ---------------------------------------------------------------------------

export const CONFIRMATION_CHANNELS = ['WHATSAPP_AUTO', 'HUMAN_AGENT', 'NOT_APPLICABLE'] as const;
export type ConfirmationChannel = (typeof CONFIRMATION_CHANNELS)[number];

export const CONFIRMATION_CHANNEL_LABELS: Record<ConfirmationChannel, string> = {
  WHATSAPP_AUTO: 'WhatsApp automatise',
  HUMAN_AGENT: 'Agent humain',
  NOT_APPLICABLE: 'Non applicable',
};

/** Etat du filtre WhatsApp pour une commande (Addendum §31). */
export const WHATSAPP_FILTER_STATES = [
  'NOT_ELIGIBLE',
  'PENDING',
  'SENT',
  'CONFIRMED',
  'MODIFICATION_REQUESTED',
  'CANCELLED_BY_CUSTOMER',
  'NO_RESPONSE',
  'FAILED',
  'HANDED_OVER',
] as const;
export type WhatsappFilterState = (typeof WHATSAPP_FILTER_STATES)[number];

// ---------------------------------------------------------------------------
// Stock (V2 §14)
// ---------------------------------------------------------------------------

export const INVENTORY_MOVEMENT_TYPES = [
  'INBOUND',
  'RESERVATION',
  'RESERVATION_RELEASE',
  'OUTBOUND',
  'RETURN_RESTOCK',
  'RETURN_QUARANTINE',
  'ADJUSTMENT',
  'OUTBOUND_REVERSAL',
] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

export const INVENTORY_MOVEMENT_LABELS: Record<InventoryMovementType, string> = {
  INBOUND: 'Entree en stock',
  RESERVATION: 'Reservation',
  RESERVATION_RELEASE: 'Liberation de reservation',
  OUTBOUND: 'Sortie de stock',
  RETURN_RESTOCK: 'Retour remis en stock',
  RETURN_QUARANTINE: 'Retour en stock a verifier',
  ADJUSTMENT: 'Ajustement',
  OUTBOUND_REVERSAL: 'Sortie annulee',
};

/**
 * Effet de chaque type de mouvement sur les compteurs de stock.
 * `onHand`  : quantite physiquement detenue.
 * `reserved`: quantite engagee sur des commandes non encore sorties.
 * `quarantine`: retours en attente de controle qualite.
 * Le stock disponible se calcule : onHand - reserved.
 */
export const INVENTORY_MOVEMENT_EFFECTS: Record<
  InventoryMovementType,
  { onHand: -1 | 0 | 1; reserved: -1 | 0 | 1; quarantine: -1 | 0 | 1 }
> = {
  INBOUND: { onHand: 1, reserved: 0, quarantine: 0 },
  RESERVATION: { onHand: 0, reserved: 1, quarantine: 0 },
  RESERVATION_RELEASE: { onHand: 0, reserved: -1, quarantine: 0 },
  OUTBOUND: { onHand: -1, reserved: -1, quarantine: 0 },
  RETURN_RESTOCK: { onHand: 1, reserved: 0, quarantine: 0 },
  RETURN_QUARANTINE: { onHand: 0, reserved: 0, quarantine: 1 },
  ADJUSTMENT: { onHand: 1, reserved: 0, quarantine: 0 },
  // L'inverse exact d'`OUTBOUND` : la marchandise revient en stock ET redevient
  // reservee, parce que la commande qui la retenait existe toujours.
  OUTBOUND_REVERSAL: { onHand: 1, reserved: 1, quarantine: 0 },
};

export const OUT_OF_STOCK_BEHAVIORS = [
  'INHERIT',
  'ALLOW',
  'REFUSE_ORDER',
  'REFUSE_CONFIRMATION',
] as const;
export type OutOfStockBehavior = (typeof OUT_OF_STOCK_BEHAVIORS)[number];

export const OUT_OF_STOCK_BEHAVIOR_LABELS: Record<OutOfStockBehavior, string> = {
  INHERIT: 'Suivre le reglage de la boutique',
  ALLOW: 'Vendre quand meme (precommande)',
  REFUSE_ORDER: 'Refuser la commande',
  REFUSE_CONFIRMATION: 'Accepter, mais bloquer la confirmation',
};

/** Comportement de rupture REELLEMENT applique a une variante. */
export type EffectiveOutOfStockBehavior = Exclude<OutOfStockBehavior, 'INHERIT'>;

/**
 * Resout `INHERIT` en une decision applicable.
 *
 * POURQUOI CETTE FONCTION EST PARTAGEE
 *   La regle doit donner le meme resultat a trois endroits qui la posent
 *   differemment : la garde de confirmation (« puis-je confirmer ? »), la
 *   creation de commande (« puis-je seulement l'enregistrer ? ») et l'ecran
 *   produit (« qu'est-ce que ce reglage va faire ? »). Une regle recopiee trois
 *   fois est une regle qui divergera.
 *
 * EQUIVALENCE AVEC L'EXISTANT
 *   Sous `INHERIT`, le resultat reproduit exactement la condition qui prevalait
 *   avant l'introduction du reglage par variante : la confirmation n'etait
 *   bloquee que si la boutique refusait la survente ET reservait son stock a la
 *   confirmation. Une variante qui n'a rien demande se comporte donc comme
 *   avant, ce qui est la condition pour que la migration ne change l'issue
 *   d'aucune commande en cours.
 */
export function resolveOutOfStockBehavior(
  variantBehavior: OutOfStockBehavior,
  shop: { readonly allowOversell: boolean; readonly reserveStockOnConfirm: boolean },
): EffectiveOutOfStockBehavior {
  if (variantBehavior !== 'INHERIT') return variantBehavior;
  if (shop.allowOversell || !shop.reserveStockOnConfirm) return 'ALLOW';
  return 'REFUSE_CONFIRMATION';
}

export const STOCK_EXIT_STRATEGIES = ['FIFO', 'LIFO', 'FEFO', 'RANDOM'] as const;
export type StockExitStrategy = (typeof STOCK_EXIT_STRATEGIES)[number];

export const STOCK_EXIT_STRATEGY_LABELS: Record<StockExitStrategy, string> = {
  FIFO: 'Premier entre, premier sorti',
  LIFO: 'Dernier entre, premier sorti',
  FEFO: 'Peremption la plus proche d abord',
  RANDOM: 'Aleatoire',
};

export const INVENTORY_REFERENCE_TYPES = [
  'ORDER',
  'RETURN',
  'MANUAL',
  'IMPORT',
  'SHIPMENT',
] as const;
export type InventoryReferenceType = (typeof INVENTORY_REFERENCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Retours (V1 §14, V2 §18)
// ---------------------------------------------------------------------------

export const RETURN_REASONS = [
  'CUSTOMER_ABSENT',
  'CUSTOMER_REFUSED',
  'WRONG_NUMBER',
  'UNREACHABLE',
  'PRODUCT_NOT_CONFORM',
  'DAMAGED_IN_TRANSIT',
  'DELIVERY_DELAY',
  'OTHER',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  CUSTOMER_ABSENT: 'Client absent',
  CUSTOMER_REFUSED: 'Refus du client',
  WRONG_NUMBER: 'Numero incorrect',
  UNREACHABLE: 'Client injoignable',
  PRODUCT_NOT_CONFORM: 'Produit non conforme',
  DAMAGED_IN_TRANSIT: 'Produit endommage pendant le transport',
  DELIVERY_DELAY: 'Delai de livraison depasse',
  OTHER: 'Autre',
};

export const RETURN_STATUSES = [
  'PENDING',
  'IN_TRANSIT',
  'RECEIVED',
  'INSPECTED',
  'CLOSED',
  'CANCELLED',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  PENDING: 'En attente',
  IN_TRANSIT: 'En retour',
  RECEIVED: 'Recu',
  INSPECTED: 'Controle',
  CLOSED: 'Cloture',
  CANCELLED: 'Annule',
};

export const PRODUCT_CONDITIONS = ['SELLABLE', 'DAMAGED', 'INCOMPLETE', 'UNKNOWN'] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

export const STOCK_DECISIONS = ['RESTOCK', 'QUARANTINE', 'WRITE_OFF', 'PENDING'] as const;
export type StockDecision = (typeof STOCK_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Expedition (V2 §16, §17)
// ---------------------------------------------------------------------------

/** Statut interne du colis cote EcomFlow (independant du transporteur). */
export const CARRIER_ACCOUNT_KINDS = ['DELIVERY_AGENT', 'DELIVERY_COMPANY'] as const;
export type CarrierAccountKind = (typeof CARRIER_ACCOUNT_KINDS)[number];

export const CARRIER_ACCOUNT_KIND_LABELS: Record<CarrierAccountKind, string> = {
  DELIVERY_AGENT: 'Agent de livraison',
  DELIVERY_COMPANY: 'Societe de livraison',
};

export const SHIPMENT_STATUSES = [
  'DRAFT',
  'CREATION_PENDING',
  'CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_ATTEMPT',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
  'ERROR',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  DRAFT: 'Brouillon',
  CREATION_PENDING: 'Creation en cours',
  CREATED: 'Colis cree',
  PICKED_UP: 'Pris en charge',
  IN_TRANSIT: 'En transit',
  OUT_FOR_DELIVERY: 'En livraison',
  DELIVERED: 'Livre',
  FAILED_ATTEMPT: 'Tentative echouee',
  RETURNING: 'En retour',
  RETURNED: 'Retourne',
  CANCELLED: 'Annule',
  ERROR: 'Erreur',
};

/** Statuts de colis consideres comme "actifs" : bloquent une seconde creation. */
export const ACTIVE_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'CREATION_PENDING',
  'CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'FAILED_ATTEMPT',
  'RETURNING',
];

// ---------------------------------------------------------------------------
// Abonnement (V1 §21, V2 §7, Annexe C/41)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = [
  'TRIAL_ACTIVE',
  'TRIAL_ENDING',
  'TRIAL_ENDED',
  'EXPIRED',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  TRIAL_ACTIVE: 'Essai en cours',
  TRIAL_ENDING: 'Essai bientot termine',
  TRIAL_ENDED: 'Essai termine',
  EXPIRED: 'Expire',
  ACTIVE: 'Abonnement actif',
  PAST_DUE: 'Paiement a regulariser',
  SUSPENDED: 'Suspendu',
  CANCELLED: 'Resilie',
};

/**
 * Statuts qui autorisent l'usage des fonctionnalites operationnelles payantes.
 * Toute autre valeur bloque l'operationnel (V2 §7, critere d'acceptation final).
 *
 * TRIAL_ENDING est un simple indicateur d'interface : il n'enleve aucun droit.
 * PAST_DUE conserve l'acces pendant la periode de grace geree cote serveur.
 */
export const OPERATIONAL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'TRIAL_ACTIVE',
  'TRIAL_ENDING',
  'ACTIVE',
  'PAST_DUE',
];

export function isOperationalSubscription(status: SubscriptionStatus): boolean {
  return OPERATIONAL_SUBSCRIPTION_STATUSES.includes(status);
}

export const BILLING_PERIODS = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const BILLING_PERIOD_MONTHS: Record<BillingPeriod, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
};

// ---------------------------------------------------------------------------
// Paiements (Addendum §35)
// ---------------------------------------------------------------------------

export const PAYMENT_PROVIDERS = ['CHARGILY', 'MANUAL_TRANSFER', 'MANUAL_BARIDIMOB'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_STATUSES = [
  'PENDING',
  'AWAITING_VERIFICATION',
  'PROCESSING',
  'PAID',
  'FAILED',
  'REJECTED',
  'REFUNDED',
  'EXPIRED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'En attente',
  AWAITING_VERIFICATION: 'En attente de verification',
  PROCESSING: 'En cours de traitement',
  PAID: 'Paye',
  FAILED: 'Echoue',
  REJECTED: 'Refuse',
  REFUNDED: 'Rembourse',
  EXPIRED: 'Expire',
};

/** Seul un paiement dans cet etat peut activer un abonnement. */
export const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = ['PAID'];

// ---------------------------------------------------------------------------
// Integrations (V2 §12, §16)
// ---------------------------------------------------------------------------

export const INTEGRATION_TYPES = ['ORDER_SOURCE', 'CARRIER', 'MESSAGING', 'PAYMENT'] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const INTEGRATION_STATUSES = [
  'DISCONNECTED',
  'PENDING_SETUP',
  'CONNECTED',
  'DEGRADED',
  'ERROR',
  'DISABLED',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  DISCONNECTED: 'Non connectee',
  PENDING_SETUP: 'Configuration en cours',
  CONNECTED: 'Connectee',
  DEGRADED: 'Degradee',
  ERROR: 'En erreur',
  DISABLED: 'Desactivee',
};

// ---------------------------------------------------------------------------
// Jobs de synchronisation et d'import (V2 §27, §30, Addendum §39)
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCESS',
  'PARTIAL_SUCCESS',
  'FAILED',
  'RATE_LIMITED',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: 'En file',
  RUNNING: 'En cours',
  SUCCESS: 'Termine',
  PARTIAL_SUCCESS: 'Termine avec erreurs',
  FAILED: 'Echoue',
  RATE_LIMITED: 'Quota depasse',
  CANCELLED: 'Annule',
};

export const SYNC_TRIGGERS = ['SCHEDULED', 'MANUAL', 'ONBOARDING', 'RETRY', 'WEBHOOK'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/** Raison d'echec d'une ligne source, exposee dans le journal d'import. */
export const IMPORT_ROW_ERROR_CODES = [
  'MISSING_REQUIRED_FIELD',
  'INVALID_PHONE',
  'INVALID_QUANTITY',
  'INVALID_PRICE',
  'UNKNOWN_WILAYA',
  'UNKNOWN_SKU',
  'DUPLICATE_ROW',
  'MAPPING_ERROR',
  'UNEXPECTED_ERROR',
] as const;
export type ImportRowErrorCode = (typeof IMPORT_ROW_ERROR_CODES)[number];

export const IMPORT_ROW_ERROR_LABELS: Record<ImportRowErrorCode, string> = {
  MISSING_REQUIRED_FIELD: 'Champ obligatoire manquant',
  INVALID_PHONE: 'Numero de telephone inexploitable',
  INVALID_QUANTITY: 'Quantite invalide',
  INVALID_PRICE: 'Prix invalide',
  UNKNOWN_WILAYA: 'Wilaya inconnue',
  UNKNOWN_SKU: 'SKU introuvable dans le catalogue',
  DUPLICATE_ROW: 'Ligne deja importee',
  MAPPING_ERROR: 'Mapping de colonnes incorrect',
  UNEXPECTED_ERROR: 'Erreur inattendue',
};

// ---------------------------------------------------------------------------
// Notifications (V1 §18, V2 §21, Addendum §36)
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'WHATSAPP', 'WEBHOOK'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_TYPES = [
  'ORDER_CREATED',
  'ORDER_DELIVERED',
  'ORDER_RETURNED',
  'LOW_STOCK',
  'GOOGLE_SHEETS_FAILURE',
  'GOOGLE_SHEETS_RATE_LIMITED',
  'CARRIER_FAILURE',
  'INTEGRATION_DOWN',
  'TRIAL_ENDING',
  'TRIAL_ENDED',
  'PAYMENT_FAILED',
  'PAYMENT_APPROVED',
  'PAYMENT_REJECTED',
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_SUSPENDED',
  'DUPLICATE_ORDER_DETECTED',
  'PROFITABILITY_THRESHOLD_EXCEEDED',
  'WHATSAPP_HANDOVER',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_DELIVERY_STATUSES = [
  'PENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'SKIPPED',
] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Score de fiabilite client (Addendum §32)
// ---------------------------------------------------------------------------

export const RELIABILITY_TIERS = ['RELIABLE', 'WATCH', 'AT_RISK', 'UNKNOWN'] as const;
export type ReliabilityTier = (typeof RELIABILITY_TIERS)[number];

export const RELIABILITY_TIER_LABELS: Record<ReliabilityTier, string> = {
  RELIABLE: 'Fiable',
  WATCH: 'A surveiller',
  AT_RISK: 'A risque',
  UNKNOWN: 'Historique insuffisant',
};

// ---------------------------------------------------------------------------
// Audit (V2 §23)
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'AUTH_LOGIN_SUCCESS',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGOUT',
  'AUTH_PASSWORD_RESET_REQUESTED',
  'AUTH_PASSWORD_CHANGED',
  'USER_INVITED',
  'USER_ROLE_CHANGED',
  'USER_DEACTIVATED',
  'ROLE_PERMISSIONS_CHANGED',
  'TENANT_CREATED',
  'TENANT_SETTINGS_UPDATED',
  'TENANT_SUSPENDED',
  'ORDER_CREATED',
  'ORDER_UPDATED',
  'ORDER_STATUS_CHANGED',
  'ORDER_ARCHIVED',
  'ORDER_DUPLICATE_RESOLVED',
  'INVENTORY_ADJUSTED',
  'SHIPMENT_CREATED',
  'SHIPMENT_CANCELLED',
  'RETURN_CREATED',
  'RETURN_RESOLVED',
  'INTEGRATION_CONNECTED',
  'INTEGRATION_DISCONNECTED',
  'INTEGRATION_CONFIG_UPDATED',
  'EXPORT_GENERATED',
  'PAYMENT_SUBMITTED',
  'PAYMENT_APPROVED',
  'PAYMENT_REJECTED',
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_SUSPENDED',
  'SUBSCRIPTION_CANCELLED',
  'TRIAL_STARTED',
  'TRIAL_EXPIRED',
  'TRIAL_ABUSE_FLAGGED',
  'TRIAL_ABUSE_REVIEWED',
  'DATA_RETENTION_APPLIED',
  'CUSTOMER_DATA_ERASED',
  /** Suppression definitive depuis la corbeille. Voir `DATA_PURGE`. */
  'DATA_PURGED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Etats de compte utilisateur / tenant
// ---------------------------------------------------------------------------

export const USER_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'DISABLED', 'LOCKED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const TENANT_STATUSES = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

// ---------------------------------------------------------------------------
// Onboarding (Addendum §34)
// ---------------------------------------------------------------------------

export const ONBOARDING_STEPS = [
  'ACCOUNT_CREATED',
  'STORE_CREATED',
  'ORDER_SOURCE_CONNECTED',
  'COLUMN_MAPPING_CONFIGURED',
  'TEST_IMPORT_PASSED',
  'CARRIER_CONFIGURED',
  'WHATSAPP_CONFIGURED',
  'ACTIVATED',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  ACCOUNT_CREATED: 'Compte cree',
  STORE_CREATED: 'Boutique creee',
  ORDER_SOURCE_CONNECTED: 'Source de commandes connectee',
  COLUMN_MAPPING_CONFIGURED: 'Mapping des colonnes configure',
  TEST_IMPORT_PASSED: 'Import de test reussi',
  CARRIER_CONFIGURED: 'Transporteur configure',
  WHATSAPP_CONFIGURED: 'Confirmation WhatsApp configuree',
  ACTIVATED: 'Boutique activee',
};

/** Etapes indispensables avant qu'une boutique puisse recevoir une vraie commande. */
export const REQUIRED_ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'ACCOUNT_CREATED',
  'STORE_CREATED',
  'ORDER_SOURCE_CONNECTED',
  'COLUMN_MAPPING_CONFIGURED',
  'TEST_IMPORT_PASSED',
];
