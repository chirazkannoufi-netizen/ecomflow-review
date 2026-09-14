/**
 * Structure de navigation, PARTAGEE entre la barre laterale et la barre
 * d'onglets de groupe.
 *
 * POURQUOI DANS SON PROPRE MODULE
 *   La barre d'onglets affiche les ecrans FRERES de l'ecran courant, au sens
 *   des groupes de la barre laterale. Definir ces groupes deux fois — une fois
 *   pour le menu, une fois pour les onglets — les ferait diverger a la
 *   premiere modification, et la divergence serait invisible : deux listes
 *   plausibles, qui ne disent pas la meme chose.
 */

import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bell,
  Boxes,
  Building2,
  ClipboardList,
  CreditCard,
  FileText,
  LayoutDashboard,
  MapPin,
  Package,
  PackageCheck,
  Phone,
  Plug,
  ScrollText,
  Settings,
  Trash2,
  TrendingUp,
  Truck,
  UserCog,
  Undo2,
  Users,
  Warehouse,
  Workflow,
} from 'lucide-react';
import { PERMISSIONS } from '@ecomflow/shared';

export interface NavEntry {
  /**
   * Route de l'entree, ou `null` tant que l'ecran n'existe pas.
   *
   * Une entree sans route est affichee, mais INERTE : elle tient sa place dans
   * la structure du menu sans conduire a un 404. Voir `NAVIGATION`.
   */
  readonly href: string | null;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  /** Permission requise pour afficher l'entree. */
  readonly permission?: string;
  /** Cle du compteur d'alerte a afficher en pastille. */
  readonly alertKey?: AlertKey;
  /**
   * Sous-entrees, pour les regroupements par etape de flux.
   *
   * Chaque enfant garde SA permission : le parent n'en impose aucune et
   * s'affiche des qu'un enfant au moins est autorise. C'est ce qui permet de
   * regrouper des ecrans sans retirer l'acces a un role qui n'en voit qu'un.
   */
  readonly children?: readonly NavEntry[];
}

export type AlertKey =
  | 'pendingConfirmation'
  | 'lowStock'
  | 'failedImports'
  | 'pendingDuplicates'
  | 'inPreparation'
  | 'inReturn';

/**
 * Navigation, dans les quatre groupes du systeme de design (Suite UI/UX v1.0,
 * ecrans 07 a 26) : MAIN, OPERATIONS, ANALYTICS, SYSTEM.
 *
 * Les entrees portent une CLE de traduction (`nav.orders`) et non un libelle :
 * c'est ce qui permet a la barre laterale de basculer en arabe sans dupliquer
 * la structure du menu.
 *
 * DES ENTREES A DEUX NIVEAUX, ET POURQUOI PAS DES ONGLETS
 *   « Traitement » et « Suivi » regroupent des ecrans par ETAPE DU FLUX, ce que
 *   la liste plate ne disait pas. Mais le regroupement est une affaire
 *   d'AFFICHAGE : chaque enfant garde sa route et SA PERMISSION.
 *
 *   Les fondre en onglets d'un seul ecran aurait coute l'acces a un role
 *   entier. Un preparateur a `PREPARATION_MANAGE` sans `CONFIRMATION_MANAGE` :
 *   des onglets sous un parent « Centre de confirmation » lui auraient fait
 *   disparaitre le seul ecran ou il travaille. Ici, le parent s'affiche des
 *   qu'UN enfant est autorise, et ne montre que ceux-la.
 *
 *   C'est aussi pourquoi les parents ne s'appellent pas « Centre de
 *   confirmation » : un intitule qui nomme l'etape d'un seul enfant ment aux
 *   autres.
 *
 * LES ECRANS NON CONSTRUITS RESTENT LISTES — `href: null`.
 *   Statistiques, Rapports, Notifications et Journal d'audit figurent au
 *   systeme de design sans avoir encore de route. Ils sont listes ICI plutot
 *   qu'omis : la place qu'ils occupent dans la hierarchie fait partie de la
 *   maquette, et un menu qui se reorganise a chaque ecran livre desoriente plus
 *   qu'il n'aide. Ils s'affichent estompes et non cliquables.
 *
 *   « En livraison » et « Livre » en faisaient partie ; elles ont desormais
 *   leurs routes. Les parents « Traitement » et « Suivi » gardent, eux, un
 *   `href: null` DEFINITIF : ce sont des regroupements, pas des ecrans.
 */
export const NAVIGATION: readonly { sectionKey: string; entries: readonly NavEntry[] }[] = [
  {
    sectionKey: 'main',
    entries: [
      { href: '/', labelKey: 'dashboard', icon: LayoutDashboard, permission: PERMISSIONS.DASHBOARD_VIEW },
      { href: '/commandes', labelKey: 'orders', icon: ClipboardList, permission: PERMISSIONS.ORDERS_READ },
      { href: '/clients', labelKey: 'customers', icon: Users, permission: PERMISSIONS.CUSTOMERS_READ },
    ],
  },
  {
    sectionKey: 'operations',
    entries: [
      { href: '/produits', labelKey: 'products', icon: Boxes, permission: PERMISSIONS.PRODUCTS_READ },
      {
        href: '/stock',
        labelKey: 'stock',
        icon: Warehouse,
        permission: PERMISSIONS.INVENTORY_READ,
        alertKey: 'lowStock',
      },
      {
        // Parent SANS permission propre : il apparait des qu'un enfant est
        // autorise. Un preparateur y verra « Preparation » et « Expeditions »,
        // un agent de confirmation y verra « Confirmation », et ni l'un ni
        // l'autre ne perd son ecran.
        href: null,
        labelKey: 'processing',
        icon: Workflow,
        children: [
          {
            href: '/confirmation',
            labelKey: 'confirmation',
            icon: Phone,
            permission: PERMISSIONS.CONFIRMATION_MANAGE,
            alertKey: 'pendingConfirmation',
          },
          {
            href: '/preparation',
            labelKey: 'preparation',
            icon: Package,
            permission: PERMISSIONS.PREPARATION_MANAGE,
            alertKey: 'inPreparation',
          },
          {
            href: '/expeditions',
            labelKey: 'shipments',
            icon: Truck,
            permission: PERMISSIONS.SHIPMENTS_READ,
          },
        ],
      },
      {
        href: null,
        labelKey: 'followUp',
        icon: MapPin,
        children: [
          // `SHIPMENTS_READ` et non `SHIPMENTS_TRACK`, qui les gardait tant
          // qu'elles n'avaient pas de route.
          //
          //   `SHIPMENTS_TRACK` est une permission d'ACTION — « declencher une
          //   synchronisation et appliquer les statuts ». Deux ecrans en
          //   lecture seule n'en declenchent aucune, et l'endpoint qui les
          //   alimente exige `SHIPMENTS_READ`. Un preparateur, qui a la
          //   seconde sans la premiere, voyait « Expeditions » — plus riche —
          //   mais pas ces deux-ci, pourtant strictement moins privilegiees.
          //   Personne n'avait eu a reconcilier les deux tant que l'entree ne
          //   menait nulle part. Voir D-065.
          {
            href: '/livraison',
            labelKey: 'inDelivery',
            icon: MapPin,
            permission: PERMISSIONS.SHIPMENTS_READ,
          },
          {
            href: '/livre',
            labelKey: 'delivered',
            icon: PackageCheck,
            permission: PERMISSIONS.SHIPMENTS_READ,
          },
          {
            href: '/retours',
            labelKey: 'returns',
            icon: Undo2,
            permission: PERMISSIONS.RETURNS_READ,
            alertKey: 'inReturn',
          },
        ],
      },
      {
        // Icone DISTINCTE de celle d'Expeditions, qui garde le camion.
        //
        //   Les deux entrees partageaient `Truck`. Or l'une est imbriquee sous
        //   « Traitement » et l'autre est au premier niveau : d'un coup d'oeil,
        //   le camion du bas — celui de Transporteurs — se lit comme un
        //   « Expeditions non indente ». Deux entrees voisines, meme pictogramme,
        //   deux profondeurs : l'oeil conclut au defaut d'imbrication.
        //
        //   Un transporteur est une SOCIETE, pas un colis : le batiment dit la
        //   difference sans qu'on ait a lire.
        //
        //   L'entree « Livreurs » qui la suivait a fusionne dedans (D-069) :
        //   deux entrees voisines pour le meme sujet obligeaient a savoir
        //   laquelle ouvrir avant de savoir ce qu'on cherchait.
        href: '/transporteurs',
        labelKey: 'carriers',
        icon: Building2,
        permission: PERMISSIONS.SHIPMENTS_READ,
      },
    ],
  },
  {
    sectionKey: 'analytics',
    entries: [
      { href: null, labelKey: 'statistics', icon: BarChart3, permission: PERMISSIONS.REPORTS_VIEW },
      {
        href: '/rentabilite',
        labelKey: 'profitability',
        icon: TrendingUp,
        permission: PERMISSIONS.PROFITABILITY_VIEW,
      },
      { href: null, labelKey: 'reports', icon: FileText, permission: PERMISSIONS.REPORTS_VIEW },
    ],
  },
  {
    sectionKey: 'system',
    entries: [
      {
        href: '/integrations',
        labelKey: 'integrations',
        icon: Plug,
        permission: PERMISSIONS.INTEGRATIONS_READ,
        alertKey: 'failedImports',
      },
      { href: '/utilisateurs', labelKey: 'users', icon: UserCog, permission: PERMISSIONS.USERS_READ },
      { href: '/abonnement', labelKey: 'subscription', icon: CreditCard, permission: PERMISSIONS.BILLING_VIEW },
      {
        href: null,
        labelKey: 'notifications',
        icon: Bell,
        permission: PERMISSIONS.NOTIFICATIONS_MANAGE,
      },
      {
        // La corbeille vit dans SYSTEME, a cote du journal d'audit : on y va
        // pour retrouver ou effacer, pas pour travailler.
        href: '/archive',
        labelKey: 'archive',
        icon: Trash2,
        permission: PERMISSIONS.ORDERS_READ,
      },
      { href: null, labelKey: 'auditLogs', icon: ScrollText, permission: PERMISSIONS.AUDIT_VIEW },
      { href: '/parametres', labelKey: 'settings', icon: Settings, permission: PERMISSIONS.SETTINGS_MANAGE },
    ],
  },
];

/**
 * Groupe de la barre laterale auquel appartient une route.
 *
 * Ne retourne un groupe que si la route est l'enfant d'une entree de
 * REGROUPEMENT : les ecrans de premier niveau — Produits, Stock, Clients — n'ont
 * pas de freres a proposer, et leur coiffer une barre d'onglets a une seule
 * entree serait du bruit.
 */
export function findGroupFor(pathname: string): NavEntry | null {
  for (const section of NAVIGATION) {
    for (const entry of section.entries) {
      if (!entry.children) continue;
      const match = entry.children.some(
        (child) => child.href !== null && pathname.startsWith(child.href),
      );
      if (match) return entry;
    }
  }
  return null;
}
