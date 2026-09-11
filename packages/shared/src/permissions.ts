/**
 * Catalogue des permissions EcomFlow.
 *
 * Source de verite : V2 §4 et §23, prompt produit §11.
 *
 * Regles de conception :
 *  - une permission = une capacite metier atomique, nommee `<domaine>.<action>` ;
 *  - les permissions sont stockees en base (table `permissions`) et rattachees aux
 *    roles via `role_permissions`, ce qui rend le modele configurable par tenant ;
 *  - ce fichier est la reference de seed : toute permission ajoutee ici est
 *    synchronisee en base par `prisma/seed.ts` (upsert, jamais de suppression
 *    silencieuse d'une permission deja rattachee a un role personnalise).
 */

export const PERMISSIONS = {
  // --- Commandes ---
  ORDERS_READ: 'orders.read',
  ORDERS_CREATE: 'orders.create',
  ORDERS_UPDATE: 'orders.update',
  ORDERS_DELETE: 'orders.delete',
  ORDERS_CHANGE_STATUS: 'orders.change_status',
  ORDERS_ASSIGN: 'orders.assign',
  ORDERS_EXPORT: 'orders.export',
  ORDERS_MERGE_DUPLICATES: 'orders.merge_duplicates',

  // --- Centre de confirmation ---
  CONFIRMATION_MANAGE: 'confirmation.manage',
  /** Voir la file complete du tenant, et pas seulement ses propres commandes. */
  CONFIRMATION_VIEW_ALL: 'confirmation.view_all',

  // --- Clients ---
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_MANAGE: 'customers.manage',
  CUSTOMERS_EXPORT: 'customers.export',

  // --- Catalogue ---
  PRODUCTS_READ: 'products.read',
  PRODUCTS_MANAGE: 'products.manage',

  // --- Stock ---
  INVENTORY_READ: 'inventory.read',
  INVENTORY_MANAGE: 'inventory.manage',

  // --- Preparation ---
  PREPARATION_MANAGE: 'preparation.manage',

  // --- Expedition & tracking ---
  SHIPMENTS_READ: 'shipments.read',
  SHIPMENTS_CREATE: 'shipments.create',
  SHIPMENTS_CANCEL: 'shipments.cancel',
  SHIPMENTS_TRACK: 'shipments.track',

  // --- Retours ---
  RETURNS_READ: 'returns.read',
  RETURNS_MANAGE: 'returns.manage',

  // --- Analyse ---
  DASHBOARD_VIEW: 'dashboard.view',
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',
  /** Dashboard Pertes & Rentabilite (Addendum §33) : donnee financiere sensible. */
  PROFITABILITY_VIEW: 'profitability.view',

  // --- Administration du tenant ---
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  INTEGRATIONS_READ: 'integrations.read',
  INTEGRATIONS_MANAGE: 'integrations.manage',
  IMPORTS_MANAGE: 'imports.manage',
  NOTIFICATIONS_MANAGE: 'notifications.manage',
  BILLING_VIEW: 'billing.view',
  BILLING_MANAGE: 'billing.manage',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',
  /**
   * Suppression DEFINITIVE depuis la page Archive.
   *
   * Distincte des permissions d'archivage (`ORDERS_DELETE`, `PRODUCTS_MANAGE`,
   * `CUSTOMERS_MANAGE`), qui ne font que retirer des listes. Celle-ci efface,
   * et rien ne la rattrape : elle est reservee au proprietaire de la boutique
   * par `ADMIN_EXCLUDED`, au meme titre que la gestion de l'abonnement.
   */
  DATA_PURGE: 'data.purge',

  // --- Administration plateforme (SUPER_ADMIN uniquement) ---
  PLATFORM_TENANTS_MANAGE: 'platform.tenants.manage',
  PLATFORM_PLANS_MANAGE: 'platform.plans.manage',
  PLATFORM_PAYMENTS_REVIEW: 'platform.payments.review',
  PLATFORM_TRIAL_REVIEW: 'platform.trial.review',
  PLATFORM_INCIDENTS_VIEW: 'platform.incidents.view',
  PLATFORM_AUDIT_VIEW: 'platform.audit.view',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type Permission = (typeof PERMISSIONS)[PermissionKey];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/** Permissions reservees a la plateforme : jamais attribuables a un role de tenant. */
export const PLATFORM_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter((p) =>
  p.startsWith('platform.'),
);

/** Permissions attribuables aux roles d'une boutique. */
export const TENANT_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) => !p.startsWith('platform.'),
);

export interface PermissionDescriptor {
  readonly key: Permission;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  /** Permission consideree sensible : mise en avant dans l'UI de gestion des roles. */
  readonly sensitive: boolean;
}

/** Metadonnees d'affichage, utilisees par l'ecran "Utilisateurs & roles". */
export const PERMISSION_CATALOG: readonly PermissionDescriptor[] = [
  { key: PERMISSIONS.ORDERS_READ, group: 'Commandes', label: 'Consulter les commandes', description: 'Acceder a la liste et au detail des commandes de la boutique.', sensitive: false },
  { key: PERMISSIONS.ORDERS_CREATE, group: 'Commandes', label: 'Creer une commande', description: 'Saisir manuellement une commande.', sensitive: false },
  { key: PERMISSIONS.ORDERS_UPDATE, group: 'Commandes', label: 'Modifier une commande', description: 'Modifier client, adresse, lignes produit et frais.', sensitive: false },
  { key: PERMISSIONS.ORDERS_DELETE, group: 'Commandes', label: 'Archiver une commande', description: 'Archiver une commande (suppression logique, historique conserve).', sensitive: true },
  { key: PERMISSIONS.ORDERS_CHANGE_STATUS, group: 'Commandes', label: 'Changer le statut', description: 'Appliquer une transition de workflow hors centre de confirmation.', sensitive: true },
  { key: PERMISSIONS.ORDERS_ASSIGN, group: 'Commandes', label: 'Affecter une commande', description: 'Assigner une commande a un utilisateur.', sensitive: false },
  { key: PERMISSIONS.ORDERS_EXPORT, group: 'Commandes', label: 'Exporter les commandes', description: 'Exporter les commandes en CSV, Excel ou PDF.', sensitive: true },
  { key: PERMISSIONS.ORDERS_MERGE_DUPLICATES, group: 'Commandes', label: 'Traiter les doublons', description: 'Conserver, fusionner ou annuler des commandes signalees en doublon.', sensitive: true },

  { key: PERMISSIONS.CONFIRMATION_MANAGE, group: 'Confirmation', label: 'Traiter la file de confirmation', description: 'Confirmer, rappeler, reporter, annuler ou signaler un numero incorrect.', sensitive: false },
  { key: PERMISSIONS.CONFIRMATION_VIEW_ALL, group: 'Confirmation', label: 'Voir toute la file', description: 'Voir les commandes affectees aux autres agents.', sensitive: false },

  { key: PERMISSIONS.CUSTOMERS_READ, group: 'Clients', label: 'Consulter les clients', description: 'Acceder aux fiches clients et a leur historique.', sensitive: false },
  { key: PERMISSIONS.CUSTOMERS_MANAGE, group: 'Clients', label: 'Gerer les clients', description: 'Modifier fiches, notes, tags et adresses.', sensitive: false },
  { key: PERMISSIONS.CUSTOMERS_EXPORT, group: 'Clients', label: 'Exporter les clients', description: 'Extraire des donnees personnelles clients.', sensitive: true },

  { key: PERMISSIONS.PRODUCTS_READ, group: 'Catalogue', label: 'Consulter le catalogue', description: 'Acceder aux produits et variantes.', sensitive: false },
  { key: PERMISSIONS.PRODUCTS_MANAGE, group: 'Catalogue', label: 'Gerer le catalogue', description: 'Creer et modifier produits, variantes, prix et images.', sensitive: false },

  { key: PERMISSIONS.INVENTORY_READ, group: 'Stock', label: 'Consulter le stock', description: 'Voir niveaux, reservations et mouvements.', sensitive: false },
  { key: PERMISSIONS.INVENTORY_MANAGE, group: 'Stock', label: 'Gerer le stock', description: 'Saisir entrees, ajustements et decisions de retour en stock.', sensitive: true },

  { key: PERMISSIONS.PREPARATION_MANAGE, group: 'Preparation', label: 'Preparer les commandes', description: 'Traiter la file de preparation et marquer prete a expedier.', sensitive: false },

  { key: PERMISSIONS.SHIPMENTS_READ, group: 'Expedition', label: 'Consulter les expeditions', description: 'Voir colis, transporteurs et tracking.', sensitive: false },
  { key: PERMISSIONS.SHIPMENTS_CREATE, group: 'Expedition', label: 'Creer un colis', description: 'Envoyer une commande au transporteur.', sensitive: true },
  { key: PERMISSIONS.SHIPMENTS_CANCEL, group: 'Expedition', label: 'Annuler un colis', description: 'Annuler un colis aupres du transporteur.', sensitive: true },
  { key: PERMISSIONS.SHIPMENTS_TRACK, group: 'Expedition', label: 'Synchroniser le tracking', description: 'Declencher une synchronisation de suivi et appliquer les statuts.', sensitive: false },

  { key: PERMISSIONS.RETURNS_READ, group: 'Retours', label: 'Consulter les retours', description: 'Acceder aux retours et a leurs motifs.', sensitive: false },
  { key: PERMISSIONS.RETURNS_MANAGE, group: 'Retours', label: 'Gerer les retours', description: 'Creer, qualifier et cloturer un retour.', sensitive: false },

  { key: PERMISSIONS.DASHBOARD_VIEW, group: 'Analyse', label: 'Voir le dashboard', description: 'Acceder aux KPIs operationnels.', sensitive: false },
  { key: PERMISSIONS.REPORTS_VIEW, group: 'Analyse', label: 'Voir les rapports', description: 'Acceder aux rapports detailles.', sensitive: false },
  { key: PERMISSIONS.REPORTS_EXPORT, group: 'Analyse', label: 'Exporter les rapports', description: 'Telecharger les rapports.', sensitive: true },
  { key: PERMISSIONS.PROFITABILITY_VIEW, group: 'Analyse', label: 'Voir Pertes & Rentabilite', description: 'Acceder aux marges, couts et pertes estimees.', sensitive: true },

  { key: PERMISSIONS.USERS_READ, group: 'Administration', label: 'Consulter les utilisateurs', description: 'Voir les membres de la boutique.', sensitive: false },
  { key: PERMISSIONS.USERS_MANAGE, group: 'Administration', label: 'Gerer les utilisateurs', description: 'Inviter, desactiver et changer le role des membres.', sensitive: true },
  { key: PERMISSIONS.ROLES_MANAGE, group: 'Administration', label: 'Gerer les roles', description: 'Creer des roles personnalises et ajuster les permissions.', sensitive: true },
  { key: PERMISSIONS.INTEGRATIONS_READ, group: 'Administration', label: 'Consulter les integrations', description: 'Voir l etat des connecteurs.', sensitive: false },
  { key: PERMISSIONS.INTEGRATIONS_MANAGE, group: 'Administration', label: 'Gerer les integrations', description: 'Connecter Google Sheets, transporteurs et webhooks.', sensitive: true },
  { key: PERMISSIONS.IMPORTS_MANAGE, group: 'Administration', label: 'Gerer les imports', description: 'Lancer des imports CSV/Excel et rejouer les lignes en erreur.', sensitive: true },
  { key: PERMISSIONS.NOTIFICATIONS_MANAGE, group: 'Administration', label: 'Gerer les notifications', description: 'Configurer canaux et preferences.', sensitive: false },
  { key: PERMISSIONS.BILLING_VIEW, group: 'Abonnement', label: 'Voir l abonnement', description: 'Consulter plan, essai et factures.', sensitive: false },
  { key: PERMISSIONS.BILLING_MANAGE, group: 'Abonnement', label: 'Gerer l abonnement', description: 'Souscrire, changer de plan et soumettre un paiement.', sensitive: true },
  { key: PERMISSIONS.DATA_PURGE, group: 'Systeme', label: 'Supprimer definitivement', description: 'Effacer des lignes archivees. Irreversible : aucune sauvegarde applicative ne les rattrape.', sensitive: true },
  { key: PERMISSIONS.SETTINGS_MANAGE, group: 'Administration', label: 'Gerer les parametres', description: 'Modifier les parametres de la boutique.', sensitive: true },
  { key: PERMISSIONS.AUDIT_VIEW, group: 'Administration', label: 'Consulter l audit', description: 'Lire le journal des actions sensibles de la boutique.', sensitive: true },

  { key: PERMISSIONS.PLATFORM_TENANTS_MANAGE, group: 'Plateforme', label: 'Gerer les boutiques', description: 'Administrer, suspendre et reactiver les tenants.', sensitive: true },
  { key: PERMISSIONS.PLATFORM_PLANS_MANAGE, group: 'Plateforme', label: 'Gerer les plans', description: 'Creer et modifier les plans tarifaires.', sensitive: true },
  { key: PERMISSIONS.PLATFORM_PAYMENTS_REVIEW, group: 'Plateforme', label: 'Valider les paiements manuels', description: 'Approuver ou refuser les justificatifs de paiement.', sensitive: true },
  { key: PERMISSIONS.PLATFORM_TRIAL_REVIEW, group: 'Plateforme', label: 'Revoir les essais suspects', description: 'Traiter la file de revue anti-abus du Trial.', sensitive: true },
  { key: PERMISSIONS.PLATFORM_INCIDENTS_VIEW, group: 'Plateforme', label: 'Voir les incidents', description: 'Consulter les incidents techniques de la plateforme.', sensitive: true },
  { key: PERMISSIONS.PLATFORM_AUDIT_VIEW, group: 'Plateforme', label: 'Audit global', description: 'Lire le journal d audit de toutes les boutiques.', sensitive: true },
];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export function isPlatformPermission(value: Permission): boolean {
  return value.startsWith('platform.');
}
