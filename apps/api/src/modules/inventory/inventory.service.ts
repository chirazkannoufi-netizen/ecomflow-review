/**
 * Gestion du stock — V1 §10, V2 §14.
 *
 * REGLE CENTRALE : toute variation de stock passe par ce service, et par lui
 * seul. Aucun autre module n'ecrit dans `inventory_levels`. C'est ce qui
 * permet de garantir l'invariant du cahier des charges — « les regles de
 * decrementation doivent etre centralisees afin d'eviter des ecarts entre
 * modules » (V2 §14).
 *
 * TROIS COMPTEURS, ET POURQUOI
 *   `onHand`     : marchandise physiquement detenue.
 *   `reserved`   : marchandise engagee sur des commandes confirmees mais pas
 *                  encore sortie de l'entrepot.
 *   `quarantine` : retours recus, en attente de controle qualite.
 *   Le stock DISPONIBLE a la vente vaut `onHand - reserved`. Distinguer les
 *   trois evite le piege classique du COD algerien : decrementer a la
 *   confirmation fausse l'inventaire physique, ne rien decrementer du tout
 *   conduit a survendre.
 *
 * CONCURRENCE
 *   La reservation utilise un UPDATE CONDITIONNEL atomique
 *   (`WHERE on_hand - reserved >= :quantite`). Deux confirmations simultanees
 *   sur le dernier article ne peuvent donc pas reussir toutes les deux : la
 *   seconde ne met a jour aucune ligne et echoue proprement. Une lecture
 *   suivie d'une ecriture laisserait au contraire une fenetre de course.
 *
 * JOURNAL
 *   Chaque variation produit une ligne `inventory_movements` immuable, avec
 *   l'etat resultant fige. L'historique permet de reconstituer le stock a
 *   n'importe quelle date et de reconcilier la projection.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { InventoryMovementType, InventoryReferenceType } from '@prisma/client';
import { ERROR_CODES } from '@ecomflow/shared';
import { InsufficientStockException, ValidationException } from '../../common/errors/business.exception';
import { NotFoundException } from '../../common/errors/business.exception';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';

export interface StockLine {
  readonly variantId: string;
  readonly quantity: number;
}

export interface StockShortage {
  readonly variantId: string;
  readonly sku: string;
  readonly requested: number;
  readonly available: number;
}

export interface MovementContext {
  readonly referenceType: InventoryReferenceType;
  readonly referenceId?: string | null;
  readonly actorId?: string | null;
  readonly note?: string | null;
}

export interface StockSnapshot {
  readonly variantId: string;
  readonly sku: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly quarantine: number;
  readonly available: number;
  readonly lowStockThreshold: number;
  readonly isLow: boolean;
}

/**
 * Ligne d'alerte de stock.
 *
 * Le SKU seul ne suffit pas : le commercant reconnait « Robe longue brodee —
 * Rouge / M », pas « ROB-001-M-RGE ». Le nom du produit accompagne donc
 * chaque alerte, et l'identifiant produit permet d'ouvrir la fiche.
 */
export interface LowStockEntry extends StockSnapshot {
  readonly variantLabel: string | null;
  readonly productId: string;
  readonly productName: string;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(@InjectPrisma() private readonly prisma: PrismaClientExtended) {}

  // ==========================================================================
  // LECTURE
  // ==========================================================================

  /**
   * Verifie la disponibilite d'un ensemble de lignes SANS rien reserver.
   * Utilise par la garde de workflow avant confirmation, pour produire un
   * message d'erreur precis plutot qu'un echec opaque au moment de l'ecriture.
   */
  async findShortages(
    tenantId: string,
    lines: readonly StockLine[],
    /**
     * Client a utiliser. Fournir la transaction en cours est INDISPENSABLE
     * lorsque le controle porte sur des lignes de commande creees dans cette
     * meme transaction : le client global ne verrait pas encore ces lignes.
     */
    client: PrismaClientExtended | PrismaTransactionClient = this.prisma,
  ): Promise<readonly StockShortage[]> {
    if (lines.length === 0) return [];

    // Plusieurs lignes peuvent porter la meme variante : on agrege d'abord,
    // sinon deux lignes de 3 unites passeraient le controle alors que le stock
    // n'en contient que 5.
    const demandByVariant = aggregate(lines);

    const levels = await client.inventoryLevel.findMany({
      where: { tenantId, variantId: { in: [...demandByVariant.keys()] } },
      select: {
        variantId: true,
        onHand: true,
        reserved: true,
        variant: { select: { sku: true } },
      },
    });

    const levelByVariant = new Map(levels.map((level) => [level.variantId, level]));
    const shortages: StockShortage[] = [];

    for (const [variantId, requested] of demandByVariant) {
      const level = levelByVariant.get(variantId);

      if (!level) {
        // Aucune ligne de stock : la variante n'a jamais recu d'entree.
        shortages.push({ variantId, sku: variantId, requested, available: 0 });
        continue;
      }

      const available = level.onHand - level.reserved;
      if (available < requested) {
        shortages.push({ variantId, sku: level.variant.sku, requested, available });
      }
    }

    return shortages;
  }

  /** Etat de stock d'une liste de variantes. */
  async getSnapshots(
    tenantId: string,
    variantIds: readonly string[],
  ): Promise<readonly StockSnapshot[]> {
    if (variantIds.length === 0) return [];

    const [settings, levels] = await Promise.all([
      this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { lowStockThreshold: true },
      }),
      this.prisma.inventoryLevel.findMany({
        where: { tenantId, variantId: { in: [...variantIds] } },
        select: {
          variantId: true,
          onHand: true,
          reserved: true,
          quarantine: true,
          variant: { select: { sku: true, lowStockThreshold: true } },
        },
      }),
    ]);

    const defaultThreshold = settings?.lowStockThreshold ?? 5;

    return levels.map((level) => {
      const available = level.onHand - level.reserved;
      const threshold = level.variant.lowStockThreshold ?? defaultThreshold;
      return {
        variantId: level.variantId,
        sku: level.variant.sku,
        onHand: level.onHand,
        reserved: level.reserved,
        quarantine: level.quarantine,
        available,
        lowStockThreshold: threshold,
        isLow: available <= threshold,
      };
    });
  }

  /** Variantes dont le stock disponible est sous le seuil d'alerte. */
  async listLowStock(tenantId: string, limit = 100): Promise<readonly LowStockEntry[]> {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { lowStockThreshold: true },
    });
    const defaultThreshold = settings?.lowStockThreshold ?? 5;

    // La comparaison porte sur `on_hand - reserved`, que Prisma ne sait pas
    // exprimer dans un `where`. La requete brute filtre explicitement sur
    // `tenant_id` : le garde d'isolation n'intercepte pas le SQL brut.
    const rows = await this.prisma.$queryRaw<
      {
        variant_id: string;
        sku: string;
        label: string | null;
        product_id: string;
        product_name: string;
        on_hand: number;
        reserved: number;
        quarantine: number;
        threshold: number | null;
      }[]
    >`
      SELECT l.variant_id, v.sku, v.label, p.id AS product_id, p.name AS product_name,
             l.on_hand, l.reserved, l.quarantine, v.low_stock_threshold AS threshold
      FROM inventory_levels l
      JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
      JOIN products p ON p.id = v.product_id AND p.tenant_id = v.tenant_id
      WHERE l.tenant_id = ${tenantId}::uuid
        AND v.archived_at IS NULL
        AND v.is_active = true
        AND p.archived_at IS NULL
        AND (l.on_hand - l.reserved) <= COALESCE(v.low_stock_threshold, ${defaultThreshold})
      ORDER BY (l.on_hand - l.reserved) ASC
      LIMIT ${limit}
    `;

    return rows.map((row) => {
      const available = row.on_hand - row.reserved;
      const threshold = row.threshold ?? defaultThreshold;
      return {
        variantId: row.variant_id,
        sku: row.sku,
        variantLabel: row.label,
        productId: row.product_id,
        productName: row.product_name,
        onHand: row.on_hand,
        reserved: row.reserved,
        quarantine: row.quarantine,
        available,
        lowStockThreshold: threshold,
        isLow: available <= threshold,
      };
    });
  }

  // ==========================================================================
  // ECRITURE
  // ==========================================================================

  /**
   * Reserve du stock pour une commande confirmee.
   *
   * @param allowOversell autorise la reservation meme sans stock suffisant
   *        (parametre de boutique `allowOversell`, desactive par defaut).
   * @throws InsufficientStockException en listant precisement ce qui manque.
   */
  async reserve(
    tx: PrismaTransactionClient,
    tenantId: string,
    lines: readonly StockLine[],
    context: MovementContext,
    allowOversell = false,
  ): Promise<void> {
    const demand = aggregate(lines);

    for (const [variantId, quantity] of demand) {
      const updated = allowOversell
        ? await this.increment(tx, tenantId, variantId, { reserved: quantity })
        : await this.reserveConditionally(tx, tenantId, variantId, quantity);

      if (!updated) {
        // Aucune ligne mise a jour : soit la variante n'existe pas dans cette
        // boutique, soit le stock disponible est insuffisant. On recalcule
        // pour distinguer les deux et produire un message utile.
        const shortages = await this.findShortages(tenantId, [{ variantId, quantity }]);
        throw new InsufficientStockException(
          shortages.map((shortage) => ({
            sku: shortage.sku,
            requested: shortage.requested,
            available: shortage.available,
          })),
        );
      }

      await this.recordMovement(tx, tenantId, variantId, 'RESERVATION', quantity, context, updated);
    }
  }

  /**
   * Libere une reservation (annulation d'une commande confirmee).
   *
   * Ne leve pas d'exception si la reservation n'existe plus : liberer deux
   * fois doit etre inoffensif. Une annulation rejouee — par un webhook
   * transporteur, par exemple — ne doit pas gonfler artificiellement le stock.
   */
  async releaseReservation(
    tx: PrismaTransactionClient,
    tenantId: string,
    lines: readonly StockLine[],
    context: MovementContext,
  ): Promise<void> {
    const demand = aggregate(lines);

    for (const [variantId, quantity] of demand) {
      const updated = await this.releaseConditionally(tx, tenantId, variantId, quantity);
      if (!updated) {
        this.logger.warn(
          `Liberation de reservation sans effet : variante=${variantId} quantite=${quantity}. ` +
            'La reservation avait probablement deja ete liberee.',
        );
        continue;
      }
      await this.recordMovement(
        tx,
        tenantId,
        variantId,
        'RESERVATION_RELEASE',
        quantity,
        context,
        updated,
      );
    }
  }

  /**
   * Sortie definitive de stock, au moment de l'expedition.
   * Consomme la reservation ET decremente le stock physique en une seule
   * operation atomique.
   */
  async commitOutbound(
    tx: PrismaTransactionClient,
    tenantId: string,
    lines: readonly StockLine[],
    context: MovementContext,
  ): Promise<void> {
    const demand = aggregate(lines);

    for (const [variantId, quantity] of demand) {
      const updated = await this.outboundConditionally(tx, tenantId, variantId, quantity);
      if (!updated) {
        throw new ValidationException(
          'Sortie de stock impossible : la reservation ou le stock physique est insuffisant.',
          { details: { variantId, quantity } },
        );
      }
      await this.recordMovement(tx, tenantId, variantId, 'OUTBOUND', quantity, context, updated);
    }
  }

  /** Entree en stock (reception fournisseur). */
  async inbound(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    quantity: number,
    context: MovementContext,
  ): Promise<void> {
    this.assertPositive(quantity);
    const updated = await this.increment(tx, tenantId, variantId, { onHand: quantity });
    if (!updated) throw this.variantNotFound(variantId);
    await this.recordMovement(tx, tenantId, variantId, 'INBOUND', quantity, context, updated);
  }

  /**
   * Traitement d'un retour.
   *
   * `RESTOCK` remet la marchandise en vente ; `QUARANTINE` la place en attente
   * de controle sans la rendre vendable. Le choix appartient au commercant
   * (V2 §18) : remettre systematiquement en stock un colis revenu apres
   * plusieurs jours de transport serait irresponsable.
   */
  async processReturn(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    quantity: number,
    decision: 'RESTOCK' | 'QUARANTINE',
    context: MovementContext,
  ): Promise<void> {
    this.assertPositive(quantity);

    const updated =
      decision === 'RESTOCK'
        ? await this.increment(tx, tenantId, variantId, { onHand: quantity })
        : await this.increment(tx, tenantId, variantId, { quarantine: quantity });

    if (!updated) throw this.variantNotFound(variantId);

    await this.recordMovement(
      tx,
      tenantId,
      variantId,
      decision === 'RESTOCK' ? 'RETURN_RESTOCK' : 'RETURN_QUARANTINE',
      quantity,
      context,
      updated,
    );
  }

  /**
   * Ajustement manuel (inventaire physique, casse, vol).
   *
   * @param delta variation signee du stock physique.
   */
  async adjust(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    delta: number,
    context: MovementContext,
  ): Promise<void> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new ValidationException('L ajustement doit etre un entier non nul.');
    }

    const updated = await this.increment(tx, tenantId, variantId, { onHand: delta });
    if (!updated) {
      // Un ajustement negatif refuse signifie que la contrainte CHECK a bloque
      // un stock negatif : on le dit explicitement plutot que « variante
      // introuvable », qui serait trompeur.
      const level = await tx.inventoryLevel.findFirst({
        where: { tenantId, variantId },
        select: { onHand: true },
      });
      if (level) {
        throw new ValidationException(
          `Ajustement refuse : le stock passerait a ${level.onHand + delta}, ` +
            'or un stock physique ne peut pas etre negatif.',
          { details: { current: level.onHand, delta } },
        );
      }
      throw this.variantNotFound(variantId);
    }

    await this.recordMovement(
      tx,
      tenantId,
      variantId,
      'ADJUSTMENT',
      Math.abs(delta),
      { ...context, note: context.note ?? `Ajustement de ${delta > 0 ? '+' : ''}${delta}` },
      updated,
    );
  }

  /** Cree la ligne de stock d'une nouvelle variante. */
  async initializeLevel(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    initialStock = 0,
  ): Promise<void> {
    await tx.inventoryLevel.create({
      data: { tenantId, variantId, onHand: initialStock, reserved: 0, quarantine: 0 },
    });

    if (initialStock > 0) {
      await this.recordMovement(
        tx,
        tenantId,
        variantId,
        'INBOUND',
        initialStock,
        { referenceType: 'MANUAL', note: 'Stock initial a la creation de la variante' },
        { onHand: initialStock, reserved: 0, quarantine: 0 },
      );
    }
  }

  // ==========================================================================
  // RECONCILIATION
  // ==========================================================================

  /**
   * Verifie que la projection `inventory_levels` correspond bien a la somme
   * des mouvements. Un ecart revele un bug d'ecriture ; le job de
   * reconciliation l'exploite pour alerter sans corriger silencieusement.
   */
  async findDiscrepancies(tenantId: string): Promise<
    { variantId: string; sku: string; projected: number; computed: number }[]
  > {
    return this.prisma.$queryRaw<
      { variantId: string; sku: string; projected: number; computed: number }[]
    >`
      WITH computed AS (
        SELECT
          m.variant_id,
          SUM(
            CASE m.type
              WHEN 'INBOUND'         THEN  m.quantity
              WHEN 'RETURN_RESTOCK'  THEN  m.quantity
              WHEN 'OUTBOUND'        THEN -m.quantity
              WHEN 'ADJUSTMENT'      THEN  0
              ELSE 0
            END
          )::int AS total
        FROM inventory_movements m
        WHERE m.tenant_id = ${tenantId}::uuid
        GROUP BY m.variant_id
      )
      SELECT
        l.variant_id AS "variantId",
        v.sku        AS "sku",
        l.on_hand    AS "projected",
        COALESCE(c.total, 0) AS "computed"
      FROM inventory_levels l
      JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
      LEFT JOIN computed c ON c.variant_id = l.variant_id
      WHERE l.tenant_id = ${tenantId}::uuid
        AND l.on_hand <> COALESCE(c.total, 0)
    `;
  }

  // ==========================================================================
  // Primitives d'ecriture atomiques
  // ==========================================================================

  /**
   * Reservation conditionnelle : ne reussit que si le stock disponible suffit.
   *
   * Le filtre `on_hand - reserved >= quantity` est evalue PAR POSTGRESQL dans
   * la meme instruction que l'ecriture. Aucune fenetre de course n'existe
   * entre la verification et la mise a jour, contrairement a un
   * `findUnique` suivi d'un `update`.
   *
   * Le filtre `tenant_id` est explicite : le SQL brut n'est pas intercepte par
   * le garde d'isolation.
   */
  private async reserveConditionally(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    quantity: number,
  ): Promise<LevelState | null> {
    this.assertPositive(quantity);

    const rows = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels
      SET reserved = reserved + ${quantity}, version = version + 1, updated_at = NOW()
      WHERE tenant_id = ${tenantId}::uuid
        AND variant_id = ${variantId}::uuid
        AND (on_hand - reserved) >= ${quantity}
      RETURNING on_hand AS "onHand", reserved, quarantine
    `;

    return rows[0] ?? null;
  }

  private async releaseConditionally(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    quantity: number,
  ): Promise<LevelState | null> {
    this.assertPositive(quantity);

    const rows = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels
      SET reserved = reserved - ${quantity}, version = version + 1, updated_at = NOW()
      WHERE tenant_id = ${tenantId}::uuid
        AND variant_id = ${variantId}::uuid
        AND reserved >= ${quantity}
      RETURNING on_hand AS "onHand", reserved, quarantine
    `;

    return rows[0] ?? null;
  }

  private async outboundConditionally(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    quantity: number,
  ): Promise<LevelState | null> {
    this.assertPositive(quantity);

    const rows = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels
      SET on_hand = on_hand - ${quantity},
          reserved = reserved - ${quantity},
          version = version + 1,
          updated_at = NOW()
      WHERE tenant_id = ${tenantId}::uuid
        AND variant_id = ${variantId}::uuid
        AND on_hand >= ${quantity}
        AND reserved >= ${quantity}
      RETURNING on_hand AS "onHand", reserved, quarantine
    `;

    return rows[0] ?? null;
  }

  /** Incrementation inconditionnelle d'un ou plusieurs compteurs. */
  private async increment(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    delta: { onHand?: number; reserved?: number; quarantine?: number },
  ): Promise<LevelState | null> {
    const rows = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels
      SET on_hand = on_hand + ${delta.onHand ?? 0},
          reserved = reserved + ${delta.reserved ?? 0},
          quarantine = quarantine + ${delta.quarantine ?? 0},
          version = version + 1,
          updated_at = NOW()
      WHERE tenant_id = ${tenantId}::uuid
        AND variant_id = ${variantId}::uuid
      RETURNING on_hand AS "onHand", reserved, quarantine
    `;

    return rows[0] ?? null;
  }

  private async recordMovement(
    tx: PrismaTransactionClient,
    tenantId: string,
    variantId: string,
    type: InventoryMovementType,
    quantity: number,
    context: MovementContext,
    state: LevelState,
  ): Promise<void> {
    await tx.inventoryMovement.create({
      data: {
        tenantId,
        variantId,
        type,
        quantity,
        referenceType: context.referenceType,
        referenceId: context.referenceId ?? null,
        actorId: context.actorId ?? null,
        note: context.note ?? null,
        onHandAfter: state.onHand,
        reservedAfter: state.reserved,
        quarantineAfter: state.quarantine,
      },
    });
  }

  private assertPositive(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationException(
        `Quantite de mouvement invalide : ${quantity}. Un entier strictement positif est attendu.`,
      );
    }
  }

  private variantNotFound(variantId: string): NotFoundException {
    return new NotFoundException(
      ERROR_CODES.VARIANT_NOT_FOUND,
      'Variante de produit introuvable dans cette boutique.',
      { details: { variantId } },
    );
  }
}

interface LevelState {
  readonly onHand: number;
  readonly reserved: number;
  readonly quarantine: number;
}

/** Forme brute renvoyee par PostgreSQL. */
type LevelRow = LevelState;

/**
 * Agrege les quantites par variante.
 * Indispensable : une commande peut contenir deux lignes portant la meme
 * variante, et les traiter separement ferait passer un controle de stock
 * qui devrait echouer.
 */
function aggregate(lines: readonly StockLine[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of lines) {
    result.set(line.variantId, (result.get(line.variantId) ?? 0) + line.quantity);
  }
  return result;
}

/** Reexporte pour les tests, qui verifient l'agregation. */
export const __testables = { aggregate };
