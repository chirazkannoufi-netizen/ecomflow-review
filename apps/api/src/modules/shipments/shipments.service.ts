/**
 * Creation et suivi des colis — V1 §12/§13, V2 §15/§16/§17.
 *
 * DEUX GARANTIES CENTRALES
 *
 *  1. JAMAIS DEUX COLIS POUR UNE MEME COMMANDE (V2 §17).
 *     Trois barrieres se combinent :
 *       a. un index UNIQUE PARTIEL en base sur `(tenant_id, order_id)` limite
 *          aux colis actifs ;
 *       b. une cle d'idempotence DETERMINISTE, derivee de la commande et du
 *          transporteur, transmise au connecteur : un rejeu apres un delai
 *          depasse ne cree pas de second colis chez le transporteur ;
 *       c. une verification applicative en amont, qui produit un message clair
 *          plutot qu'une violation de contrainte.
 *
 *  2. UNE ERREUR TRANSPORTEUR NE CORROMPT JAMAIS L'ETAT METIER
 *     (cahier de mission §46). L'appel externe a lieu HORS TRANSACTION : une
 *     API lente ne tient pas une transaction PostgreSQL ouverte pendant vingt
 *     secondes. Le colis est d'abord enregistre en `CREATION_PENDING`, puis
 *     mis a jour selon la reponse. Si le processus tombe entre les deux, le
 *     colis reste visible en attente et un job de reconciliation le rattrape —
 *     il n'y a jamais de colis cree chez le transporteur sans trace locale.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CarrierAccountKind, Prisma } from '@prisma/client';
import {
  ACTIVE_SHIPMENT_STATUSES,
  ERROR_CODES,
  buildPageMeta,
  getWilayaByCode,
  toSkipTake,
  type BulkArchiveResult,
  type BulkArchiveSkip,
  type Paginated,
  type ShipmentStatus,
} from '@ecomflow/shared';
import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import {
  BusinessException,
  ConflictException,
  NotFoundException,
  ValidationException,
} from '../../common/errors/business.exception';
import { ClockService } from '../../infra/clock/clock.service';
import { EncryptionService } from '../../infra/crypto/encryption.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';
import { isUniqueConstraintError } from '../../infra/prisma/prisma.service';
import { OutboxService, DOMAIN_EVENTS } from '../events/outbox.service';
import { OrderWorkflowService } from '../orders/workflow/order-workflow.service';
import { OrdersService } from '../orders/orders.service';
import { CarrierRegistry } from './carriers/carrier.registry';
import type {
  CarrierContext,
  CarrierHealth,
  ShipmentRequest,
} from './carriers/carrier-adapter.interface';

/**
 * Cles de la matrice de capacites, dans l'ordre d'affichage.
 *
 * Cette liste est le CONTRAT entre le schema et l'interface : elle doit rester
 * alignee sur les colonnes de `CarrierCapability`, ce qu'un test unitaire
 * verifie (`carrier-capabilities.spec.ts`). Sans elle, l'ecran afficherait les
 * capacites dans l'ordre alphabetique des colonnes Prisma, qui ne veut rien
 * dire pour un exploitant.
 *
 * L'ORDRE SUIT CELUI DE L'AUDIT, qui va du geste le plus courant (deposer une
 * commande) au plus rare (confier son stock). Les intitules aussi : voir le
 * commentaire du modele et D-049.
 */
export const CARRIER_CAPABILITY_KEYS = [
  // Commandes
  'addOrder',
  'addOrderBulk',
  'deleteOrder',
  'printableLabel',
  // Synchronisation relevee
  'syncAttempted',
  'syncDelivered',
  'syncFailed',
  // Synchronisation poussee
  'realtimeUndeliverableWilayas',
  'realtimeAttempted',
  'realtimeDelivered',
  'realtimeFailed',
  'realtimeCollectionVouchers',
  'realtimeAddressChange',
  'realtimePriceChange',
  // Livraison et SAV
  'stopDesk',
  'afterSalesExchange',
  'afterSalesPickup',
  // Logistique
  'stockAtCarrier',
] as const;

export type CarrierCapabilityKey = (typeof CARRIER_CAPABILITY_KEYS)[number];

export interface CarrierCatalogueEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly implementationStatus: string;
  /** `null` = capacites non renseignees, a distinguer de « tout a faux ». */
  readonly capabilities: Record<string, boolean> | null;
  readonly coveredWilayas: number;
}

export interface CarrierCoverageEntry {
  readonly wilayaCode: number;
  readonly wilayaName: string;
  readonly homeDelivery: boolean;
  readonly pickupPoint: boolean;
  readonly leadTimeDays: number | null;
}

/**
 * Statuts ou le colis n'existe pas encore, donc ou le transporteur reste un
 * CHOIX revisable. Au-dela, c'est le colis qui fait foi.
 */
const PRE_SHIPMENT_STATUSES: readonly string[] = [
  'CONFIRMED',
  'IN_PREPARATION',
  'READY_TO_SHIP',
];

/**
 * Etat d'encaissement d'une commande livree.
 *
 * `UNSUPPORTED` n'est pas un cas d'erreur : c'est la reponse honnete quand le
 * transporteur ne publie pas la donnee. Le confondre avec `PENDING` ferait
 * lire une creance la ou il n'y a qu'une ignorance — et inversement, masquer
 * `PENDING` ferait perdre de l'argent.
 */
export type CollectionState =
  | { readonly kind: 'COLLECTED'; readonly amountCentimes: number; readonly collectedAt: Date; readonly reference: string | null }
  | { readonly kind: 'PENDING' }
  | { readonly kind: 'UNSUPPORTED' }
  | { readonly kind: 'UNKNOWN' };

/** Un transporteur du catalogue, tel que le formulaire de compte le presente. */
export interface CarrierConnectorOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly implementationStatus: string;
  /**
   * Peut-on creer un compte chez lui ?
   *
   * Faux pour les transporteurs PREVUS : leurs capacites sont declarees par
   * leur documentation, pas verifiees, et `CarrierRegistry` refuserait tout
   * appel a l'execution. Voir D-066.
   */
  readonly selectable: boolean;
  /** Champs a saisir, declares par le connecteur lui-meme. */
  readonly credentialFields: readonly {
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    helpText?: string;
  }[];
}

export interface DeliveryQueueItem {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly customerName: string;
  readonly phone: string;
  readonly wilayaCode: number | null;
  readonly commune: string | null;
  readonly totalCentimes: number;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
  readonly providerStatus: string | null;
  /** Nombre de tentatives de livraison ECHOUEES, conservees une par une. */
  readonly failedAttempts: number;
  readonly lastAttemptAt: Date | null;
  readonly collection: CollectionState;
}

function resolveCollectionState(
  shipment:
    | {
        collectedCentimes: number | null;
        collectedAt: Date | null;
        remittanceReference: string | null;
      }
    | undefined,
  carrierPublishes: boolean,
): CollectionState {
  // Sans colis, on ne sait rien — et le dire vaut mieux que de supposer.
  if (!shipment) return { kind: 'UNKNOWN' };

  if (shipment.collectedCentimes !== null && shipment.collectedAt !== null) {
    return {
      kind: 'COLLECTED',
      amountCentimes: shipment.collectedCentimes,
      collectedAt: shipment.collectedAt,
      reference: shipment.remittanceReference,
    };
  }

  // LA DISTINCTION QUI COMPTE : rien a encaisser parce que le transporteur ne
  // publie pas, ou rien encaisse ALORS QU'il publie — donc une creance.
  return carrierPublishes ? { kind: 'PENDING' } : { kind: 'UNSUPPORTED' };
}

export interface CreateShipmentInput {
  readonly tenantId: string;
  readonly orderId: string;
  /** Compte transporteur a utiliser. A defaut, celui par defaut de la boutique. */
  readonly carrierAccountId?: string;
  readonly membershipId: string;
  readonly permissions: ReadonlySet<string>;
  readonly deliveryType?: 'HOME' | 'PICKUP_POINT';
  readonly pickupPointId?: string | null;
  readonly weightGrams?: number | null;
  readonly notes?: string | null;
  readonly allowOpening?: boolean;
}

export interface CreateShipmentResult {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly carrierName: string;
  readonly labelUrl: string | null;
  /** Vrai si un colis actif existait deja (appel rejoue). */
  readonly alreadyExisted: boolean;
}

@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly registry: CarrierRegistry,
    private readonly workflow: OrderWorkflowService,
    private readonly orders: OrdersService,
    private readonly outbox: OutboxService,
    private readonly encryption: EncryptionService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // CREATION
  // ==========================================================================

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    // --- 1. IDEMPOTENCE D'ABORD -------------------------------------------
    // Ce controle precede DELIBEREMENT la verification du statut de la
    // commande. Apres une premiere expedition reussie, la commande est passee
    // a EXPEDIEE : un rejeu (double-clic, reessai reseau, retour arriere du
    // navigateur) echouerait alors sur « statut incorrect », message
    // incomprehensible pour l'agent alors que son colis existe deja.
    // On retourne donc le colis existant, ce qui rend l'appel reellement
    // idempotent du point de vue de l'utilisateur.
    const active = await this.prisma.shipment.findFirst({
      where: {
        tenantId: input.tenantId,
        orderId: input.orderId,
        status: { in: [...ACTIVE_SHIPMENT_STATUSES] },
      },
      select: {
        id: true,
        trackingNumber: true,
        labelUrl: true,
        carrier: { select: { name: true } },
      },
    });

    if (active) {
      return {
        shipmentId: active.id,
        trackingNumber: active.trackingNumber ?? '',
        carrierName: active.carrier.name,
        labelUrl: active.labelUrl,
        alreadyExisted: true,
      };
    }

    // --- 2. Verifications metier ------------------------------------------
    const order = await this.loadShippableOrder(input.tenantId, input.orderId);
    const account = await this.resolveCarrierAccount(input.tenantId, input.carrierAccountId);
    const adapter = this.registry.get(account.carrierCode);

    // --- Cle d'idempotence deterministe -----------------------------------
    // Derivee de (commande, compte transporteur) : le meme couple produit
    // toujours la meme cle, ce qui rend le rejeu inoffensif cote transporteur.
    const idempotencyKey = createHash('sha256')
      .update(`${input.tenantId}:${input.orderId}:${account.id}`)
      .digest('hex')
      .slice(0, 32);

    // --- Enregistrement prealable ------------------------------------------
    // Le colis existe localement AVANT l'appel externe : si le processus tombe
    // pendant l'appel, la trace subsiste et la reconciliation peut retrouver
    // le colis chez le transporteur.
    let shipmentId: string;
    try {
      const created = await this.prisma.shipment.create({
        data: {
          tenantId: input.tenantId,
          orderId: input.orderId,
          carrierId: account.carrierId,
          carrierAccountId: account.id,
          idempotencyKey,
          status: 'CREATION_PENDING',
          attemptCount: 1,
        },
        select: { id: true },
      });
      shipmentId = created.id;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          ERROR_CODES.SHIPMENT_ALREADY_EXISTS,
          'Un colis est deja en cours de creation pour cette commande.',
        );
      }
      throw error;
    }

    // --- Appel au transporteur (HORS transaction) -------------------------
    const context = this.buildCarrierContext(account, input.tenantId);
    const request = this.buildShipmentRequest(order, idempotencyKey, input, {
      sendOrderNumberInsteadOfReference: account.sendOrderNumberInsteadOfReference,
    });

    const result = await adapter.createShipment(context, request);

    if (!result.ok) {
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'ERROR',
          errorCode: result.code,
          errorMessage: result.message,
          lastSyncedAt: this.clock.now(),
        },
      });

      await this.prisma.$transaction(async (rawTx) => {
        const tx = rawTx as PrismaTransactionClient;
        await this.outbox.publish(tx, {
          tenantId: input.tenantId,
          eventType: DOMAIN_EVENTS.SHIPMENT_FAILED,
          payload: {
            orderId: input.orderId,
            shipmentId,
            carrier: account.carrierCode,
            code: result.code,
            message: result.message,
            retryable: result.retryable,
          },
        });
      });

      this.logger.warn(
        `Creation de colis refusee par ${account.carrierCode} pour la commande ` +
          `${order.reference} : ${result.code} — ${result.message}`,
      );

      throw new BusinessException(
        result.retryable ? ERROR_CODES.CARRIER_API_ERROR : ERROR_CODES.CARRIER_REJECTED_ORDER,
        result.message,
        result.retryable ? HttpStatus.BAD_GATEWAY : HttpStatus.UNPROCESSABLE_ENTITY,
        {
          details: {
            carrier: account.carrierCode,
            code: result.code,
            retryable: result.retryable,
          },
        },
      );
    }

    // --- Succes : enregistrement et passage a EXPEDIEE ---------------------
    await this.prisma.$transaction(async (rawTx) => {
      const tx = rawTx as PrismaTransactionClient;

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'CREATED',
          normalizedStatus: 'CREATED',
          providerStatus: result.providerStatus ?? null,
          trackingNumber: result.trackingNumber,
          providerShipmentId: result.providerShipmentId ?? null,
          labelUrl: result.labelUrl ?? null,
          costCentimes: result.costCentimes ?? null,
          weightGrams: input.weightGrams ?? null,
          errorCode: null,
          errorMessage: null,
          lastSyncedAt: this.clock.now(),
        },
      });

      // Le cout transporteur alimente le calcul de rentabilite (Addendum §33).
      if (result.costCentimes !== null && result.costCentimes !== undefined) {
        await tx.order.update({
          where: { id: input.orderId },
          data: { carrierCostCentimes: result.costCentimes },
        });
      }

      await this.workflow.transitionWithin(tx, {
        tenantId: input.tenantId,
        orderId: input.orderId,
        to: 'SHIPPED',
        actorKind: 'USER',
        membershipId: input.membershipId,
        permissions: input.permissions,
        source: `carrier:${account.carrierCode.toLowerCase()}`,
        metadata: { trackingNumber: result.trackingNumber, shipmentId },
      });

      await this.outbox.publish(tx, {
        tenantId: input.tenantId,
        eventType: DOMAIN_EVENTS.SHIPMENT_CREATED,
        payload: {
          orderId: input.orderId,
          shipmentId,
          trackingNumber: result.trackingNumber,
          carrier: account.carrierCode,
        },
      });
    });

    this.logger.log(
      `Colis cree pour ${order.reference} chez ${account.carrierCode} : ${result.trackingNumber}`,
    );

    return {
      shipmentId,
      trackingNumber: result.trackingNumber,
      carrierName: account.carrierName,
      labelUrl: result.labelUrl ?? null,
      alreadyExisted: false,
    };
  }

  // ==========================================================================
  // ANNULATION
  // ==========================================================================

  async cancelShipment(
    tenantId: string,
    shipmentId: string,
    reason: string,
  ): Promise<{ cancelled: boolean }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { tenantId, id: shipmentId },
      select: {
        id: true,
        status: true,
        trackingNumber: true,
        orderId: true,
        carrierAccount: {
          select: {
            id: true,
            credentialsEncrypted: true,
            config: true,
            carrier: { select: { code: true, name: true, id: true } },
          },
        },
      },
    });

    if (!shipment) {
      throw new NotFoundException(ERROR_CODES.SHIPMENT_NOT_FOUND, 'Colis introuvable.');
    }

    if (['CANCELLED', 'DELIVERED', 'RETURNED'].includes(shipment.status)) {
      throw new ConflictException(
        ERROR_CODES.CONFLICT,
        `Un colis ${shipment.status} ne peut plus etre annule.`,
      );
    }

    const adapter = this.registry.get(shipment.carrierAccount.carrier.code);
    const context = this.buildCarrierContext(
      {
        credentialsEncrypted: shipment.carrierAccount.credentialsEncrypted,
        config: shipment.carrierAccount.config as Record<string, unknown>,
      },
      tenantId,
    );

    if (shipment.trackingNumber) {
      const result = await adapter.cancelShipment(context, shipment.trackingNumber);
      if (!result.ok) {
        throw new BusinessException(
          ERROR_CODES.CARRIER_API_ERROR,
          result.message,
          result.code === 'NOT_CANCELLABLE'
            ? HttpStatus.CONFLICT
            : HttpStatus.BAD_GATEWAY,
          { details: { code: result.code, retryable: result.retryable } },
        );
      }
    }

    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: 'CANCELLED',
        normalizedStatus: 'CANCELLED',
        cancelledAt: this.clock.now(),
        errorMessage: reason.slice(0, 500),
      },
    });

    this.logger.log(`Colis ${shipment.trackingNumber ?? shipmentId} annule : ${reason}`);
    return { cancelled: true };
  }

  // ==========================================================================
  // LECTURE
  // ==========================================================================

  async getShipment(tenantId: string, shipmentId: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { tenantId, id: shipmentId },
      include: {
        carrier: { select: { code: true, name: true } },
        events: { orderBy: { occurredAt: 'desc' } },
        order: { select: { id: true, reference: true, status: true } },
      },
    });

    if (!shipment) {
      throw new NotFoundException(ERROR_CODES.SHIPMENT_NOT_FOUND, 'Colis introuvable.');
    }

    return shipment;
  }

  /**
   * Liste paginee de tous les colis de la boutique.
   *
   * Le suivi quotidien se fait par colis, pas par commande : l'exploitant veut
   * voir « ce qui est parti et n'est pas encore arrive ». Le filtre par statut
   * et la date de derniere synchronisation permettent d'isoler les colis
   * silencieux, ceux dont le transporteur n'a rien dit depuis longtemps.
   */
  async list(
    tenantId: string,
    filters: { status?: readonly ShipmentStatus[]; carrierId?: string; search?: string } = {},
    options: { page?: number; pageSize?: number } = {},
  ) {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const take = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 25)));
    const skip = (page - 1) * take;

    const where: Prisma.ShipmentWhereInput = { tenantId };

    if (filters.status?.length) where.status = { in: [...filters.status] };
    if (filters.carrierId) where.carrierId = filters.carrierId;

    if (filters.search?.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { trackingNumber: { contains: term, mode: 'insensitive' } },
        { order: { reference: { contains: term, mode: 'insensitive' } } },
        { order: { customerNameSnapshot: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const [total, rows] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          trackingNumber: true,
          status: true,
          providerStatus: true,
          labelUrl: true,
          costCentimes: true,
          errorMessage: true,
          lastSyncedAt: true,
          createdAt: true,
          cancelledAt: true,
          // La capacite voyage AVEC le colis : sans elle, l'ecran ne peut pas
          // distinguer « ce transporteur ne produit pas d'etiquette » de
          // « l'etiquette manque », deux situations qui appellent deux gestes
          // opposes (D-049).
          carrier: {
            select: {
              id: true,
              code: true,
              name: true,
              capability: { select: { printableLabel: true } },
            },
          },
          order: {
            select: {
              id: true,
              reference: true,
              status: true,
              customerNameSnapshot: true,
              phoneSnapshot: true,
              wilayaCodeSnapshot: true,
              communeSnapshot: true,
              totalCentimes: true,
            },
          },
          events: {
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { providerStatus: true, occurredAt: true, location: true },
          },
        },
      }),
    ]);

    return {
      data: rows,
      meta: {
        page,
        pageSize: take,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / take),
      },
    };
  }

  /** Colis d'une commande, du plus recent au plus ancien. */
  async listByOrder(tenantId: string, orderId: string) {
    return this.prisma.shipment.findMany({
      where: { tenantId, orderId },
      orderBy: { createdAt: 'desc' },
      include: {
        carrier: {
          select: {
            code: true,
            name: true,
            capability: { select: { printableLabel: true } },
          },
        },
        events: { orderBy: { occurredAt: 'desc' }, take: 20 },
      },
    });
  }

  /**
   * Catalogue des transporteurs avec leur matrice de capacites.
   *
   * POURQUOI CE N'EST PAS `registry.describeAll()`
   *   Le registre ne connait que les connecteurs IMPLEMENTES, et volontairement
   *   (« le produit ne promet que ce qu il tient »). L'ecran de gestion, lui,
   *   doit montrer aussi les transporteurs planifies — sans quoi le commercant
   *   ne peut pas savoir que son transporteur habituel arrive, et redemande.
   *   Les deux vues coexistent : celle-ci dit ce qui EXISTE, l'autre ce qui est
   *   UTILISABLE aujourd'hui.
   */
  async listCarrierCatalogue(): Promise<readonly CarrierCatalogueEntry[]> {
    const carriers = await this.prisma.carrier.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
        implementationStatus: true,
        capability: true,
        _count: { select: { wilayaCoverage: true } },
      },
    });

    return carriers.map((carrier) => ({
      id: carrier.id,
      code: carrier.code,
      name: carrier.name,
      isActive: carrier.isActive,
      implementationStatus: carrier.implementationStatus,
      // `null` ne veut pas dire « rien ne marche » mais « on ne sait pas » :
      // l'ecran doit le dire ainsi plutot que d'afficher dix-huit croix.
      capabilities: carrier.capability
        ? CARRIER_CAPABILITY_KEYS.reduce<Record<string, boolean>>((acc, key) => {
            acc[key] = carrier.capability![key];
            return acc;
          }, {})
        : null,
      coveredWilayas: carrier._count.wilayaCoverage,
    }));
  }

  /** Couverture declaree d'un transporteur, wilaya par wilaya. */
  async listCarrierCoverage(carrierId: string): Promise<readonly CarrierCoverageEntry[]> {
    const rows = await this.prisma.carrierWilayaCoverage.findMany({
      where: { carrierId },
      orderBy: { wilayaCode: 'asc' },
      select: {
        wilayaCode: true,
        homeDelivery: true,
        pickupPoint: true,
        leadTimeDays: true,
      },
    });

    return rows.map((row) => ({
      wilayaCode: row.wilayaCode,
      wilayaName: getWilayaByCode(row.wilayaCode)?.name ?? String(row.wilayaCode),
      homeDelivery: row.homeDelivery,
      pickupPoint: row.pickupPoint,
      leadTimeDays: row.leadTimeDays,
    }));
  }

  /**
   * Declare la couverture d'une wilaya.
   *
   * Une ligne qui ne couvre NI le domicile NI le bureau est supprimee plutot
   * qu'ecrite : la base la refuserait (CHECK), et surtout l'absence de ligne
   * porte deja exactement ce sens — « couverture inconnue ». Deux facons
   * d'ecrire la meme chose finiraient par se contredire.
   */
  async setCarrierCoverage(
    carrierId: string,
    input: {
      wilayaCode: number;
      homeDelivery: boolean;
      pickupPoint: boolean;
      leadTimeDays?: number | null;
    },
  ): Promise<void> {
    const carrier = await this.prisma.carrier.findUnique({
      where: { id: carrierId },
      select: { id: true },
    });

    if (!carrier) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Transporteur introuvable.');
    }

    if (!getWilayaByCode(input.wilayaCode)) {
      throw new ValidationException(`Code wilaya inconnu : ${input.wilayaCode}.`, {
        details: { field: 'wilayaCode', value: input.wilayaCode },
      });
    }

    if (!input.homeDelivery && !input.pickupPoint) {
      await this.prisma.carrierWilayaCoverage.deleteMany({
        where: { carrierId, wilayaCode: input.wilayaCode },
      });
      return;
    }

    await this.prisma.carrierWilayaCoverage.upsert({
      where: { carrierId_wilayaCode: { carrierId, wilayaCode: input.wilayaCode } },
      create: {
        carrierId,
        wilayaCode: input.wilayaCode,
        homeDelivery: input.homeDelivery,
        pickupPoint: input.pickupPoint,
        leadTimeDays: input.leadTimeDays ?? null,
      },
      update: {
        homeDelivery: input.homeDelivery,
        pickupPoint: input.pickupPoint,
        leadTimeDays: input.leadTimeDays ?? null,
      },
    });
  }

  /** Reglages d'exploitation d'un compte transporteur. */
  /**
   * DISPATCHER : un clic, de « confirmee » a « expediee ».
   *
   * CE QUE LE GESTE REMPLACE
   *   Trois etapes que l'interface exposait separement — prendre en
   *   preparation, declarer le colis pret, expedier — et qui ne decrivaient
   *   rien d'observable pour l'exploitant : entre la confirmation et le depart
   *   du colis, il n'y a qu'un seul moment de verite, celui ou l'on remet la
   *   marchandise au livreur. Les trois etats intermediaires existent toujours
   *   dans la machine a etats ; ils cessent simplement d'etre des ECRANS.
   *
   * LE GARDE SUR `preparedQuantity` N'EST PAS CONTOURNE
   *   Il reste actif, et il est satisfait de la meme facon que par le bouton
   *   unitaire : cocher des lignes puis cliquer « Dispatcher » EST l'affirmation
   *   que ces commandes sont pretes. `markPreparationReady` enregistre cette
   *   affirmation, et le garde la VERIFIE ensuite au lieu de la supposer.
   *
   *   La nuance compte : on ne retire pas la regle, on fournit le geste qui la
   *   satisfait. Un `updateMany` sur le statut aurait saute le garde, la
   *   reservation de stock, l'historique et les evenements sortants — et le
   *   lot serait devenu un chemin derobe vers un etat qu'aucun clic unitaire
   *   n'aurait permis.
   *
   * LE TRANSPORTEUR EST UN PREREQUIS DUR
   *   `createShipment` ne peut rien appeler sans compte transporteur. Une
   *   commande sans transporteur choisi est donc REFUSEE, avec son motif, au
   *   lieu de retomber silencieusement sur le compte par defaut de la boutique
   *   — ce que faisait l'ancien chemin, et qui expediait chez le mauvais
   *   livreur sans que personne ne l'ait demande.
   *
   * SEQUENTIEL
   *   Voir `createShipmentsBulk` : chaque ligne appelle le transporteur, et les
   *   lancer en parallele ferait tomber son quota.
   */
  async dispatchOrders(input: {
    tenantId: string;
    orderIds: readonly string[];
    membershipId: string;
    permissions: ReadonlySet<string>;
  }): Promise<BulkArchiveResult> {
    const dispatched: string[] = [];
    const skipped: BulkArchiveSkip[] = [];

    for (const orderId of input.orderIds) {
      try {
        const order = await this.prisma.order.findFirst({
          where: { tenantId: input.tenantId, id: orderId },
          select: { status: true, carrierAccountId: true },
        });

        if (!order) {
          throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
        }

        if (!order.carrierAccountId) {
          throw new ValidationException(
            'Aucun transporteur choisi pour cette commande. Utilisez « Changer le livreur » avant de dispatcher.',
            { details: { orderId } },
          );
        }

        // 1. Confirmee -> prete a expedier, en enregistrant les lignes
        //    preparees. Sans effet si la commande est deja prete : le rejeu
        //    d'un dispatch interrompu ne doit pas echouer sur l'etape deja
        //    franchie.
        if (order.status === 'CONFIRMED' || order.status === 'IN_PREPARATION') {
          await this.orders.markPreparationReady(
            input.tenantId,
            orderId,
            input.membershipId,
            input.permissions,
          );
        }

        // 2. Creation du colis chez le transporteur CHOISI, qui bascule la
        //    commande en EXPEDIEE. Idempotent : un rejeu retrouve le colis
        //    existant au lieu d'en creer un second.
        await this.createShipment({
          tenantId: input.tenantId,
          orderId,
          carrierAccountId: order.carrierAccountId,
          membershipId: input.membershipId,
          permissions: input.permissions,
        });

        dispatched.push(orderId);
      } catch (error) {
        if (error instanceof BusinessException) {
          skipped.push({ id: orderId, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }
    }

    return { archived: dispatched.length, skipped };
  }

  /**
   * Affecte un transporteur a une selection de commandes.
   *
   * REVISABLE TANT QUE LE COLIS N'EXISTE PAS
   *   Une commande deja expediee garde le transporteur de son colis : changer
   *   l'intention apres coup ne deplacerait aucun paquet et ferait mentir
   *   l'ecran. Ces lignes-la sont refusees avec leur motif.
   */
  async assignCarrierAccount(input: {
    tenantId: string;
    orderIds: readonly string[];
    carrierAccountId: string;
  }): Promise<BulkArchiveResult> {
    const account = await this.prisma.carrierAccount.findFirst({
      where: { tenantId: input.tenantId, id: input.carrierAccountId },
      select: { id: true, status: true },
    });

    if (!account) {
      throw new NotFoundException(
        ERROR_CODES.CARRIER_NOT_CONFIGURED,
        'Ce compte transporteur est introuvable.',
      );
    }

    const assigned: string[] = [];
    const skipped: BulkArchiveSkip[] = [];

    for (const orderId of input.orderIds) {
      const order = await this.prisma.order.findFirst({
        where: { tenantId: input.tenantId, id: orderId },
        select: { status: true, reference: true },
      });

      if (!order) {
        skipped.push({
          id: orderId,
          code: ERROR_CODES.ORDER_NOT_FOUND,
          message: 'Commande introuvable.',
        });
        continue;
      }

      if (!PRE_SHIPMENT_STATUSES.includes(order.status)) {
        skipped.push({
          id: orderId,
          code: ERROR_CODES.ORDER_INVALID_TRANSITION,
          message: `${order.reference} est deja partie : son transporteur ne se change plus ici.`,
        });
        continue;
      }

      await this.prisma.order.updateMany({
        where: { tenantId: input.tenantId, id: orderId },
        data: { carrierAccountId: input.carrierAccountId },
      });
      assigned.push(orderId);
    }

    return { archived: assigned.length, skipped };
  }

  /**
   * Expedie une SELECTION de commandes pretes.
   *
   * SEQUENTIEL, ET C'EST VOLONTAIRE
   *   Chaque ligne declenche un appel au transporteur. Les lancer en parallele
   *   ferait tomber le quota de l'API distante au premier lot un peu large, et
   *   le transporteur ne distingue pas un pic legitime d'un emballement : on
   *   perdrait le droit d'expedier pour la journee. Vingt colis pris un par un
   *   coutent quelques secondes ; un blocage de compte coute une journee.
   *
   * L'IDEMPOTENCE FAIT LE RESTE
   *   `createShipment` derive sa cle de (commande, compte transporteur) et
   *   retourne le colis existant si l'appel est rejoue. Un lot relance apres
   *   une coupure ne cree donc pas de second colis — il retrouve ceux qui sont
   *   deja partis et poursuit avec les autres.
   */
  async createShipmentsBulk(input: {
    tenantId: string;
    orderIds: readonly string[];
    carrierAccountId?: string;
    membershipId: string;
    permissions: ReadonlySet<string>;
  }): Promise<BulkArchiveResult> {
    const shipped: string[] = [];
    const skipped: BulkArchiveSkip[] = [];

    for (const orderId of input.orderIds) {
      try {
        await this.createShipment({
          tenantId: input.tenantId,
          orderId,
          carrierAccountId: input.carrierAccountId,
          membershipId: input.membershipId,
          permissions: input.permissions,
        });
        shipped.push(orderId);
      } catch (error) {
        if (error instanceof BusinessException) {
          skipped.push({ id: orderId, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }
    }

    return { archived: shipped.length, skipped };
  }

  /**
   * File de livraison : les commandes parties, et ou elles en sont.
   *
   * POURQUOI CES DEUX ECRANS NE SONT PAS UN FILTRE DE `/shipments`
   *   `/expeditions` repond a « qu'est-ce qui est parti ? » — une question de
   *   COLIS, tournee vers le transporteur. « En livraison » et « Livre »
   *   repondent a « ou en est ma commande ? » et « ai-je ete paye ? » — deux
   *   questions de COMMANDE, tournees vers le client et vers la caisse.
   *
   *   La seconde est invisible sur un ecran de colis, parce qu'elle ne porte
   *   pas sur le colis : elle porte sur l'argent qu'il transportait.
   *
   * TROIS ETATS D'ENCAISSEMENT, JAMAIS DEUX
   *   Un montant absent ne veut pas dire « impaye ». Il peut vouloir dire
   *   « ce transporteur ne publie pas cette donnee », et confondre les deux
   *   ferait lire une creance la ou il n'y a qu'une ignorance. L'etat est donc
   *   calcule ICI, en croisant le colis et la capacite du transporteur — pas
   *   deduit d'un champ nul cote ecran.
   */
  async listDeliveryQueue(
    tenantId: string,
    filters: {
      stage: 'IN_DELIVERY' | 'DELIVERED';
      wilayaCode?: number;
      carrierAccountId?: string;
      search?: string;
      from?: Date;
      to?: Date;
    },
    options: { page?: number; pageSize?: number } = {},
  ): Promise<Paginated<DeliveryQueueItem>> {
    const { skip, take } = toSkipTake(options);
    const page = Math.max(1, Math.trunc(options.page ?? 1));

    // LA DATE FILTREE EST CELLE DE L'ETAPE, pas une date unique pour les deux
    // ecrans. « En livraison » se lit par date de DEPART — c'est elle qui dit
    // depuis combien de temps un colis roule ; « Livre » se lit par date de
    // LIVRAISON — c'est elle qui delimite une periode d'encaissement. Filtrer
    // les deux sur le meme champ rendrait l'un des deux ecrans inutilisable.
    const dateField = filters.stage === 'DELIVERED' ? 'deliveredAt' : 'shippedAt';
    const dateRange =
      filters.from || filters.to
        ? {
            [dateField]: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {};

    const where: Prisma.OrderWhereInput = {
      tenantId,
      archivedAt: null,
      status: filters.stage,
      ...dateRange,
      ...(filters.wilayaCode ? { wilayaCodeSnapshot: filters.wilayaCode } : {}),
      ...(filters.carrierAccountId ? { carrierAccountId: filters.carrierAccountId } : {}),
      ...(filters.search?.trim()
        ? {
            OR: [
              { reference: { contains: filters.search.trim(), mode: 'insensitive' } },
              { customerNameSnapshot: { contains: filters.search.trim(), mode: 'insensitive' } },
              { phoneSnapshot: { contains: filters.search.trim() } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: filters.stage === 'DELIVERED' ? { deliveredAt: 'desc' } : { shippedAt: 'asc' },
        select: {
          id: true,
          reference: true,
          status: true,
          customerNameSnapshot: true,
          phoneSnapshot: true,
          wilayaCodeSnapshot: true,
          communeSnapshot: true,
          totalCentimes: true,
          shippedAt: true,
          deliveredAt: true,
          shipments: {
            where: { status: { notIn: ['CANCELLED', 'ERROR'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              trackingNumber: true,
              status: true,
              providerStatus: true,
              collectedCentimes: true,
              collectedAt: true,
              remittanceReference: true,
              carrier: {
                select: {
                  name: true,
                  capability: { select: { realtimeCollectionVouchers: true } },
                },
              },
              // Les TENTATIVES sont des faits distincts, conserves un par un.
              // Un colis peut avoir echoue trois fois avant d'aboutir, et
              // n'afficher que le dernier evenement effacerait precisement ce
              // qui explique un delai ou un retour.
              events: {
                where: { normalizedStatus: 'FAILED_ATTEMPT' },
                orderBy: { occurredAt: 'desc' },
                select: { occurredAt: true, description: true },
              },
            },
          },
        },
      }),
    ]);

    return {
      data: rows.map((row) => {
        const shipment = row.shipments[0];
        const publishes = shipment?.carrier.capability?.realtimeCollectionVouchers ?? false;

        return {
          id: row.id,
          reference: row.reference,
          status: row.status,
          customerName: row.customerNameSnapshot,
          phone: row.phoneSnapshot,
          wilayaCode: row.wilayaCodeSnapshot,
          commune: row.communeSnapshot,
          totalCentimes: row.totalCentimes,
          shippedAt: row.shippedAt,
          deliveredAt: row.deliveredAt,
          carrierName: shipment?.carrier.name ?? null,
          trackingNumber: shipment?.trackingNumber ?? null,
          providerStatus: shipment?.providerStatus ?? null,
          failedAttempts: shipment?.events.length ?? 0,
          lastAttemptAt: shipment?.events[0]?.occurredAt ?? null,
          collection: resolveCollectionState(shipment, publishes),
        };
      }),
      meta: buildPageMeta(page, take, total),
    };
  }

  /**
   * Comptes transporteur configures pour la boutique.
   *
   * Chaque ligne porte de quoi decider SANS cliquer : combien de colis elle a
   * portes — donc si elle est encore supprimable —, et quels champs
   * d'identifiants sont renseignes. Les VALEURS, elles, ne sortent jamais : un
   * jeton d'API n'a aucune raison de traverser le reseau une seconde fois.
   */
  async listCarrierAccounts(tenantId: string) {
    const accounts = await this.prisma.carrierAccount.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        label: true,
        status: true,
        isDefault: true,
        lastHealthCheckAt: true,
        lastHealthCheckOk: true,
        lastErrorMessage: true,
        config: true,
        kind: true,
        credentialsEncrypted: true,
        sendOrderNumberInsteadOfReference: true,
        stockHeldByCourier: true,
        createdAt: true,
        _count: { select: { shipments: true } },
        carrier: {
          select: {
            id: true,
            code: true,
            name: true,
            supportsWebhooks: true,
            supportsCancellation: true,
            implementationStatus: true,
            capability: true,
          },
        },
      },
    });

    return accounts.map(({ credentialsEncrypted, _count, ...account }) => {
      let configuredKeys: string[] = [];
      if (credentialsEncrypted) {
        try {
          configuredKeys = Object.entries(
            this.encryption.decryptJson<Record<string, string>>(credentialsEncrypted, tenantId),
          )
            .filter(([, value]) => typeof value === 'string' && value.length > 0)
            .map(([key]) => key);
        } catch {
          // Chiffre illisible — cle tournee, blob altere. On ne masque pas le
          // compte pour autant : le dire vaut mieux que de le faire disparaitre
          // d'une liste ou le commercant le cherchera.
          configuredKeys = [];
        }
      }

      return {
        ...account,
        shipmentCount: _count.shipments,
        credentialKeys: configuredKeys,
        // `Shipment.carrierAccountId` est en `Restrict` : la base refuserait la
        // suppression apres coup. Autant l'annoncer avant.
        deletable: _count.shipments === 0,
      };
    });
  }

  // ==========================================================================
  // Comptes transporteur — le CRUD qui manquait
  //
  // CE QU'UN COMPTE EST, ET CE QU'IL N'EST PAS
  //   Un « livreur » au sens de l'exploitation, c'est un COMPTE chez un
  //   transporteur catalogue : les identifiants avec lesquels cette boutique
  //   parle a Yalidine. Ce n'est ni une personne ni un utilisateur du produit —
  //   aucun login, aucun mot de passe, aucun telephone de connexion. Stocker de
  //   quoi authentifier quelqu un qui n a nulle part ou se connecter creerait
  //   un secret orphelin.
  //
  // LES IDENTIFIANTS SONT LA SEULE RAISON D'ETRE DE CE FORMULAIRE
  //   Toute la chaine d'expedition lisait deja `credentialsEncrypted` — creation
  //   de colis, sondage de suivi, webhooks. RIEN ne l'ecrivait. La colonne
  //   existait, chiffree, lue par quatre chemins, et restait vide : aucune
  //   boutique reelle ne pouvait expedier. C'est le trou que ces methodes
  //   ferment.
  // ==========================================================================

  /**
   * Transporteurs selectionnables, avec les champs d'identifiants a saisir.
   *
   * Les champs viennent de `adapter.credentialFields` et non d'une liste ecrite
   * ici : un connecteur qui change ses identifiants change le formulaire, sans
   * qu'aucun ecran ne soit touche.
   */
  listCarrierConnectors(): Promise<readonly CarrierConnectorOption[]> {
    // Les transporteurs PREVUS sont LISTES, pas masques : un commercant qui
    // cherche ZR Express doit lire pourquoi il ne peut pas le choisir, plutot
    // que de conclure a une omission et de le redemander. Meme principe que le
    // catalogue de `/transporteurs`.
    return this.prisma.carrier
      .findMany({
        orderBy: [{ implementationStatus: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          isActive: true,
          implementationStatus: true,
        },
      })
      .then((carriers) =>
        carriers.map((carrier) => {
          // D-066 : un transporteur PREVU n'a pas d'adaptateur. Le registre le
          // refuserait a l'execution ; l'ecran doit le refuser AVANT la saisie,
          // plutot que de laisser remplir un formulaire pour rien.
          const connected = this.registry.has(carrier.code);
          return {
            id: carrier.id,
            code: carrier.code,
            name: carrier.name,
            implementationStatus: carrier.implementationStatus,
            selectable:
              connected && carrier.isActive && carrier.implementationStatus === 'AVAILABLE',
            credentialFields: connected
              ? this.registry.get(carrier.code).credentialFields.map((field) => ({ ...field }))
              : [],
          };
        }),
      );
  }

  /**
   * Cree un compte transporteur, identifiants compris.
   *
   * LE COMPTE EST VERIFIE DANS LA FOULEE
   *   `resolveCarrierAccount` n'accepte qu'un compte `CONNECTED` ou `DEGRADED`.
   *   Un compte cree en `PENDING_SETUP` serait donc invisible du Dispatcher, et
   *   le commercant decouvrirait le refus a la premiere expedition sans savoir
   *   qu'il lui manquait un geste. On appelle donc le `healthCheck` du
   *   connecteur immediatement : le statut affiche decrit une tentative REELLE
   *   de connexion, pas une intention.
   *
   * SAUF S'IL EST CREE INACTIF
   *   `enabled: false` fait naitre le compte `DISABLED`. Le controle est
   *   quand meme lance et son resultat enregistre — on saura qu'il
   *   repondrait —, mais il n'ecrase pas le statut : « inactif » est une
   *   decision du commercant, pas un diagnostic (D-068).
   */
  async createCarrierAccount(
    tenantId: string,
    input: {
      carrierId: string;
      label: string;
      kind?: CarrierAccountKind;
      credentials: Record<string, string>;
      stockHeldByCourier?: boolean;
      sendOrderNumberInsteadOfReference?: boolean;
      isDefault?: boolean;
      enabled?: boolean;
    },
  ): Promise<{ id: string; status: string; health: CarrierHealth }> {
    const carrier = await this.prisma.carrier.findUnique({
      where: { id: input.carrierId },
      select: { id: true, code: true, name: true, implementationStatus: true },
    });

    if (!carrier) {
      throw new NotFoundException(ERROR_CODES.CARRIER_NOT_CONFIGURED, 'Transporteur introuvable.');
    }

    const adapter = this.requireSelectableCarrier(carrier);
    const credentials = this.validateCredentials(adapter.credentialFields, input.credentials, {});

    const label = input.label.trim();

    const created = await this.prisma
      .$transaction(async (rawTx) => {
        const tx = rawTx as PrismaTransactionClient;

        // UN SEUL COMPTE PAR DEFAUT. `resolveCarrierAccount` prend le premier
        // `isDefault` venu quand aucun compte n'est precise : deux defauts
        // rendraient le transporteur choisi dependant de l'ordre des lignes.
        if (input.isDefault) {
          await tx.carrierAccount.updateMany({
            where: { tenantId, isDefault: true },
            data: { isDefault: false },
          });
        }

        const existing = await tx.carrierAccount.count({ where: { tenantId } });

        return tx.carrierAccount.create({
          data: {
            tenantId,
            carrierId: carrier.id,
            label,
            kind: input.kind ?? 'DELIVERY_COMPANY',
            // Un compte cree INACTIF nait DISABLED, et le controle de sante qui
            // suit ne l'en sortira pas : D-068 vaut des la creation, sans quoi
            // « inactif » coche au formulaire deviendrait « connecte » deux
            // secondes plus tard, sans que personne ne l'ait redemande.
            status: input.enabled === false ? 'DISABLED' : 'PENDING_SETUP',
            credentialsEncrypted: this.encryption.encryptJson(credentials, tenantId),
            config: {},
            // Le PREMIER compte devient le defaut sans qu'on ait a le demander :
            // une boutique qui n'en a qu'un n'a pas a decider qu'il est celui-la.
            isDefault: input.isDefault ?? existing === 0,
            stockHeldByCourier: input.stockHeldByCourier ?? false,
            sendOrderNumberInsteadOfReference: input.sendOrderNumberInsteadOfReference ?? false,
          },
          select: { id: true },
        });
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintError(error)) {
          throw new ConflictException(
            ERROR_CODES.CARRIER_NOT_CONFIGURED,
            `Un compte « ${label} » existe deja chez ${carrier.name}.`,
          );
        }
        throw error;
      });

    const health = await this.checkCarrierHealth(tenantId, created.id);
    const status = await this.prisma.carrierAccount.findUniqueOrThrow({
      where: { id: created.id },
      select: { status: true },
    });

    return { id: created.id, status: status.status, health };
  }

  /**
   * Reglages d'exploitation d'un compte.
   *
   * `enabled` est une INTENTION du commercant, distincte du diagnostic porte
   * par les autres statuts : `CONNECTED`, `DEGRADED` et `ERROR` decrivent ce
   * que la derniere tentative de connexion a donne, `DISABLED` dit qu'on ne
   * veut plus s'en servir. Reactiver repart donc de `PENDING_SETUP` — l'etat
   * « on ne sait pas encore » — plutot que de restaurer un diagnostic perime.
   */
  async updateCarrierAccountSettings(
    tenantId: string,
    carrierAccountId: string,
    changes: {
      label?: string;
      kind?: CarrierAccountKind;
      sendOrderNumberInsteadOfReference?: boolean;
      stockHeldByCourier?: boolean;
      isDefault?: boolean;
      enabled?: boolean;
    },
  ): Promise<void> {
    const account = await this.prisma.carrierAccount.findFirst({
      where: { tenantId, id: carrierAccountId },
      select: { id: true, status: true, carrier: { select: { name: true } } },
    });

    if (!account) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Compte transporteur introuvable.');
    }

    const label = changes.label?.trim();
    if (label !== undefined && label.length === 0) {
      throw new ValidationException('Le nom du compte ne peut pas etre vide.');
    }

    await this.prisma
      .$transaction(async (rawTx) => {
        const tx = rawTx as PrismaTransactionClient;

        if (changes.isDefault === true) {
          await tx.carrierAccount.updateMany({
            where: { tenantId, isDefault: true, id: { not: carrierAccountId } },
            data: { isDefault: false },
          });
        }

        await tx.carrierAccount.update({
          where: { id: carrierAccountId },
          data: {
            ...(label !== undefined ? { label } : {}),
            ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
            ...(changes.sendOrderNumberInsteadOfReference !== undefined
              ? { sendOrderNumberInsteadOfReference: changes.sendOrderNumberInsteadOfReference }
              : {}),
            ...(changes.stockHeldByCourier !== undefined
              ? { stockHeldByCourier: changes.stockHeldByCourier }
              : {}),
            ...(changes.isDefault !== undefined ? { isDefault: changes.isDefault } : {}),
            ...(changes.enabled === false ? { status: 'DISABLED' as const } : {}),
            ...(changes.enabled === true && account.status === 'DISABLED'
              ? { status: 'PENDING_SETUP' as const, lastErrorMessage: null }
              : {}),
          },
        });
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintError(error)) {
          throw new ConflictException(
            ERROR_CODES.CARRIER_NOT_CONFIGURED,
            `Un compte « ${label} » existe deja chez ${account.carrier.name}.`,
          );
        }
        throw error;
      });
  }

  /**
   * Remplace les identifiants d'un compte, puis verifie qu'ils repondent.
   *
   * UN SECRET LAISSE VIDE N'EST PAS UN SECRET EFFACE
   *   L'ecran ne peut pas reafficher un jeton — il ne le recoit jamais. Un
   *   champ secret laisse vide signifie donc « je n'y touche pas », et la
   *   valeur existante est conservee. L'interpreter comme un effacement
   *   deconnecterait la boutique au premier changement de wilaya d'expedition.
   */
  async updateCarrierCredentials(
    tenantId: string,
    carrierAccountId: string,
    submitted: Record<string, string>,
  ): Promise<{ status: string; health: CarrierHealth }> {
    const account = await this.prisma.carrierAccount.findFirst({
      where: { tenantId, id: carrierAccountId },
      select: {
        id: true,
        credentialsEncrypted: true,
        carrier: { select: { id: true, code: true, name: true, implementationStatus: true } },
      },
    });

    if (!account) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Compte transporteur introuvable.');
    }

    const adapter = this.requireSelectableCarrier(account.carrier);
    const current = account.credentialsEncrypted
      ? this.encryption.decryptJson<Record<string, string>>(account.credentialsEncrypted, tenantId)
      : {};

    const credentials = this.validateCredentials(adapter.credentialFields, submitted, current);

    await this.prisma.carrierAccount.update({
      where: { id: carrierAccountId },
      data: { credentialsEncrypted: this.encryption.encryptJson(credentials, tenantId) },
    });

    const health = await this.checkCarrierHealth(tenantId, carrierAccountId);
    const after = await this.prisma.carrierAccount.findUniqueOrThrow({
      where: { id: carrierAccountId },
      select: { status: true },
    });

    return { status: after.status, health };
  }

  /**
   * Supprime un compte — uniquement s'il n'a jamais servi.
   *
   * `Shipment.carrierAccountId` est en `Restrict` : un compte ayant expedie ne
   * peut pas disparaitre sans emporter la tracabilite des colis qu'il a portes.
   * On le dit AVANT le clic (`deletable` / `blockedReason` sur chaque ligne)
   * plutot que de laisser la base refuser apres coup — meme principe qu'en
   * D-063 pour la restauration.
   */
  async deleteCarrierAccount(tenantId: string, carrierAccountId: string): Promise<void> {
    const account = await this.prisma.carrierAccount.findFirst({
      where: { tenantId, id: carrierAccountId },
      select: { id: true, _count: { select: { shipments: true } } },
    });

    if (!account) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Compte transporteur introuvable.');
    }

    if (account._count.shipments > 0) {
      throw new ConflictException(
        ERROR_CODES.CARRIER_NOT_CONFIGURED,
        `Ce compte a deja porte ${account._count.shipments} colis : il ne peut plus etre ` +
          'supprime sans effacer leur tracabilite. Desactivez-le plutot.',
      );
    }

    // `Order.carrierAccountId` est en `SetNull` : les commandes qui l'avaient
    // choisi sans encore partir perdent leur transporteur, et le Dispatcher le
    // redemandera. C'est voulu — l'alternative serait de les bloquer sur un
    // compte qui n'existe plus.
    await this.prisma.carrierAccount.delete({ where: { id: carrierAccountId } });
  }

  /** Refuse un transporteur sans connecteur — D-066, applique a la creation. */
  private requireSelectableCarrier(carrier: {
    code: string;
    name: string;
    implementationStatus: string;
  }) {
    if (carrier.implementationStatus !== 'AVAILABLE' || !this.registry.has(carrier.code)) {
      throw new BusinessException(
        ERROR_CODES.CARRIER_NOT_CONFIGURED,
        `Aucun connecteur n est implemente pour ${carrier.name} : ses capacites sont ` +
          'declarees par sa documentation, pas verifiees. Un compte ne pourrait rien ' +
          'authentifier.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    return this.registry.get(carrier.code);
  }

  /**
   * Valide la saisie contre les champs declares par le connecteur.
   *
   * Une cle inconnue est REFUSEE plutot qu'ignoree : une faute de frappe sur
   * `apiToken` produirait sinon un compte qui se cree sans erreur, echoue a la
   * premiere expedition, et dont rien n'indique ce qui manque.
   */
  private validateCredentials(
    fields: readonly { key: string; label: string; secret: boolean; required: boolean }[],
    submitted: Record<string, string>,
    current: Record<string, string>,
  ): Record<string, string> {
    const known = new Set(fields.map((field) => field.key));
    const unknown = Object.keys(submitted).filter((key) => !known.has(key));

    if (unknown.length > 0) {
      throw new ValidationException(
        `Champs d identifiants inconnus pour ce transporteur : ${unknown.join(', ')}.`,
        { details: { unknown, expected: [...known] } },
      );
    }

    const result: Record<string, string> = {};
    const missing: string[] = [];

    for (const field of fields) {
      const value = submitted[field.key]?.trim();
      const kept = current[field.key];

      if (value) {
        result[field.key] = value;
      } else if (kept !== undefined) {
        result[field.key] = kept;
      } else if (field.required) {
        missing.push(field.label);
      }
    }

    if (missing.length > 0) {
      throw new ValidationException(
        `Identifiants incomplets : ${missing.join(', ')}.`,
        { details: { missing } },
      );
    }

    return result;
  }

  /**
   * Verifie qu'un compte transporteur repond (V2 §16 : `healthCheck`).
   *
   * CHARGE LE COMPTE DIRECTEMENT, ET NON VIA `resolveCarrierAccount`
   *   Les deux questions se ressemblent mais ne sont pas la meme :
   *   `resolveCarrierAccount` repond a « avec quel compte puis-je EXPEDIER ? »
   *   et n'accepte donc qu'un compte deja `CONNECTED` ou `DEGRADED`. Ici la
   *   question est « ce compte repond-il ? », et elle se pose justement pour
   *   les comptes dont on ne sait encore rien.
   *
   *   Les confondre creait une impasse : un compte nait `PENDING_SETUP`, le
   *   controle de sante est le seul chemin vers `CONNECTED`, et ce chemin
   *   refusait `PENDING_SETUP`. Aucun compte ne pouvait donc devenir
   *   utilisable — ce qui explique qu'il n'en ait jamais existe un seul.
   *
   *   Un compte DESACTIVE reste testable, lui aussi : savoir s'il repondrait
   *   est precisement ce qu'on veut avant de le remettre en service.
   */
  async checkCarrierHealth(
    tenantId: string,
    carrierAccountId: string,
  ): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
    const account = await this.prisma.carrierAccount.findFirst({
      where: { tenantId, id: carrierAccountId },
      select: {
        id: true,
        status: true,
        credentialsEncrypted: true,
        config: true,
        carrier: { select: { code: true, name: true, implementationStatus: true } },
      },
    });

    if (!account) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Compte transporteur introuvable.');
    }

    // Un transporteur sans connecteur ne peut rien repondre : le registre leve
    // NOT_IMPLEMENTED plutot que de simuler une verification (D-066).
    const adapter = this.registry.get(account.carrier.code);
    const context = this.buildCarrierContext(
      {
        credentialsEncrypted: account.credentialsEncrypted,
        config: account.config as Record<string, unknown>,
      },
      tenantId,
    );

    const health = await adapter.healthCheck(context);

    await this.prisma.carrierAccount.update({
      where: { id: account.id },
      data: {
        lastHealthCheckAt: this.clock.now(),
        lastHealthCheckOk: health.ok,
        lastErrorMessage: health.ok ? null : (health.message ?? 'Verification en echec.'),
        // `DISABLED` est une INTENTION, pas un diagnostic : le commercant a
        // decide de ne plus se servir de ce compte. Ecrire `CONNECTED` par
        // dessus le remettrait silencieusement en service, et le Dispatcher le
        // reproposerait sans que personne ne l'ait redemande. Le RESULTAT est
        // enregistre quand meme : on saura qu'il repondrait.
        ...(account.status === 'DISABLED'
          ? {}
          : { status: health.ok ? ('CONNECTED' as const) : ('DEGRADED' as const) }),
      },
    });

    return health;
  }

  // ==========================================================================
  // Utilitaires internes
  // ==========================================================================

  private async loadShippableOrder(tenantId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: {
        id: true,
        reference: true,
        externalOrderId: true,
        status: true,
        customerNameSnapshot: true,
        phoneSnapshot: true,
        wilayaCodeSnapshot: true,
        communeSnapshot: true,
        addressSnapshot: true,
        deliveryType: true,
        totalCentimes: true,
        itemsTotalCentimes: true,
        notes: true,
        address: { select: { wilayaName: true, commune: true, addressText: true } },
        customer: { select: { secondaryPhone: true } },
        items: {
          select: { productNameSnapshot: true, skuSnapshot: true, quantity: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(ERROR_CODES.ORDER_NOT_FOUND, 'Commande introuvable.');
    }

    if (order.status !== 'READY_TO_SHIP') {
      throw new ConflictException(
        ERROR_CODES.ORDER_INVALID_TRANSITION,
        `Seule une commande PRETE A EXPEDIER peut etre confiee au transporteur. ` +
          `Statut actuel : ${order.status}.`,
        { details: { currentStatus: order.status } },
      );
    }

    if (order.wilayaCodeSnapshot === null || !order.addressSnapshot?.trim()) {
      throw new ValidationException(
        'Adresse de livraison incomplete : wilaya et adresse sont obligatoires.',
      );
    }

    return order;
  }

  private async resolveCarrierAccount(tenantId: string, carrierAccountId?: string) {
    const account = await this.prisma.carrierAccount.findFirst({
      where: {
        tenantId,
        ...(carrierAccountId ? { id: carrierAccountId } : { isDefault: true }),
        status: { in: ['CONNECTED', 'DEGRADED'] },
      },
      select: {
        id: true,
        credentialsEncrypted: true,
        config: true,
        sendOrderNumberInsteadOfReference: true,
        carrier: { select: { id: true, code: true, name: true, implementationStatus: true } },
      },
    });

    if (!account) {
      throw new NotFoundException(
        ERROR_CODES.CARRIER_NOT_CONFIGURED,
        carrierAccountId
          ? 'Ce compte transporteur est introuvable ou desactive.'
          : 'Aucun transporteur par defaut n est configure pour cette boutique.',
      );
    }

    // Un connecteur non implemente ne doit jamais etre utilisable : le declarer
    // disponible reviendrait a mentir sur l'etat du produit (cahier §5).
    if (account.carrier.implementationStatus !== 'AVAILABLE') {
      throw new BusinessException(
        ERROR_CODES.CARRIER_NOT_CONFIGURED,
        `Le connecteur ${account.carrier.name} n est pas encore disponible ` +
          '(integration planifiee). Choisissez un autre transporteur.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    return {
      id: account.id,
      carrierId: account.carrier.id,
      carrierCode: account.carrier.code,
      carrierName: account.carrier.name,
      credentialsEncrypted: account.credentialsEncrypted,
      config: account.config as Record<string, unknown>,
      sendOrderNumberInsteadOfReference: account.sendOrderNumberInsteadOfReference,
    };
  }

  /** Dechiffre les identifiants du compte, lies au tenant par l'AAD. */
  private buildCarrierContext(
    account: {
      credentialsEncrypted: string | null;
      config: Record<string, unknown>;
    },
    tenantId: string,
  ): CarrierContext {
    const credentials = account.credentialsEncrypted
      ? this.encryption.decryptJson<Record<string, string>>(account.credentialsEncrypted, tenantId)
      : {};

    return { credentials, config: account.config };
  }

  private buildShipmentRequest(
    order: Awaited<ReturnType<ShipmentsService['loadShippableOrder']>>,
    idempotencyKey: string,
    input: CreateShipmentInput,
    options: { sendOrderNumberInsteadOfReference: boolean },
  ): ShipmentRequest {
    // CE QUE LE TRANSPORTEUR VOIT, ET CE QUE LE COMMERCANT DIT AU TELEPHONE
    //   Par defaut, le colis part avec la reference EcomFlow. Certaines
    //   boutiques preferent y voir le numero de commande de leur source —
    //   celui qu'elles ont sous les yeux dans leur feuille quand elles
    //   appellent le transporteur pour retrouver un colis.
    //
    //   A defaut de numero externe (commande saisie a la main), la reference
    //   EcomFlow reste envoyee : mieux vaut une reference que rien du tout.
    const reference =
      options.sendOrderNumberInsteadOfReference && order.externalOrderId
        ? order.externalOrderId
        : order.reference;

    return {
      idempotencyKey,
      orderReference: reference,
      customerName: order.customerNameSnapshot,
      phoneE164: order.phoneSnapshot,
      secondaryPhone: order.customer.secondaryPhone,
      wilayaCode: order.wilayaCodeSnapshot as number,
      wilayaName: order.address?.wilayaName ?? '',
      commune: order.communeSnapshot ?? order.address?.commune ?? '',
      addressText: order.addressSnapshot ?? order.address?.addressText ?? '',
      // Le mode convenu AVEC LE CLIENT pendant l'appel fait foi ; l'appelant ne
      // le force que s'il le precise explicitement. Auparavant ce parametre
      // valait toujours « domicile » a defaut, et un client qui avait demande
      // le bureau voyait quand meme un livreur se presenter chez lui.
      deliveryType: input.deliveryType ?? order.deliveryType,
      pickupPointId: input.pickupPointId ?? null,
      // En COD, le montant a encaisser est le TOTAL, frais de livraison compris.
      codAmountCentimes: order.totalCentimes,
      declaredValueCentimes: order.itemsTotalCentimes,
      weightGrams: input.weightGrams ?? null,
      items: order.items.map((item) => ({
        name: item.productNameSnapshot,
        sku: item.skuSnapshot,
        quantity: item.quantity,
      })),
      notes: input.notes ?? order.notes,
      allowOpening: input.allowOpening ?? true,
      allowExchange: false,
    };
  }

  /** Statuts consideres actifs, expose pour les tests et le tracking. */
  static isActiveStatus(status: ShipmentStatus): boolean {
    return ACTIVE_SHIPMENT_STATUSES.includes(status);
  }
}
