/**
 * Service des commandes — creation, recherche, mise a jour.
 *
 * Point d'entree unique de la creation de commande, quelle qu'en soit la
 * source : saisie manuelle, import Google Sheets, import CSV, API partenaire.
 * Toutes empruntent le meme chemin, ce qui garantit que la normalisation, la
 * deduplication, l'allocation de reference et la detection de doublons
 * s'appliquent uniformement (V2 §12, §19).
 *
 * IDEMPOTENCE (V2 §12, §29, cahier de mission §15)
 *   Une commande provenant d'une source externe porte un `externalOrderId`.
 *   La contrainte UNIQUE `(tenant_id, source, external_order_id)` rend la
 *   recreation impossible en base — pas seulement improbable en applicatif.
 *   `createOrder` detecte le conflit et retourne la commande existante au lieu
 *   d'echouer : une resynchronisation est ainsi une operation NEUTRE.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { OrderSource, OrderStatus as PrismaOrderStatus, Prisma } from '@prisma/client';
import {
  DEFAULT_DUPLICATE_POLICY,
  ERROR_CODES,
  buildPageMeta,
  computeOrderTotal,
  findDuplicates,
  formatOrderReference,
  normalizeForComparison,
  parseAlgerianPhone,
  resolveWilaya,
  toSkipTake,
  type BulkArchiveResult,
  type BulkArchiveSkip,
  type DuplicateCandidateInput,
  type OrderStatus,
  type PreparationBulkAction,
  type OutOfStockBehavior,
  type Paginated,
} from '@ecomflow/shared';
import {
  BusinessException,
  ConflictException,
  InsufficientStockException,
  NotFoundException,
  ValidationException,
} from '../../common/errors/business.exception';
import { ClockService } from '../../infra/clock/clock.service';
import { InventoryService } from '../inventory/inventory.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { isUniqueConstraintError } from '../../infra/prisma/prisma.service';
import { CustomerStatsService } from '../customers/customer-stats.service';
import { OutboxService, DOMAIN_EVENTS } from '../events/outbox.service';
import { OrderWorkflowService } from './workflow/order-workflow.service';

export interface CreateOrderLine {
  /** Variante ciblee. Prioritaire sur `sku` lorsqu'elle est fournie. */
  readonly variantId?: string;
  /** SKU de variante, utilise par les imports qui ne connaissent pas les UUID. */
  readonly sku?: string;
  readonly quantity: number;
  /** Prix unitaire impose. A defaut, celui du catalogue est utilise. */
  readonly unitPriceCentimes?: number;
  readonly discountCentimes?: number;
}

export interface CreateOrderInput {
  readonly tenantId: string;
  readonly source: OrderSource;
  readonly externalOrderId?: string | null;

  readonly customerName: string;
  readonly phone: string;
  readonly wilaya: string | number;
  readonly commune: string;
  readonly addressText: string;

  readonly lines: readonly CreateOrderLine[];
  readonly deliveryFeeCentimes?: number;
  /** Total attendu par la source, pour controle de coherence. */
  readonly expectedTotalCentimes?: number | null;

  readonly notes?: string | null;
  readonly orderedAt?: Date;
  readonly assignedMembershipId?: string | null;
  readonly createdByMembershipId?: string | null;
}

export interface CreateOrderResult {
  readonly orderId: string;
  readonly reference: string;
  readonly customerId: string;
  /** Vrai si la commande existait deja (resynchronisation). */
  readonly alreadyExisted: boolean;
  /** Doublons potentiels signales, jamais supprimes automatiquement. */
  readonly duplicateFlags: readonly { candidateOrderId: string; score: number }[];
}

export interface OrderListFilters {
  readonly status?: readonly PrismaOrderStatus[];
  readonly source?: readonly OrderSource[];
  readonly wilayaCode?: number;
  readonly assignedMembershipId?: string;
  readonly carrierId?: string;
  readonly from?: Date;
  readonly to?: Date;
  /** Recherche globale : reference, nom, telephone, tracking, SKU. */
  readonly search?: string;
  readonly includeArchived?: boolean;
}

export interface OrderListOptions {
  readonly page?: number;
  readonly pageSize?: number;
  readonly sortBy?: 'createdAt' | 'orderedAt' | 'totalCentimes' | 'status';
  readonly sortDir?: 'asc' | 'desc';
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly workflow: OrderWorkflowService,
    private readonly customerStats: CustomerStatsService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
    private readonly inventory: InventoryService,
  ) {}

  // ==========================================================================
  // CREATION
  // ==========================================================================

  /**
   * Cree une commande, ou retourne l'existante si la ligne source a deja ete
   * importee.
   *
   * @throws ValidationException si les donnees sont inexploitables (telephone,
   *         wilaya, SKU inconnu, quantite invalide).
   */
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const normalized = this.normalizeInput(input);

    // --- Court-circuit d'idempotence ---------------------------------------
    // Verifier AVANT d'ouvrir la transaction evite d'engager du travail inutile
    // sur une resynchronisation, cas de loin le plus frequent.
    if (input.externalOrderId) {
      const existing = await this.prisma.order.findFirst({
        where: {
          tenantId: input.tenantId,
          source: input.source,
          externalOrderId: input.externalOrderId,
        },
        select: { id: true, reference: true, customerId: true },
      });

      if (existing) {
        return {
          orderId: existing.id,
          reference: existing.reference,
          customerId: existing.customerId,
          alreadyExisted: true,
          duplicateFlags: [],
        };
      }
    }

    try {
      return await this.prisma.$transaction(
        async (rawTx) => {
          const tx = rawTx as PrismaTransactionClient;
          return this.createWithin(tx, input, normalized);
        },
        { timeout: 20_000 },
      );
    } catch (error) {
      // Course perdue : deux synchronisations simultanees ont tente de creer la
      // meme ligne source. La contrainte UNIQUE a tranche ; on retourne la
      // commande gagnante plutot que de propager une erreur.
      if (isUniqueConstraintError(error, 'external_order_id') && input.externalOrderId) {
        const winner = await this.prisma.order.findFirst({
          where: {
            tenantId: input.tenantId,
            source: input.source,
            externalOrderId: input.externalOrderId,
          },
          select: { id: true, reference: true, customerId: true },
        });

        if (winner) {
          this.logger.log(
            `Creation concurrente detectee pour ${input.externalOrderId} : ` +
              `la commande ${winner.reference} fait foi.`,
          );
          return {
            orderId: winner.id,
            reference: winner.reference,
            customerId: winner.customerId,
            alreadyExisted: true,
            duplicateFlags: [],
          };
        }
      }
      throw error;
    }
  }

  private async createWithin(
    tx: PrismaTransactionClient,
    input: CreateOrderInput,
    normalized: NormalizedOrderInput,
  ): Promise<CreateOrderResult> {
    const orderedAt = input.orderedAt ?? this.clock.now();

    // --- 1. Client : retrouve par telephone, ou cree -----------------------
    const customer = await this.resolveCustomer(tx, input.tenantId, normalized);

    // --- 2. Adresse --------------------------------------------------------
    const address = await this.resolveAddress(tx, input.tenantId, customer.id, normalized);

    // --- 3. Lignes : resolution des variantes et des prix ------------------
    const lines = await this.resolveLines(tx, input.tenantId, input.lines);

    // --- 3 bis. Rupture de stock refusant l'ENREGISTREMENT meme -----------
    await this.assertNoIntakeRefusal(tx, input.tenantId, lines);

    const itemsTotal = lines.reduce((total, line) => total + line.lineTotalCentimes, 0);
    const deliveryFee = input.deliveryFeeCentimes ?? 0;
    const total = computeOrderTotal({
      itemsTotalCentimes: itemsTotal,
      deliveryFeeCentimes: deliveryFee,
    });

    // Le total fourni par la source est un CONTROLE, pas une autorite : si la
    // feuille contient une erreur de calcul, EcomFlow fait foi et le signale.
    if (
      input.expectedTotalCentimes !== null &&
      input.expectedTotalCentimes !== undefined &&
      input.expectedTotalCentimes !== total
    ) {
      this.logger.warn(
        `Total source incoherent pour ${input.externalOrderId ?? 'commande manuelle'} : ` +
          `attendu ${input.expectedTotalCentimes}, calcule ${total}. Le calcul EcomFlow fait foi.`,
      );
    }

    // --- 4. Reference ------------------------------------------------------
    const reference = await this.allocateReference(tx, input.tenantId, orderedAt);

    // --- 5. Commande -------------------------------------------------------
    const order = await tx.order.create({
      data: {
        tenantId: input.tenantId,
        reference,
        externalOrderId: input.externalOrderId ?? null,
        source: input.source,
        status: 'NEW',
        customerId: customer.id,
        addressId: address.id,
        customerNameSnapshot: normalized.customerName,
        phoneSnapshot: normalized.phoneE164,
        wilayaCodeSnapshot: normalized.wilayaCode,
        communeSnapshot: normalized.commune,
        addressSnapshot: normalized.addressText,
        itemsTotalCentimes: itemsTotal,
        deliveryFeeCentimes: deliveryFee,
        totalCentimes: total,
        notes: input.notes ?? null,
        assignedMembershipId: input.assignedMembershipId ?? null,
        orderedAt,
        items: {
          create: lines.map((line) => ({
            tenantId: input.tenantId,
            variantId: line.variantId,
            productNameSnapshot: line.productName,
            skuSnapshot: line.sku,
            variantLabelSnapshot: line.variantLabel,
            quantity: line.quantity,
            unitPriceCentimes: line.unitPriceCentimes,
            unitPurchasePriceCentimes: line.unitPurchasePriceCentimes,
            discountCentimes: line.discountCentimes,
            lineTotalCentimes: line.lineTotalCentimes,
          })),
        },
      },
      select: { id: true, reference: true },
    });

    await tx.orderStatusHistory.create({
      data: {
        tenantId: input.tenantId,
        orderId: order.id,
        oldStatus: null,
        newStatus: 'NEW',
        actorKind: input.createdByMembershipId ? 'USER' : 'SYSTEM',
        actorId: input.createdByMembershipId ?? null,
        source: `order-create:${input.source.toLowerCase()}`,
        createdAt: orderedAt,
      },
    });

    await this.customerStats.registerNewOrder(tx, customer.id, orderedAt);

    // --- 6. Entree dans la file de confirmation ---------------------------
    // La commande passe immediatement en A CONFIRMER : c'est le comportement
    // attendu (Annexe A de la V1). `NEW` n'est qu'un etat de reception.
    await this.workflow.transitionWithin(tx, {
      tenantId: input.tenantId,
      orderId: order.id,
      to: 'TO_CONFIRM',
      actorKind: 'SYSTEM',
      source: `order-create:${input.source.toLowerCase()}`,
    });

    // --- 7. Detection de doublons (signalement seul) ----------------------
    const duplicateFlags = await this.flagDuplicates(tx, input.tenantId, {
      orderId: order.id,
      phoneNormalized: normalized.phoneE164,
      customerNameNormalized: normalizeForComparison(normalized.customerName),
      wilayaCode: normalized.wilayaCode,
      addressNormalized: normalizeForComparison(normalized.addressText),
      skus: lines.map((line) => line.sku),
      totalCentimes: total,
      createdAt: orderedAt,
    });

    await this.outbox.publish(tx, {
      tenantId: input.tenantId,
      eventType: DOMAIN_EVENTS.ORDER_CREATED,
      payload: {
        orderId: order.id,
        reference: order.reference,
        source: input.source,
        totalCentimes: total,
        customerId: customer.id,
      },
    });

    return {
      orderId: order.id,
      reference: order.reference,
      customerId: customer.id,
      alreadyExisted: false,
      duplicateFlags: duplicateFlags.map((flag) => ({
        candidateOrderId: flag.candidateOrderId,
        score: flag.score,
      })),
    };
  }

  // ==========================================================================
  // NORMALISATION ET RESOLUTION
  // ==========================================================================

  private normalizeInput(input: CreateOrderInput): NormalizedOrderInput {
    const phone = parseAlgerianPhone(input.phone);
    if (!phone.ok) {
      throw new ValidationException(
        'Numero de telephone inexploitable. Format attendu : 0555 12 34 56.',
        { details: { field: 'phone', value: input.phone, reason: phone.error } },
      );
    }

    const wilaya = resolveWilaya(input.wilaya);
    if (!wilaya) {
      throw new ValidationException(
        `Wilaya inconnue : « ${input.wilaya} ». Utilisez le code (1 a 58) ou le nom officiel.`,
        { details: { field: 'wilaya', value: input.wilaya } },
      );
    }

    const customerName = input.customerName.trim();
    if (customerName.length === 0) {
      throw new ValidationException('Le nom du client est obligatoire.', {
        details: { field: 'customerName' },
      });
    }

    if (input.lines.length === 0) {
      throw new ValidationException('Une commande doit contenir au moins un article.', {
        details: { field: 'lines' },
      });
    }

    return {
      customerName,
      phoneE164: phone.value.e164,
      phoneRaw: String(input.phone),
      wilayaCode: wilaya.code,
      wilayaName: wilaya.name,
      commune: input.commune.trim(),
      addressText: input.addressText.trim(),
    };
  }

  /**
   * Retrouve le client par son telephone normalise, ou le cree.
   *
   * Le telephone est la cle metier du client dans la boutique (V2 §13). On ne
   * fusionne JAMAIS deux fiches automatiquement sur un autre critere : deux
   * homonymes existent, et fusionner leurs historiques fausserait leurs scores
   * de fiabilite respectifs.
   */
  private async resolveCustomer(
    tx: PrismaTransactionClient,
    tenantId: string,
    normalized: NormalizedOrderInput,
  ): Promise<{ id: string }> {
    const existing = await tx.customer.findFirst({
      where: { tenantId, phoneE164: normalized.phoneE164 },
      select: { id: true, fullName: true },
    });

    if (existing) {
      // Le nom n'est pas ecrase : le commercant a pu le corriger manuellement,
      // et une feuille de calcul mal tenue ne doit pas defaire ce travail.
      return { id: existing.id };
    }

    return tx.customer.create({
      data: {
        tenantId,
        fullName: normalized.customerName,
        phoneE164: normalized.phoneE164,
        phoneRaw: normalized.phoneRaw,
      },
      select: { id: true },
    });
  }

  /** Reutilise une adresse identique plutot que d'en accumuler des doublons. */
  private async resolveAddress(
    tx: PrismaTransactionClient,
    tenantId: string,
    customerId: string,
    normalized: NormalizedOrderInput,
  ): Promise<{ id: string }> {
    const addressNormalized = normalizeForComparison(normalized.addressText);

    const existing = await tx.address.findFirst({
      where: {
        tenantId,
        customerId,
        wilayaCode: normalized.wilayaCode,
        addressNormalized,
      },
      select: { id: true },
    });

    if (existing) return existing;

    const isFirst =
      (await tx.address.count({ where: { tenantId, customerId } })) === 0;

    return tx.address.create({
      data: {
        tenantId,
        customerId,
        wilayaCode: normalized.wilayaCode,
        wilayaName: normalized.wilayaName,
        commune: normalized.commune,
        addressText: normalized.addressText,
        addressNormalized,
        isDefault: isFirst,
      },
      select: { id: true },
    });
  }

  /**
   * Resout chaque ligne vers une variante du catalogue et fige son prix.
   *
   * Le prix d'achat est fige a la creation : c'est ce qui rend le calcul de
   * marge exact meme apres un changement de tarif fournisseur (Addendum §33).
   */
  private async resolveLines(
    tx: PrismaTransactionClient,
    tenantId: string,
    lines: readonly CreateOrderLine[],
  ): Promise<readonly ResolvedLine[]> {
    const resolved: ResolvedLine[] = [];

    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new ValidationException(
          `Quantite invalide : ${line.quantity}. Un entier strictement positif est attendu.`,
          { details: { field: 'quantity', value: line.quantity } },
        );
      }

      const variant = line.variantId
        ? await tx.productVariant.findFirst({
            where: { tenantId, id: line.variantId, archivedAt: null },
            select: variantSelection,
          })
        : line.sku
          ? await tx.productVariant.findFirst({
              where: { tenantId, sku: line.sku.trim(), archivedAt: null },
              select: variantSelection,
            })
          : null;

      if (!variant) {
        throw new ValidationException(
          line.sku
            ? `SKU introuvable dans le catalogue : « ${line.sku} ».`
            : 'Variante de produit introuvable.',
          { details: { field: 'sku', value: line.sku ?? line.variantId } },
        );
      }

      const unitPrice =
        line.unitPriceCentimes ??
        variant.salePriceCentimes ??
        variant.product.salePriceCentimes;

      if (unitPrice < 0) {
        throw new ValidationException('Le prix unitaire ne peut pas etre negatif.', {
          details: { field: 'unitPrice', value: unitPrice },
        });
      }

      const discount = line.discountCentimes ?? 0;
      const lineTotal = line.quantity * unitPrice - discount;

      if (lineTotal < 0) {
        throw new ValidationException(
          'La remise depasse le montant de la ligne.',
          { details: { unitPrice, quantity: line.quantity, discount } },
        );
      }

      resolved.push({
        variantId: variant.id,
        sku: variant.sku,
        productName: variant.product.name,
        variantLabel: variant.label,
        quantity: line.quantity,
        unitPriceCentimes: unitPrice,
        unitPurchasePriceCentimes:
          variant.purchasePriceCentimes ?? variant.product.purchasePriceCentimes,
        discountCentimes: discount,
        lineTotalCentimes: lineTotal,
        outOfStockBehavior: variant.outOfStockBehavior,
      });
    }

    return resolved;
  }

  /**
   * Refuse la commande AVANT enregistrement lorsqu'une variante l'exige.
   *
   * POURQUOI UN CONTROLE ICI, ALORS QU'IL EN EXISTE DEJA UN A LA CONFIRMATION
   *   Ce sont deux refus differents, et l'audit fonctionnel les distingue
   *   explicitement. « Refuser la confirmation » laisse la commande entrer :
   *   elle existe, elle est visible, un agent peut rappeler le client quand le
   *   reapprovisionnement arrive. « Refuser la commande » veut dire qu'elle ne
   *   doit pas entrer du tout — le cas d'un article qu'on ne veut surtout pas
   *   promettre.
   *
   *   Le second n'avait aucun point d'application : le seul controle de stock
   *   du produit se trouve dans la garde de transition, c'est-a-dire APRES la
   *   creation. Une variante reglee sur `REFUSE_ORDER` aurait donc eu
   *   exactement le meme effet que `REFUSE_CONFIRMATION`, et le reglage aurait
   *   menti a celui qui l'a choisi.
   *
   * SUR LES IMPORTS
   *   Une ligne de feuille refusee ici est comptee en echec et journalisee avec
   *   son motif, jamais ignoree en silence : le commercant doit pouvoir voir ce
   *   qui n'est pas entre, et pourquoi.
   */
  private async assertNoIntakeRefusal(
    tx: PrismaTransactionClient,
    tenantId: string,
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const guarded = lines.filter((line) => line.outOfStockBehavior === 'REFUSE_ORDER');
    if (guarded.length === 0) return;

    const shortages = await this.inventory.findShortages(
      tenantId,
      guarded.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      tx,
    );

    if (shortages.length === 0) return;

    throw new InsufficientStockException(
      shortages.map((shortage) => ({
        sku: shortage.sku,
        requested: shortage.requested,
        available: shortage.available,
      })),
    );
  }

  /**
   * Declare un colis PRET : enregistre les lignes comme preparees, puis bascule
   * le statut.
   *
   * LE DEFAUT QUE CETTE METHODE CORRIGE
   *   La transition `IN_PREPARATION -> READY_TO_SHIP` est gardee par
   *   `REQUIRE_PREPARATION_COMPLETED`, qui exige `preparedQuantity` sur chaque
   *   ligne. Or AUCUN code n'ecrivait jamais ce champ : il etait lu par la
   *   garde, affiche sur la fiche commande, et renseigne nulle part.
   *
   *   Consequence : le bouton « Colis pret » de l'ecran de preparation echouait
   *   systematiquement, avec un message — « toutes les lignes doivent etre
   *   preparees » — qui decrivait une action que l'interface n'offrait pas. La
   *   colonne du milieu etait un cul-de-sac.
   *
   * POURQUOI REMPLIR `preparedQuantity` PLUTOT QUE RETIRER LA GARDE
   *   La garde dit quelque chose de vrai : on ne ferme pas un colis sans avoir
   *   verifie son contenu. C'est le GESTE qui manquait, pas la regle.
   *   Declarer un colis pret EST l'affirmation que toutes les lignes y sont ;
   *   la methode l'enregistre donc explicitement, et la garde la verifie
   *   ensuite au lieu de la supposer.
   *
   *   Les lignes deja renseignees ne sont PAS ecrasees : le jour ou un ecran
   *   permettra de saisir une quantite partielle, cette saisie fera foi, et la
   *   garde refusera le colis incomplet — ce qui est exactement son role.
   */
  async markPreparationReady(
    tenantId: string,
    orderId: string,
    membershipId: string,
    permissions: ReadonlySet<string>,
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: { status: true },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    const move = (to: OrderStatus) =>
      this.workflow.transition({
        tenantId,
        orderId,
        to,
        actorKind: 'USER',
        membershipId,
        permissions,
        reason: null,
        note: null,
        source: 'ui',
      });

    // Une commande encore CONFIRMEE passe d'abord par la preparation : la
    // machine a etats ne connait pas de raccourci, et c'est deliberé — un colis
    // « pret » qui n'est jamais passe « en preparation » viderait de son sens
    // la colonne du milieu et fausserait tout indicateur de duree.
    if (order.status === 'CONFIRMED') await move('IN_PREPARATION');

    // `updateMany` ne sait pas copier une colonne dans une autre : on lit les
    // lignes a completer, puis on les ecrit. Le volume est celui d'une
    // commande, pas d'un catalogue.
    const pending = await this.prisma.orderItem.findMany({
      where: { tenantId, orderId, preparedQuantity: null },
      select: { id: true, quantity: true },
    });

    for (const item of pending) {
      await this.prisma.orderItem.update({
        where: { id: item.id },
        data: { preparedQuantity: item.quantity },
      });
    }

    await move('READY_TO_SHIP');
  }

  /**
   * Actions groupees de l'ecran de preparation.
   *
   * POURQUOI CES ACTIONS PASSENT PAR LE MOTEUR DE WORKFLOW, LIGNE PAR LIGNE
   *   Il aurait ete plus court d'ecrire un `updateMany` sur le statut. Ce
   *   raccourci aurait saute TOUT ce qui pend aux transitions : la reservation
   *   et la liberation du stock, l'historique append-only, les evenements
   *   sortants, les gardes d'abonnement. Le lot ne doit pas etre un chemin
   *   derobe vers un etat qu'un clic unitaire n'aurait pas permis.
   *
   * CHAQUE LIGNE EST INDEPENDANTE
   *   Une selection partiellement traitee est le cas NORMAL : une commande a pu
   *   changer d'etat entre l'affichage et le clic. On applique ce qui passe, on
   *   rend compte du reste avec son motif.
   */
  async bulkPreparationAction(input: {
    tenantId: string;
    action: PreparationBulkAction;
    orderIds: readonly string[];
    membershipId: string;
    permissions: ReadonlySet<string>;
    reason: string;
  }): Promise<BulkArchiveResult> {
    const done: string[] = [];
    const skipped: BulkArchiveSkip[] = [];

    for (const orderId of input.orderIds) {
      try {
        await this.applyPreparationAction(input, orderId);
        done.push(orderId);
      } catch (error) {
        if (error instanceof BusinessException) {
          skipped.push({ id: orderId, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }
    }

    return { archived: done.length, skipped };
  }

  private async applyPreparationAction(
    input: {
      tenantId: string;
      action: PreparationBulkAction;
      membershipId: string;
      permissions: ReadonlySet<string>;
      reason: string;
    },
    orderId: string,
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { tenantId: input.tenantId, id: orderId },
      select: { status: true },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    const move = (to: OrderStatus) =>
      this.workflow.transition({
        tenantId: input.tenantId,
        orderId,
        to,
        actorKind: 'USER',
        membershipId: input.membershipId,
        permissions: input.permissions,
        reason: input.reason,
        note: null,
        source: 'ui-bulk',
      });

    switch (input.action) {
      case 'RETURN_TO_CONFIRMATION':
        await move('TO_CONFIRM');
        return;

      case 'CANCEL_AND_ARCHIVE':
        // DEUX GESTES, ANNONCES COMME TELS DANS LE LIBELLE DU BOUTON.
        //   L'archivage exige que le stock ne soit plus reserve, ce qu'une
        //   commande confirmee ne respecte jamais. Annuler d'abord libere la
        //   marchandise ; archiver ensuite retire la ligne des listes.
        //
        //   L'ordre compte : archiver puis annuler laisserait une commande
        //   archivee dont le stock reste bloque si la seconde etape echoue.
        await move('CANCELLED');
        await this.archive(input.tenantId, orderId, input.membershipId);
        return;

      case 'MARK_READY':
        // EXACTEMENT le meme chemin que le bouton unitaire : enchainement des
        // transitions legales, et enregistrement des lignes preparees. Le lot
        // n'est pas un raccourci vers un etat qu'un clic n'aurait pas permis.
        await this.markPreparationReady(
          input.tenantId,
          orderId,
          input.membershipId,
          input.permissions,
        );
        return;

      default: {
        const exhaustive: never = input.action;
        throw new ValidationException(`Action inconnue : ${String(exhaustive)}`);
      }
    }
  }

  /**
   * Archive une SELECTION de commandes.
   *
   * POURQUOI UN RESULTAT DETAILLE PLUTOT QU'UN SUCCES GLOBAL
   *   Certaines commandes refusent l'archivage pour une raison metier — leur
   *   stock est encore reserve. Sur une selection de douze lignes, deux issues
   *   naives sont egalement mauvaises :
   *
   *     - tout annuler parce qu'une ligne resiste : l'agent recommence sans
   *       savoir laquelle ;
   *     - tout accepter en silence : l'agent croit avoir archive douze lignes,
   *       il en reste deux, et il ne s'en apercevra que plus tard.
   *
   *   On archive donc ce qui peut l'etre, et on REND COMPTE du reste, ligne par
   *   ligne, avec son motif. C'est la seule forme qui laisse l'agent decider de
   *   la suite.
   *
   * L'ORDRE N'IMPORTE PAS
   *   Chaque archivage est independant : aucune transaction englobante, donc
   *   aucun verrou tenu sur douze lignes pendant que la premiere se debat.
   */
  async archiveMany(
    tenantId: string,
    orderIds: readonly string[],
    membershipId: string,
  ): Promise<BulkArchiveResult> {
    const archived: string[] = [];
    const skipped: BulkArchiveSkip[] = [];

    for (const orderId of orderIds) {
      try {
        await this.archive(tenantId, orderId, membershipId);
        archived.push(orderId);
      } catch (error) {
        if (error instanceof BusinessException) {
          skipped.push({ id: orderId, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }
    }

    return { archived: archived.length, skipped };
  }

  /**
   * Alloue le prochain numero de reference pour (boutique, annee).
   *
   * `upsert` avec `increment` produit un `INSERT … ON CONFLICT DO UPDATE …
   * RETURNING` : l'allocation est atomique, deux imports concurrents ne peuvent
   * pas obtenir le meme numero.
   */
  private async allocateReference(
    tx: PrismaTransactionClient,
    tenantId: string,
    orderedAt: Date,
  ): Promise<string> {
    const year = orderedAt.getUTCFullYear();

    const sequence = await tx.orderSequence.upsert({
      where: { tenantId_year: { tenantId, year } },
      create: { tenantId, year, lastValue: 1 },
      update: { lastValue: { increment: 1 } },
      select: { lastValue: true },
    });

    return formatOrderReference(year, sequence.lastValue);
  }

  /**
   * Signale les doublons potentiels. NE SUPPRIME NI NE FUSIONNE JAMAIS :
   * la decision appartient a un utilisateur habilite (V1 §15, V2 §19).
   */
  private async flagDuplicates(
    tx: PrismaTransactionClient,
    tenantId: string,
    subject: DuplicateCandidateInput,
  ): Promise<readonly { candidateOrderId: string; score: number }[]> {
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId },
      select: {
        duplicateWindowHours: true,
        duplicateAlertScore: true,
        duplicateLikelyScore: true,
      },
    });

    const policy = {
      windowHours: settings?.duplicateWindowHours ?? DEFAULT_DUPLICATE_POLICY.windowHours,
      alertThreshold: settings?.duplicateAlertScore ?? DEFAULT_DUPLICATE_POLICY.alertThreshold,
      highConfidenceThreshold:
        settings?.duplicateLikelyScore ?? DEFAULT_DUPLICATE_POLICY.highConfidenceThreshold,
    };

    const since = new Date(subject.createdAt.getTime() - policy.windowHours * 3_600_000);

    // Seules les commandes du MEME client sont candidates : c'est le filtre le
    // plus selectif, et le telephone est de toute facon indispensable pour
    // atteindre le seuil d'alerte.
    const candidates = await tx.order.findMany({
      where: {
        tenantId,
        id: { not: subject.orderId },
        phoneSnapshot: subject.phoneNormalized ?? undefined,
        createdAt: { gte: since },
        archivedAt: null,
      },
      select: {
        id: true,
        phoneSnapshot: true,
        customerNameSnapshot: true,
        wilayaCodeSnapshot: true,
        addressSnapshot: true,
        totalCentimes: true,
        createdAt: true,
        items: { select: { skuSnapshot: true } },
      },
      take: 25,
      orderBy: { createdAt: 'desc' },
    });

    if (candidates.length === 0) return [];

    const matches = findDuplicates(
      subject,
      candidates.map((candidate) => ({
        orderId: candidate.id,
        phoneNormalized: candidate.phoneSnapshot,
        customerNameNormalized: normalizeForComparison(candidate.customerNameSnapshot),
        wilayaCode: candidate.wilayaCodeSnapshot,
        addressNormalized: normalizeForComparison(candidate.addressSnapshot),
        skus: candidate.items.map((item) => item.skuSnapshot),
        totalCentimes: candidate.totalCentimes,
        createdAt: candidate.createdAt,
      })),
      policy,
    );

    for (const match of matches) {
      await tx.orderDuplicateFlag.create({
        data: {
          tenantId,
          subjectOrderId: subject.orderId,
          candidateOrderId: match.candidateOrderId,
          score: match.score,
          confidence: match.confidence === 'LIKELY' ? 'LIKELY' : 'POSSIBLE',
          matchedRules: [...match.matchedRules],
          explanation: [...match.explanation],
        },
      });
    }

    if (matches.length > 0) {
      await this.outbox.publish(tx, {
        tenantId,
        eventType: DOMAIN_EVENTS.ORDER_DUPLICATE_DETECTED,
        payload: {
          orderId: subject.orderId,
          matches: matches.map((match) => ({
            candidateOrderId: match.candidateOrderId,
            score: match.score,
            confidence: match.confidence,
          })),
        },
      });
    }

    return matches.map((match) => ({
      candidateOrderId: match.candidateOrderId,
      score: match.score,
    }));
  }

  // ==========================================================================
  // LECTURE
  // ==========================================================================

  /** Liste paginee et filtree. Pagination cote serveur (V2 §22). */
  async list(
    tenantId: string,
    filters: OrderListFilters = {},
    options: OrderListOptions = {},
  ): Promise<Paginated<OrderListItem>> {
    const { skip, take } = toSkipTake(options);
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const where = this.buildWhere(tenantId, filters);

    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { [options.sortBy ?? 'createdAt']: options.sortDir ?? 'desc' },
        select: {
          id: true,
          reference: true,
          status: true,
          source: true,
          customerNameSnapshot: true,
          phoneSnapshot: true,
          wilayaCodeSnapshot: true,
          communeSnapshot: true,
          totalCentimes: true,
          orderedAt: true,
          createdAt: true,
          confirmationChannel: true,
          callAttemptsCount: true,
          nextCallbackAt: true,
          archivedAt: true,
          assignee: { select: { id: true, user: { select: { fullName: true } } } },
          items: { select: { skuSnapshot: true, productNameSnapshot: true, quantity: true } },
          shipments: {
            select: { trackingNumber: true, status: true, carrier: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          _count: { select: { duplicateFlagsAsSubject: { where: { resolution: 'PENDING' } } } },
        },
      }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        status: row.status,
        source: row.source,
        customerName: row.customerNameSnapshot,
        phone: row.phoneSnapshot,
        wilayaCode: row.wilayaCodeSnapshot,
        commune: row.communeSnapshot,
        totalCentimes: row.totalCentimes,
        orderedAt: row.orderedAt,
        createdAt: row.createdAt,
        confirmationChannel: row.confirmationChannel,
        callAttemptsCount: row.callAttemptsCount,
        nextCallbackAt: row.nextCallbackAt,
        archived: row.archivedAt !== null,
        assigneeName: row.assignee?.user.fullName ?? null,
        items: row.items.map((item) => ({
          sku: item.skuSnapshot,
          productName: item.productNameSnapshot,
          quantity: item.quantity,
        })),
        tracking: row.shipments[0]
          ? {
              number: row.shipments[0].trackingNumber,
              status: row.shipments[0].status,
              carrierName: row.shipments[0].carrier.name,
            }
          : null,
        pendingDuplicateFlags: row._count.duplicateFlagsAsSubject,
      })),
      meta: buildPageMeta(page, take, total),
    };
  }

  /** Fiche complete d'une commande, avec sa timeline (V1 §20). */
  async getById(tenantId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        customer: {
          select: {
            id: true,
            fullName: true,
            phoneE164: true,
            reliabilityScore: true,
            reliabilityTier: true,
            reliabilityFactors: true,
            ordersCount: true,
            deliveredCount: true,
            refusedCount: true,
            returnedCount: true,
            cancelledCount: true,
          },
        },
        address: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        callAttempts: { orderBy: { attemptNumber: 'asc' } },
        shipments: {
          orderBy: { createdAt: 'desc' },
          include: {
            carrier: { select: { code: true, name: true } },
            events: { orderBy: { occurredAt: 'desc' } },
          },
        },
        returns: { include: { items: true } },
        assignee: { select: { id: true, user: { select: { fullName: true } } } },
        duplicateFlagsAsSubject: {
          where: { resolution: 'PENDING' },
          include: {
            candidateOrder: {
              select: { id: true, reference: true, status: true, createdAt: true },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    return order;
  }

  private buildWhere(tenantId: string, filters: OrderListFilters): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = { tenantId };

    if (!filters.includeArchived) where.archivedAt = null;
    if (filters.status?.length) where.status = { in: [...filters.status] };
    if (filters.source?.length) where.source = { in: [...filters.source] };
    if (filters.wilayaCode !== undefined) where.wilayaCodeSnapshot = filters.wilayaCode;
    if (filters.assignedMembershipId) where.assignedMembershipId = filters.assignedMembershipId;
    if (filters.carrierId) where.shipments = { some: { carrierId: filters.carrierId } };

    if (filters.from || filters.to) {
      where.orderedAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }

    if (filters.search?.trim()) {
      const term = filters.search.trim();
      // Le telephone est normalise avant recherche : saisir « 0555 12 34 56 »
      // doit retrouver « +213555123456 ».
      const phone = parseAlgerianPhone(term);

      where.OR = [
        { reference: { contains: term, mode: 'insensitive' } },
        { customerNameSnapshot: { contains: term, mode: 'insensitive' } },
        { communeSnapshot: { contains: term, mode: 'insensitive' } },
        { externalOrderId: { contains: term, mode: 'insensitive' } },
        { phoneSnapshot: { contains: phone.ok ? phone.value.e164 : term } },
        { items: { some: { skuSnapshot: { contains: term, mode: 'insensitive' } } } },
        { items: { some: { productNameSnapshot: { contains: term, mode: 'insensitive' } } } },
        { shipments: { some: { trackingNumber: { contains: term, mode: 'insensitive' } } } },
      ];
    }

    return where;
  }

  // ==========================================================================
  // MISE A JOUR
  // ==========================================================================

  /** Affecte une commande a un membre de la boutique. */
  async assign(
    tenantId: string,
    orderId: string,
    membershipId: string | null,
  ): Promise<void> {
    if (membershipId) {
      const membership = await this.prisma.membership.findFirst({
        where: { tenantId, id: membershipId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!membership) {
        throw new ValidationException(
          'Cet utilisateur n est pas un membre actif de la boutique.',
        );
      }
    }

    const updated = await this.prisma.order.updateMany({
      where: { tenantId, id: orderId, archivedAt: null },
      data: { assignedMembershipId: membershipId },
    });

    if (updated.count === 0) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }
  }

  /**
   * Archive une commande (suppression LOGIQUE).
   *
   * L'historique metier n'est jamais detruit (V2 §38 : « ne pas supprimer
   * l'historique metier important »). Une commande archivee disparait des
   * listes et des KPI, mais reste consultable et restaurable.
   */
  async archive(tenantId: string, orderId: string, membershipId: string): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: { status: true, stockReserved: true, stockReleased: true },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    // Archiver une commande dont le stock est encore reserve laisserait de la
    // marchandise bloquee indefiniment.
    if (order.stockReserved && !order.stockReleased) {
      throw new ConflictException(
        ERROR_CODES.CONFLICT,
        'Annulez d abord la commande : son stock est encore reserve.',
      );
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { archivedAt: this.clock.now(), assignedMembershipId: membershipId },
    });
  }

  /** Tranche un signalement de doublon (V1 §15 : conserver / fusionner / annuler). */
  async resolveDuplicateFlag(
    tenantId: string,
    flagId: string,
    resolution: 'KEPT_BOTH' | 'MERGED' | 'CANCELLED_DUPLICATE',
    membershipId: string,
  ): Promise<void> {
    const updated = await this.prisma.orderDuplicateFlag.updateMany({
      where: { tenantId, id: flagId, resolution: 'PENDING' },
      data: { resolution, resolvedByMembershipId: membershipId, resolvedAt: this.clock.now() },
    });

    if (updated.count === 0) {
      throw new NotFoundException(
        ERROR_CODES.NOT_FOUND,
        'Signalement introuvable ou deja traite.',
      );
    }
  }
}

// ---------------------------------------------------------------------------

const variantSelection = {
  id: true,
  sku: true,
  label: true,
  salePriceCentimes: true,
  purchasePriceCentimes: true,
  outOfStockBehavior: true,
  product: { select: { name: true, salePriceCentimes: true, purchasePriceCentimes: true } },
} as const;

interface NormalizedOrderInput {
  readonly customerName: string;
  readonly phoneE164: string;
  readonly phoneRaw: string;
  readonly wilayaCode: number;
  readonly wilayaName: string;
  readonly commune: string;
  readonly addressText: string;
}

interface ResolvedLine {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly variantLabel: string | null;
  readonly quantity: number;
  readonly unitPriceCentimes: number;
  readonly unitPurchasePriceCentimes: number | null;
  readonly discountCentimes: number;
  readonly lineTotalCentimes: number;
  readonly outOfStockBehavior: OutOfStockBehavior;
}

export interface OrderListItem {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly totalCentimes: number;
  readonly orderedAt: Date;
  readonly createdAt: Date;
  readonly confirmationChannel: string;
  readonly callAttemptsCount: number;
  readonly nextCallbackAt: Date | null;
  readonly archived: boolean;
  readonly assigneeName: string | null;
  readonly items: readonly { sku: string; productName: string; quantity: number }[];
  readonly tracking: { number: string | null; status: string; carrierName: string } | null;
  readonly pendingDuplicateFlags: number;
}
