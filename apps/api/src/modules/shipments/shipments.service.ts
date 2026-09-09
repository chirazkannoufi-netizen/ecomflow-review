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
import type { Prisma } from '@prisma/client';
import { ACTIVE_SHIPMENT_STATUSES, ERROR_CODES, type ShipmentStatus } from '@ecomflow/shared';
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
import { CarrierRegistry } from './carriers/carrier.registry';
import type { CarrierContext, ShipmentRequest } from './carriers/carrier-adapter.interface';

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
    const request = this.buildShipmentRequest(order, idempotencyKey, input);

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
          carrier: { select: { id: true, code: true, name: true } },
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
        carrier: { select: { code: true, name: true } },
        events: { orderBy: { occurredAt: 'desc' }, take: 20 },
      },
    });
  }

  /** Comptes transporteur configures pour la boutique. */
  async listCarrierAccounts(tenantId: string) {
    return this.prisma.carrierAccount.findMany({
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
        carrier: {
          select: {
            code: true,
            name: true,
            supportsWebhooks: true,
            supportsCancellation: true,
            implementationStatus: true,
          },
        },
      },
    });
  }

  /** Verifie qu'un compte transporteur repond (V2 §16 : `healthCheck`). */
  async checkCarrierHealth(
    tenantId: string,
    carrierAccountId: string,
  ): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
    const account = await this.resolveCarrierAccount(tenantId, carrierAccountId);
    const adapter = this.registry.get(account.carrierCode);
    const context = this.buildCarrierContext(account, tenantId);

    const health = await adapter.healthCheck(context);

    await this.prisma.carrierAccount.update({
      where: { id: account.id },
      data: {
        lastHealthCheckAt: this.clock.now(),
        lastHealthCheckOk: health.ok,
        lastErrorMessage: health.ok ? null : (health.message ?? 'Verification en echec.'),
        status: health.ok ? 'CONNECTED' : 'DEGRADED',
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
  ): ShipmentRequest {
    return {
      idempotencyKey,
      orderReference: order.reference,
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
