/**
 * Roles systeme EcomFlow et leur jeu de permissions par defaut.
 *
 * Source de verite : V1 §4, V2 §4, prompt produit §10.
 *
 * Les roles systeme sont seedes pour chaque tenant et ne peuvent pas etre
 * supprimes. Un tenant peut en revanche creer des roles personnalises
 * (`is_system = false`) et ajuster les permissions de ses roles non systeme.
 * Le jeu de permissions d'un role systeme reste modifiable par l'OWNER, a
 * l'exception du role OWNER lui-meme qui conserve toujours l'integralite des
 * permissions tenant (sinon une boutique pourrait se verrouiller elle-meme).
 */

import { PERMISSIONS, PLATFORM_PERMISSIONS, TENANT_PERMISSIONS, type Permission } from './permissions';

export const SYSTEM_ROLES = [
  'SUPER_ADMIN',
  'OWNER',
  'ADMIN',
  'MANAGER',
  'CONFIRMATION_AGENT',
  'PREPARER',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const SYSTEM_ROLE_LABELS: Record<SystemRole, string> = {
  SUPER_ADMIN: 'Super administrateur plateforme',
  OWNER: 'Proprietaire de la boutique',
  ADMIN: 'Administrateur boutique',
  MANAGER: 'Manager',
  CONFIRMATION_AGENT: 'Agent de confirmation',
  PREPARER: 'Preparateur',
};

export const SYSTEM_ROLE_DESCRIPTIONS: Record<SystemRole, string> = {
  SUPER_ADMIN: 'Administration globale de la plateforme SaaS : tenants, plans, paiements, incidents.',
  OWNER: 'Acces complet a la boutique, y compris facturation et suppression de donnees.',
  ADMIN: 'Acces complet a l operationnel de la boutique, sans gestion de l abonnement.',
  MANAGER: 'Pilotage operationnel et reporting, sans administration des utilisateurs.',
  CONFIRMATION_AGENT: 'Traitement de la file de confirmation telephonique.',
  PREPARER: 'Preparation des commandes confirmees et mise a disposition pour expedition.',
};

/**
 * Le role SUPER_ADMIN est un role de PLATEFORME : il n'est jamais rattache a un
 * tenant. Les autres roles sont instancies par tenant.
 */
export const PLATFORM_ROLES: readonly SystemRole[] = ['SUPER_ADMIN'];

export const TENANT_ROLES: readonly SystemRole[] = SYSTEM_ROLES.filter(
  (r) => !PLATFORM_ROLES.includes(r),
);

const P = PERMISSIONS;

const MANAGER_PERMISSIONS: readonly Permission[] = [
  P.ORDERS_READ,
  P.ORDERS_CREATE,
  P.ORDERS_UPDATE,
  P.ORDERS_CHANGE_STATUS,
  P.ORDERS_ASSIGN,
  P.ORDERS_EXPORT,
  P.ORDERS_MERGE_DUPLICATES,
  P.CONFIRMATION_MANAGE,
  P.CONFIRMATION_VIEW_ALL,
  P.CUSTOMERS_READ,
  P.CUSTOMERS_MANAGE,
  P.PRODUCTS_READ,
  P.PRODUCTS_MANAGE,
  P.INVENTORY_READ,
  P.INVENTORY_MANAGE,
  P.PREPARATION_MANAGE,
  P.SHIPMENTS_READ,
  P.SHIPMENTS_CREATE,
  P.SHIPMENTS_CANCEL,
  P.SHIPMENTS_TRACK,
  P.RETURNS_READ,
  P.RETURNS_MANAGE,
  P.DASHBOARD_VIEW,
  P.REPORTS_VIEW,
  P.REPORTS_EXPORT,
  P.PROFITABILITY_VIEW,
  P.USERS_READ,
  P.INTEGRATIONS_READ,
  P.NOTIFICATIONS_MANAGE,
];

const CONFIRMATION_AGENT_PERMISSIONS: readonly Permission[] = [
  P.ORDERS_READ,
  P.ORDERS_UPDATE,
  P.CONFIRMATION_MANAGE,
  P.CUSTOMERS_READ,
  P.CUSTOMERS_MANAGE,
  P.PRODUCTS_READ,
  P.INVENTORY_READ,
  P.DASHBOARD_VIEW,
];

const PREPARER_PERMISSIONS: readonly Permission[] = [
  P.ORDERS_READ,
  P.PREPARATION_MANAGE,
  P.PRODUCTS_READ,
  P.INVENTORY_READ,
  P.SHIPMENTS_READ,
  P.SHIPMENTS_CREATE,
  P.RETURNS_READ,
];

/**
 * ADMIN = toutes les permissions tenant sauf la gestion de l abonnement et la
 * suppression de la boutique. OWNER = toutes les permissions tenant.
 */
const ADMIN_EXCLUDED: readonly Permission[] = [P.BILLING_MANAGE];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  SUPER_ADMIN: PLATFORM_PERMISSIONS,
  OWNER: TENANT_PERMISSIONS,
  ADMIN: TENANT_PERMISSIONS.filter((p) => !ADMIN_EXCLUDED.includes(p)),
  MANAGER: MANAGER_PERMISSIONS,
  CONFIRMATION_AGENT: CONFIRMATION_AGENT_PERMISSIONS,
  PREPARER: PREPARER_PERMISSIONS,
};

/** Le role OWNER ne peut pas etre ampute : garde-fou anti auto-verrouillage. */
export const IMMUTABLE_ROLES: readonly SystemRole[] = ['OWNER', 'SUPER_ADMIN'];

export function isSystemRole(value: unknown): value is SystemRole {
  return typeof value === 'string' && (SYSTEM_ROLES as readonly string[]).includes(value);
}
