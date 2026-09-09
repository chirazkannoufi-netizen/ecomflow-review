import {
  CONFIRMATION_QUEUE_STATUSES,
  findTransition,
  getOutgoingTransitions,
  getStatusGroup,
  isOrderStatus,
  isTerminalStatus,
  isTransitionAllowed,
  ORDER_STATUSES,
  ORDER_STATUS_GROUPS,
  ORDER_STATUS_LABELS,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
  type OrderStatus,
} from './order-status';

describe('machine a etats des commandes', () => {
  describe('coherence du referentiel', () => {
    it('libelle chaque statut', () => {
      for (const status of ORDER_STATUSES) {
        expect(ORDER_STATUS_LABELS[status]).toBeTruthy();
      }
    });

    it('range chaque statut dans exactement un groupe', () => {
      for (const status of ORDER_STATUSES) {
        const groups = Object.entries(ORDER_STATUS_GROUPS).filter(([, list]) =>
          (list as readonly OrderStatus[]).includes(status),
        );
        expect(groups).toHaveLength(1);
      }
    });

    it('ne declare aucune transition vers un statut inconnu', () => {
      for (const rule of ORDER_TRANSITIONS) {
        expect(ORDER_STATUSES).toContain(rule.from);
        expect(ORDER_STATUSES).toContain(rule.to);
      }
    });

    it('ne declare aucune auto-transition', () => {
      const selfLoops = ORDER_TRANSITIONS.filter((rule) => rule.from === rule.to);
      expect(selfLoops).toEqual([]);
    });

    it('ne declare aucun doublon (from,to)', () => {
      const seen = new Set<string>();
      for (const rule of ORDER_TRANSITIONS) {
        const key = `${rule.from}->${rule.to}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });

    it('exige toujours au moins un acteur par transition', () => {
      for (const rule of ORDER_TRANSITIONS) {
        expect(rule.actors.length).toBeGreaterThan(0);
      }
    });

    it('rend les statuts terminaux reellement terminaux', () => {
      for (const status of TERMINAL_ORDER_STATUSES) {
        expect(getOutgoingTransitions(status)).toHaveLength(0);
        expect(isTerminalStatus(status)).toBe(true);
      }
    });

    it('rend tout statut non terminal atteignable depuis NEW', () => {
      const reachable = new Set<OrderStatus>(['NEW']);
      const queue: OrderStatus[] = ['NEW'];
      while (queue.length > 0) {
        const current = queue.shift() as OrderStatus;
        for (const rule of getOutgoingTransitions(current)) {
          if (!reachable.has(rule.to)) {
            reachable.add(rule.to);
            queue.push(rule.to);
          }
        }
      }
      for (const status of ORDER_STATUSES) {
        expect(reachable.has(status)).toBe(true);
      }
    });
  });

  describe('parcours nominal', () => {
    const nominal: readonly OrderStatus[] = [
      'NEW',
      'TO_CONFIRM',
      'CONFIRMED',
      'IN_PREPARATION',
      'READY_TO_SHIP',
      'SHIPPED',
      'IN_DELIVERY',
      'DELIVERED',
    ];

    it('autorise chaque etape du workflow principal', () => {
      for (let i = 0; i < nominal.length - 1; i += 1) {
        const from = nominal[i] as OrderStatus;
        const to = nominal[i + 1] as OrderStatus;
        expect(isTransitionAllowed(from, to)).toBe(true);
      }
    });

    it('interdit de sauter la confirmation', () => {
      expect(isTransitionAllowed('NEW', 'CONFIRMED')).toBe(false);
      expect(isTransitionAllowed('NEW', 'SHIPPED')).toBe(false);
      expect(isTransitionAllowed('TO_CONFIRM', 'SHIPPED')).toBe(false);
    });

    it('interdit de sauter la preparation avant expedition', () => {
      expect(isTransitionAllowed('CONFIRMED', 'SHIPPED')).toBe(false);
      expect(isTransitionAllowed('CONFIRMED', 'READY_TO_SHIP')).toBe(false);
    });

    it('interdit de revenir en arriere sur une commande livree', () => {
      expect(isTransitionAllowed('DELIVERED', 'SHIPPED')).toBe(false);
      expect(isTransitionAllowed('DELIVERED', 'CONFIRMED')).toBe(false);
    });

    it('interdit toute sortie depuis un statut terminal', () => {
      expect(isTransitionAllowed('CANCELLED', 'TO_CONFIRM')).toBe(false);
      expect(isTransitionAllowed('RETURNED', 'DELIVERED')).toBe(false);
    });
  });

  describe('gardes metier', () => {
    it('exige stock, telephone et adresse avant confirmation', () => {
      const rule = findTransition('TO_CONFIRM', 'CONFIRMED');
      expect(rule?.guards).toEqual(
        expect.arrayContaining([
          'REQUIRE_CUSTOMER_PHONE',
          'REQUIRE_DELIVERY_ADDRESS',
          'REQUIRE_AT_LEAST_ONE_ITEM',
          'REQUIRE_STOCK_AVAILABLE',
          'REQUIRE_SUBSCRIPTION_OPERATIONAL',
        ]),
      );
    });

    it('exige un colis actif pour passer a EXPEDIEE', () => {
      const rule = findTransition('READY_TO_SHIP', 'SHIPPED');
      expect(rule?.guards).toContain('REQUIRE_ACTIVE_SHIPMENT');
    });

    it('interdit d annuler une commande ayant un colis actif', () => {
      for (const from of ['READY_TO_SHIP', 'SHIPPED'] as const) {
        const rule = findTransition(from, 'CANCELLED');
        expect(rule?.guards).toContain('REQUIRE_NO_ACTIVE_SHIPMENT');
      }
    });

    it('exige une raison pour toute issue negative', () => {
      const negatives: readonly [OrderStatus, OrderStatus][] = [
        ['TO_CONFIRM', 'CANCELLED'],
        ['CONFIRMED', 'CANCELLED'],
        ['SHIPPED', 'REFUSED'],
        ['IN_DELIVERY', 'RETURNED'],
        ['DELIVERED', 'RETURNED'],
      ];
      for (const [from, to] of negatives) {
        expect(findTransition(from, to)?.requiresReason).toBe(true);
      }
    });

    it('n exige pas de raison pour une confirmation', () => {
      expect(findTransition('TO_CONFIRM', 'CONFIRMED')?.requiresReason).toBe(false);
    });
  });

  describe('acteurs autorises', () => {
    it('laisse le systeme appliquer les statuts remontes par le transporteur', () => {
      expect(isTransitionAllowed('SHIPPED', 'IN_DELIVERY', 'SYSTEM')).toBe(true);
      expect(isTransitionAllowed('IN_DELIVERY', 'DELIVERED', 'SYSTEM')).toBe(true);
      expect(isTransitionAllowed('IN_DELIVERY', 'RETURNED', 'SYSTEM')).toBe(true);
    });

    it('interdit au systeme de preparer une commande a la place d un humain', () => {
      expect(isTransitionAllowed('CONFIRMED', 'IN_PREPARATION', 'SYSTEM')).toBe(false);
      expect(isTransitionAllowed('IN_PREPARATION', 'READY_TO_SHIP', 'SYSTEM')).toBe(false);
    });

    it('laisse le filtre WhatsApp confirmer ou annuler automatiquement', () => {
      expect(isTransitionAllowed('TO_CONFIRM', 'CONFIRMED', 'SYSTEM')).toBe(true);
      expect(isTransitionAllowed('TO_CONFIRM', 'CANCELLED', 'SYSTEM')).toBe(true);
    });

    it('laisse le filtre WhatsApp rendre la main a un agent humain', () => {
      // Le repli vers la file d appel classique passe par TO_CONFIRM.
      for (const from of CONFIRMATION_QUEUE_STATUSES) {
        if (from === 'TO_CONFIRM') continue;
        expect(isTransitionAllowed(from, 'TO_CONFIRM', 'SYSTEM')).toBe(true);
      }
    });
  });

  describe('boucles de relance', () => {
    it('permet de passer d un statut d attente a un autre', () => {
      expect(isTransitionAllowed('NO_ANSWER', 'CALL_BACK')).toBe(true);
      expect(isTransitionAllowed('CALL_BACK', 'POSTPONED')).toBe(true);
      expect(isTransitionAllowed('POSTPONED', 'NO_ANSWER')).toBe(true);
    });

    it('permet de confirmer depuis n importe quel statut d attente', () => {
      for (const from of ['NO_ANSWER', 'CALL_BACK', 'POSTPONED'] as const) {
        expect(isTransitionAllowed(from, 'CONFIRMED')).toBe(true);
      }
    });

    it('permet de corriger un numero incorrect et de relancer la confirmation', () => {
      expect(isTransitionAllowed('WRONG_NUMBER', 'TO_CONFIRM')).toBe(true);
      expect(findTransition('WRONG_NUMBER', 'TO_CONFIRM')?.guards).toContain(
        'REQUIRE_CUSTOMER_PHONE',
      );
    });
  });

  describe('refus du client au telephone', () => {
    // Le refus existait uniquement APRES expedition (le client refuse le colis
    // au pas de la porte). Un client qui dit non AU TELEPHONE finissait donc en
    // ANNULEE, au milieu des commandes que la boutique avait elle-meme
    // retirees : impossible ensuite de savoir combien de clients refusent.
    it('est possible depuis chaque statut de la file de confirmation', () => {
      for (const from of ['TO_CONFIRM', 'NO_ANSWER', 'CALL_BACK', 'POSTPONED'] as const) {
        expect(isTransitionAllowed(from, 'REFUSED')).toBe(true);
      }
    });

    it('n exige pas de motif, contrairement a l annulation', () => {
      // Deux issues negatives, deux exigences differentes : le refus est
      // dicte par le client et se passe d'explication ; l'annulation est une
      // decision de la boutique, qui doit se justifier.
      expect(findTransition('TO_CONFIRM', 'REFUSED')?.requiresReason).toBe(false);
      expect(findTransition('TO_CONFIRM', 'CANCELLED')?.requiresReason).toBe(true);
    });

    it('reste reserve a un humain', () => {
      // Aucune automatisation ne doit pouvoir declarer qu'un client a refuse :
      // c'est une parole rapportee par un agent.
      expect(findTransition('TO_CONFIRM', 'REFUSED')?.actors).toEqual(['USER']);
    });

    it('demande la permission du centre de confirmation', () => {
      expect(findTransition('CALL_BACK', 'REFUSED')?.permission).toBe('confirmation.manage');
    });

    it('compte comme un echec, au meme titre qu apres expedition', () => {
      expect(getStatusGroup('REFUSED')).toBe('FAILURE');
    });
  });

  describe('utilitaires', () => {
    it('reconnait un statut valide', () => {
      expect(isOrderStatus('DELIVERED')).toBe(true);
      expect(isOrderStatus('LIVREE')).toBe(false);
      expect(isOrderStatus(42)).toBe(false);
      expect(isOrderStatus(null)).toBe(false);
    });

    it('classe les statuts par groupe fonctionnel', () => {
      expect(getStatusGroup('TO_CONFIRM')).toBe('CONFIRMATION');
      expect(getStatusGroup('READY_TO_SHIP')).toBe('FULFILLMENT');
      expect(getStatusGroup('IN_DELIVERY')).toBe('TRANSIT');
      expect(getStatusGroup('DELIVERED')).toBe('SUCCESS');
      expect(getStatusGroup('RETURNED')).toBe('FAILURE');
    });

    it('retourne undefined pour une transition inexistante', () => {
      expect(findTransition('NEW', 'DELIVERED')).toBeUndefined();
    });
  });
});
