/**
 * Machine a etats des commandes EcomFlow.
 *
 * Source de verite : V2 §10 (workflow nominal + workflow alternatif), V1 §8,
 * Addendum §31 (canal de confirmation WhatsApp).
 *
 * Ce fichier est partage entre l'API et le front, mais l'AUTORITE d'execution
 * reste le backend : le front ne s'en sert que pour afficher les actions
 * plausibles. Toute transition est revalidee cote serveur
 * (voir apps/api/src/modules/orders/workflow/order-workflow.service.ts).
 */

export const ORDER_STATUSES = [
  // --- Workflow nominal ---
  'NEW',
  'TO_CONFIRM',
  'CONFIRMED',
  'IN_PREPARATION',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_DELIVERY',
  'DELIVERED',
  // --- Workflow alternatif ---
  'NO_ANSWER',
  'CALL_BACK',
  'POSTPONED',
  'WRONG_NUMBER',
  'CANCELLED',
  'REFUSED',
  'RETURNED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Libelles metier francais utilises dans l'UI et les exports. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'Nouvelle',
  TO_CONFIRM: 'A confirmer',
  CONFIRMED: 'Confirmee',
  IN_PREPARATION: 'En preparation',
  READY_TO_SHIP: 'Prete a expedier',
  SHIPPED: 'Expediee',
  IN_DELIVERY: 'En livraison',
  DELIVERED: 'Livree',
  NO_ANSWER: 'Sans reponse',
  CALL_BACK: 'A rappeler',
  POSTPONED: 'Reportee',
  WRONG_NUMBER: 'Numero incorrect',
  CANCELLED: 'Annulee',
  REFUSED: 'Refusee',
  RETURNED: 'Retournee',
};

/** Regroupement fonctionnel, utilise par le dashboard et les filtres rapides. */
export const ORDER_STATUS_GROUPS = {
  /** Commandes en attente de traitement par le centre de confirmation. */
  CONFIRMATION: ['NEW', 'TO_CONFIRM', 'NO_ANSWER', 'CALL_BACK', 'POSTPONED', 'WRONG_NUMBER'],
  /** Commandes validees, en cours de traitement logistique. */
  FULFILLMENT: ['CONFIRMED', 'IN_PREPARATION', 'READY_TO_SHIP'],
  /** Commandes confiees au transporteur. */
  TRANSIT: ['SHIPPED', 'IN_DELIVERY'],
  /** Issue positive. */
  SUCCESS: ['DELIVERED'],
  /** Issue negative (perte seche ou partielle). */
  FAILURE: ['CANCELLED', 'REFUSED', 'RETURNED'],
} as const satisfies Record<string, readonly OrderStatus[]>;

export type OrderStatusGroup = keyof typeof ORDER_STATUS_GROUPS;

/** Statuts terminaux : aucune transition sortante. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['CANCELLED', 'RETURNED'];

/**
 * Statuts consideres comme "traites" par le centre de confirmation.
 * Sert au calcul du taux de confirmation (V2 §20).
 */
export const PROCESSED_BY_CONFIRMATION_STATUSES: readonly OrderStatus[] = [
  'CONFIRMED',
  'IN_PREPARATION',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'REFUSED',
  'RETURNED',
  'WRONG_NUMBER',
];

/** Statuts qui alimentent la file de travail du centre de confirmation. */
export const CONFIRMATION_QUEUE_STATUSES: readonly OrderStatus[] = [
  'TO_CONFIRM',
  'NO_ANSWER',
  'CALL_BACK',
  'POSTPONED',
];

/** Statuts a partir desquels le stock est reserve pour la commande. */
export const STOCK_RESERVED_STATUSES: readonly OrderStatus[] = [
  'CONFIRMED',
  'IN_PREPARATION',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_DELIVERY',
];

/** Qui a le droit de declencher une transition. */
export type TransitionActorKind = 'USER' | 'SYSTEM';

/**
 * Garde metier evaluee cote backend avant d'autoriser la transition.
 * Le nom est un contrat : OrderWorkflowService implemente une fonction par garde.
 */
export type TransitionGuard =
  | 'REQUIRE_CUSTOMER_PHONE'
  | 'REQUIRE_DELIVERY_ADDRESS'
  | 'REQUIRE_AT_LEAST_ONE_ITEM'
  | 'REQUIRE_STOCK_AVAILABLE'
  | 'REQUIRE_PREPARATION_COMPLETED'
  | 'REQUIRE_ACTIVE_SHIPMENT'
  | 'REQUIRE_NO_ACTIVE_SHIPMENT'
  | 'REQUIRE_SUBSCRIPTION_OPERATIONAL';

export interface OrderTransitionRule {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  /** Permission requise lorsque l'acteur est un utilisateur. */
  readonly permission: string;
  /** Acteurs autorises. SYSTEM couvre les webhooks transporteur et les jobs. */
  readonly actors: readonly TransitionActorKind[];
  /** Une raison textuelle est obligatoire (annulation, refus, numero incorrect...). */
  readonly requiresReason: boolean;
  /** Gardes metier a satisfaire avant d'appliquer la transition. */
  readonly guards: readonly TransitionGuard[];
}

const P = {
  CHANGE_STATUS: 'orders.change_status',
  CONFIRMATION: 'confirmation.manage',
  PREPARE: 'preparation.manage',
  SHIP: 'shipments.create',
  TRACK: 'shipments.track',
  RETURNS: 'returns.manage',
} as const;

const CONFIRM_GUARDS: readonly TransitionGuard[] = [
  'REQUIRE_CUSTOMER_PHONE',
  'REQUIRE_DELIVERY_ADDRESS',
  'REQUIRE_AT_LEAST_ONE_ITEM',
  'REQUIRE_STOCK_AVAILABLE',
  'REQUIRE_SUBSCRIPTION_OPERATIONAL',
];

/** Statuts d'attente du centre de confirmation, qui partagent les memes sorties. */
const CALLBACK_STATUSES = ['NO_ANSWER', 'CALL_BACK', 'POSTPONED'] as const;

/** Sorties communes des statuts d'attente (hors auto-transition). */
function buildCallbackTransitions(): OrderTransitionRule[] {
  const rules: OrderTransitionRule[] = [];
  for (const from of CALLBACK_STATUSES) {
    rules.push({
      from,
      to: 'CONFIRMED',
      permission: P.CONFIRMATION,
      actors: ['USER', 'SYSTEM'],
      requiresReason: false,
      guards: CONFIRM_GUARDS,
    });
    rules.push({
      from,
      to: 'TO_CONFIRM',
      permission: P.CONFIRMATION,
      actors: ['USER', 'SYSTEM'],
      requiresReason: false,
      guards: [],
    });
    rules.push({
      from,
      to: 'WRONG_NUMBER',
      permission: P.CONFIRMATION,
      actors: ['USER'],
      requiresReason: false,
      guards: [],
    });
    rules.push({
      from,
      to: 'CANCELLED',
      permission: P.CONFIRMATION,
      actors: ['USER', 'SYSTEM'],
      requiresReason: true,
      guards: [],
    });
    rules.push({
      from,
      to: 'REFUSED',
      permission: P.CONFIRMATION,
      actors: ['USER'],
      requiresReason: false,
      guards: [],
    });
    // Passage lateral entre statuts d'attente (ex. NO_ANSWER -> CALL_BACK).
    for (const to of CALLBACK_STATUSES) {
      if (to === from) continue;
      rules.push({
        from,
        to,
        permission: P.CONFIRMATION,
        actors: ['USER'],
        requiresReason: false,
        guards: [],
      });
    }
  }
  return rules;
}

/**
 * Table exhaustive des transitions autorisees.
 * Toute paire (from,to) absente de cette table est INVALIDE.
 */
export const ORDER_TRANSITIONS: readonly OrderTransitionRule[] = [
  // --- Entree dans le circuit de confirmation ---
  {
    from: 'NEW',
    to: 'TO_CONFIRM',
    permission: P.CHANGE_STATUS,
    actors: ['USER', 'SYSTEM'],
    requiresReason: false,
    guards: ['REQUIRE_AT_LEAST_ONE_ITEM'],
  },
  {
    from: 'NEW',
    to: 'CANCELLED',
    permission: P.CHANGE_STATUS,
    actors: ['USER'],
    requiresReason: true,
    guards: [],
  },

  // --- Centre de confirmation ---
  {
    from: 'TO_CONFIRM',
    to: 'CONFIRMED',
    permission: P.CONFIRMATION,
    actors: ['USER', 'SYSTEM'],
    requiresReason: false,
    guards: CONFIRM_GUARDS,
  },
  {
    from: 'TO_CONFIRM',
    to: 'NO_ANSWER',
    permission: P.CONFIRMATION,
    actors: ['USER'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'TO_CONFIRM',
    to: 'CALL_BACK',
    permission: P.CONFIRMATION,
    actors: ['USER'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'TO_CONFIRM',
    to: 'POSTPONED',
    permission: P.CONFIRMATION,
    actors: ['USER'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'TO_CONFIRM',
    to: 'WRONG_NUMBER',
    permission: P.CONFIRMATION,
    actors: ['USER'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'TO_CONFIRM',
    to: 'CANCELLED',
    permission: P.CONFIRMATION,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },
  // REFUS DU CLIENT AU TELEPHONE — a ne pas confondre avec une annulation.
  //
  //   REFUSEE : le CLIENT a dit non. La vente ne s'est pas faite, mais rien
  //   n'a ete engage : c'est un manque a gagner, et le score de fiabilite du
  //   client doit s'en souvenir.
  //
  //   ANNULEE : la BOUTIQUE a renonce — rupture, doublon, erreur de saisie.
  //   La decision vient de nous, d'ou le motif obligatoire.
  //
  //   Le statut REFUSED existait deja, mais seulement en sortie de SHIPPED et
  //   IN_DELIVERY (refus du colis au pas de la porte). Les deux refus sont le
  //   meme fait — le client ne veut pas de la commande — a deux moments dont
  //   le COUT differe, et c'est le calcul de rentabilite qui fait la
  //   difference : il additionne les frais reellement engages, nuls tant
  //   qu'aucun colis n'est parti. Voir `computeOrderProfitability`.
  //
  // Aucun motif n'est exige, contrairement a l'annulation : le statut dit
  // deja tout ce qu'il y a a dire, et cet ecran se joue au clavier, cinquante
  // appels par jour.
  {
    from: 'TO_CONFIRM',
    to: 'REFUSED',
    permission: P.CONFIRMATION,
    actors: ['USER'],
    requiresReason: false,
    guards: [],
  },

  // --- Boucles de relance ---
  ...buildCallbackTransitions(),

  // --- Numero incorrect : correctible puis reinjecte en file ---
  {
    from: 'WRONG_NUMBER',
    to: 'TO_CONFIRM',
    permission: P.CONFIRMATION,
    actors: ['USER'],
    requiresReason: false,
    guards: ['REQUIRE_CUSTOMER_PHONE'],
  },
  {
    from: 'WRONG_NUMBER',
    to: 'CANCELLED',
    permission: P.CONFIRMATION,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },

  // --- Preparation ---
  {
    from: 'CONFIRMED',
    to: 'IN_PREPARATION',
    permission: P.PREPARE,
    actors: ['USER'],
    requiresReason: false,
    guards: ['REQUIRE_SUBSCRIPTION_OPERATIONAL'],
  },
  {
    from: 'CONFIRMED',
    to: 'CANCELLED',
    permission: P.CHANGE_STATUS,
    actors: ['USER'],
    requiresReason: true,
    guards: [],
  },
  /**
   * Retour au centre de confirmation.
   *
   * POURQUOI CETTE TRANSITION MANQUAIT, ET POURQUOI ELLE EST NECESSAIRE
   *   Une commande confirmee dont le preparateur decouvre un probleme — le
   *   client a change d'avis, l'adresse est fausse, l'article commande n'est
   *   pas celui qu'il voulait — n'avait aucun chemin de retour. Le seul geste
   *   disponible etait ANNULER, ce qui la comptait comme perdue dans tous les
   *   indicateurs et abimait le score de fiabilite du client, alors que
   *   personne n'avait renonce : il fallait seulement rappeler.
   *
   *   `requiresReason` est VRAI : un retour en file sans motif oblige
   *   l'agent suivant a rappeler le client pour decouvrir ce que le
   *   preparateur savait deja.
   *
   * LE STOCK EST LIBERE
   *   `CONFIRMED` reserve le stock, `TO_CONFIRM` non. Sans liberation, la
   *   marchandise resterait bloquee sur une commande qui n'est plus promise a
   *   personne. La bascule est portee par `STOCK_RESERVED_STATUSES`, que le
   *   moteur de workflow lit pour decider ; aucune garde supplementaire n'est
   *   donc necessaire ici.
   */
  {
    from: 'CONFIRMED',
    to: 'TO_CONFIRM',
    permission: P.CHANGE_STATUS,
    actors: ['USER'],
    requiresReason: true,
    guards: ['REQUIRE_SUBSCRIPTION_OPERATIONAL'],
  },
  {
    from: 'IN_PREPARATION',
    to: 'READY_TO_SHIP',
    permission: P.PREPARE,
    actors: ['USER'],
    requiresReason: false,
    guards: ['REQUIRE_PREPARATION_COMPLETED', 'REQUIRE_DELIVERY_ADDRESS'],
  },
  {
    from: 'IN_PREPARATION',
    to: 'CONFIRMED',
    permission: P.PREPARE,
    actors: ['USER'],
    requiresReason: true,
    guards: [],
  },
  {
    from: 'IN_PREPARATION',
    to: 'CANCELLED',
    permission: P.CHANGE_STATUS,
    actors: ['USER'],
    requiresReason: true,
    guards: [],
  },

  // --- Expedition ---
  {
    from: 'READY_TO_SHIP',
    to: 'SHIPPED',
    permission: P.SHIP,
    actors: ['USER', 'SYSTEM'],
    requiresReason: false,
    guards: ['REQUIRE_ACTIVE_SHIPMENT', 'REQUIRE_SUBSCRIPTION_OPERATIONAL'],
  },
  {
    from: 'READY_TO_SHIP',
    to: 'IN_PREPARATION',
    permission: P.PREPARE,
    actors: ['USER'],
    requiresReason: true,
    guards: ['REQUIRE_NO_ACTIVE_SHIPMENT'],
  },
  {
    from: 'READY_TO_SHIP',
    to: 'CANCELLED',
    permission: P.CHANGE_STATUS,
    actors: ['USER'],
    requiresReason: true,
    guards: ['REQUIRE_NO_ACTIVE_SHIPMENT'],
  },

  // --- Transit transporteur (majoritairement pilote par le tracking) ---
  {
    from: 'SHIPPED',
    to: 'IN_DELIVERY',
    permission: P.TRACK,
    actors: ['USER', 'SYSTEM'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'SHIPPED',
    to: 'DELIVERED',
    permission: P.TRACK,
    actors: ['USER', 'SYSTEM'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'SHIPPED',
    to: 'REFUSED',
    permission: P.TRACK,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },
  {
    from: 'SHIPPED',
    to: 'RETURNED',
    permission: P.RETURNS,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },
  {
    from: 'SHIPPED',
    to: 'CANCELLED',
    permission: P.CHANGE_STATUS,
    actors: ['USER'],
    requiresReason: true,
    guards: ['REQUIRE_NO_ACTIVE_SHIPMENT'],
  },
  {
    from: 'IN_DELIVERY',
    to: 'DELIVERED',
    permission: P.TRACK,
    actors: ['USER', 'SYSTEM'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'IN_DELIVERY',
    to: 'REFUSED',
    permission: P.TRACK,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },
  {
    from: 'IN_DELIVERY',
    to: 'RETURNED',
    permission: P.RETURNS,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },
  {
    from: 'IN_DELIVERY',
    to: 'POSTPONED',
    permission: P.TRACK,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },

  // --- Issues negatives ---
  {
    from: 'REFUSED',
    to: 'RETURNED',
    permission: P.RETURNS,
    actors: ['USER', 'SYSTEM'],
    requiresReason: false,
    guards: [],
  },
  {
    from: 'REFUSED',
    to: 'DELIVERED',
    permission: P.TRACK,
    actors: ['USER', 'SYSTEM'],
    requiresReason: true,
    guards: [],
  },
  {
    from: 'DELIVERED',
    to: 'RETURNED',
    permission: P.RETURNS,
    actors: ['USER'],
    requiresReason: true,
    guards: [],
  },
];

/** Index (from -> regles sortantes), construit une seule fois. */
const TRANSITION_INDEX: ReadonlyMap<OrderStatus, readonly OrderTransitionRule[]> = (() => {
  const map = new Map<OrderStatus, OrderTransitionRule[]>();
  for (const status of ORDER_STATUSES) map.set(status, []);
  for (const rule of ORDER_TRANSITIONS) {
    const bucket = map.get(rule.from);
    /* istanbul ignore next -- inatteignable : rule.from est un OrderStatus */
    if (!bucket) throw new Error(`Statut inconnu dans ORDER_TRANSITIONS : ${rule.from}`);
    bucket.push(rule);
  }
  return map;
})();

/** Retourne les transitions sortantes d'un statut. */
export function getOutgoingTransitions(from: OrderStatus): readonly OrderTransitionRule[] {
  return TRANSITION_INDEX.get(from) ?? [];
}

/** Retourne la regle exacte pour une paire (from,to), ou undefined si interdite. */
export function findTransition(from: OrderStatus, to: OrderStatus): OrderTransitionRule | undefined {
  return getOutgoingTransitions(from).find((rule) => rule.to === to);
}

/** Vrai si la transition existe pour l'acteur donne. */
export function isTransitionAllowed(
  from: OrderStatus,
  to: OrderStatus,
  actor: TransitionActorKind = 'USER',
): boolean {
  const rule = findTransition(from, to);
  return Boolean(rule && rule.actors.includes(actor));
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function getStatusGroup(status: OrderStatus): OrderStatusGroup {
  for (const [group, statuses] of Object.entries(ORDER_STATUS_GROUPS)) {
    if ((statuses as readonly OrderStatus[]).includes(status)) return group as OrderStatusGroup;
  }
  /* istanbul ignore next -- inatteignable : ORDER_STATUS_GROUPS couvre ORDER_STATUSES */
  throw new Error(`Statut de commande non groupe : ${status}`);
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}
