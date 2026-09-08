/**
 * Fiches clients — V1 §19, V2 §13, Addendum §32.
 *
 * LE TELEPHONE EST LA CLE METIER.
 *   Un client est identifie par son numero normalise, unique DANS la boutique.
 *   Aucune fusion automatique n'est faite sur un autre critere : deux homonymes
 *   existent, et fusionner leurs historiques fausserait leurs scores de
 *   fiabilite respectifs — donc les decisions de l'agent (V2 §13 : « sans
 *   fusion automatique risquee »).
 *
 * DONNEES PERSONNELLES (Addendum §37, loi 18-07)
 *   La fiche contient nom, telephone et adresse : ce sont des donnees a
 *   caractere personnel. L'export est soumis a une permission distincte
 *   (`customers.export`), et l'anonymisation est possible sans detruire
 *   l'historique commercial.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ERROR_CODES,
  buildPageMeta,
  parseAlgerianPhone,
  toSkipTake,
  type Paginated,
} from '@ecomflow/shared';
import { NotFoundException, ValidationException } from '../../common/errors/business.exception';
import { ClockService } from '../../infra/clock/clock.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { CustomerStatsService } from './customer-stats.service';

export interface CustomerListItem {
  readonly id: string;
  readonly fullName: string;
  readonly phoneE164: string;
  readonly ordersCount: number;
  readonly deliveredCount: number;
  readonly refusedCount: number;
  readonly returnedCount: number;
  readonly cancelledCount: number;
  readonly reliabilityScore: number | null;
  readonly reliabilityTier: string;
  readonly lastOrderAt: Date | null;
  readonly tags: readonly string[];
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly stats: CustomerStatsService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Liste paginee.
   *
   * La recherche par telephone normalise le terme avant comparaison : saisir
   * « 0555 12 34 56 » retrouve bien « +213555123456 ».
   */
  async list(
    tenantId: string,
    filters: { search?: string; reliabilityTier?: string; tag?: string } = {},
    options: { page?: number; pageSize?: number } = {},
  ): Promise<Paginated<CustomerListItem>> {
    const { skip, take } = toSkipTake(options);
    const page = Math.max(1, Math.trunc(options.page ?? 1));

    const where: Prisma.CustomerWhereInput = { tenantId, anonymizedAt: null };

    if (filters.reliabilityTier) {
      where.reliabilityTier = filters.reliabilityTier as Prisma.CustomerWhereInput['reliabilityTier'];
    }

    if (filters.tag) where.tags = { has: filters.tag };

    if (filters.search?.trim()) {
      const term = filters.search.trim();
      const phone = parseAlgerianPhone(term);
      where.OR = [
        { fullName: { contains: term, mode: 'insensitive' } },
        { phoneE164: { contains: phone.ok ? phone.value.e164 : term } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: { lastOrderAt: { sort: 'desc', nulls: 'last' } },
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
          ordersCount: true,
          deliveredCount: true,
          refusedCount: true,
          returnedCount: true,
          cancelledCount: true,
          reliabilityScore: true,
          reliabilityTier: true,
          lastOrderAt: true,
          tags: true,
        },
      }),
    ]);

    return { data: rows, meta: buildPageMeta(page, take, total) };
  }

  /**
   * Fiche complete, avec historique et score explique.
   *
   * Le score est accompagne de SES FACTEURS : l'agent doit comprendre pourquoi
   * un client est signale, pas seulement voir une pastille rouge (Addendum §32).
   */
  async getById(tenantId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { tenantId, id: customerId },
      include: {
        addresses: { orderBy: { isDefault: 'desc' } },
        orders: {
          orderBy: { orderedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            reference: true,
            status: true,
            totalCentimes: true,
            orderedAt: true,
            deliveredAt: true,
            source: true,
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Client introuvable.');
    }

    const assessment = await this.stats.getAssessment(tenantId, customerId);

    return { ...customer, reliability: assessment };
  }

  /** Retrouve un client par telephone : recherche la plus utilisee par les agents. */
  async findByPhone(tenantId: string, phone: string) {
    const parsed = parseAlgerianPhone(phone);
    if (!parsed.ok) {
      throw new ValidationException('Numero de telephone invalide.');
    }

    return this.prisma.customer.findFirst({
      where: { tenantId, phoneE164: parsed.value.e164 },
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        ordersCount: true,
        deliveredCount: true,
        refusedCount: true,
        reliabilityScore: true,
        reliabilityTier: true,
      },
    });
  }

  async update(
    tenantId: string,
    customerId: string,
    changes: {
      fullName?: string;
      email?: string | null;
      secondaryPhone?: string | null;
      notes?: string | null;
      tags?: readonly string[];
    },
  ): Promise<void> {
    let secondaryPhone: string | null | undefined;
    if (changes.secondaryPhone !== undefined) {
      if (changes.secondaryPhone === null || changes.secondaryPhone.trim() === '') {
        secondaryPhone = null;
      } else {
        const parsed = parseAlgerianPhone(changes.secondaryPhone);
        if (!parsed.ok) {
          throw new ValidationException('Numero secondaire invalide.');
        }
        secondaryPhone = parsed.value.e164;
      }
    }

    const updated = await this.prisma.customer.updateMany({
      where: { tenantId, id: customerId, anonymizedAt: null },
      data: {
        ...(changes.fullName !== undefined ? { fullName: changes.fullName.trim() } : {}),
        ...(changes.email !== undefined ? { email: changes.email } : {}),
        ...(secondaryPhone !== undefined ? { secondaryPhone } : {}),
        ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
        ...(changes.tags !== undefined ? { tags: [...changes.tags] } : {}),
      },
    });

    if (updated.count === 0) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Client introuvable.');
    }
  }

  /** Recalcule le score depuis l'historique reel (job de reconciliation). */
  async recomputeReliability(tenantId: string, customerId: string) {
    return this.stats.recomputeFromHistory(tenantId, customerId);
  }

  /**
   * Anonymise un client sur demande d'effacement (loi 18-07, Addendum §37).
   *
   * Les donnees personnelles sont remplacees, mais l'historique COMMERCIAL est
   * conserve : les commandes, leurs montants et leurs statuts restent
   * exploitables pour la comptabilite et les statistiques. C'est la lecture
   * raisonnable du droit a l'effacement — il ne s'etend pas aux obligations
   * comptables du commercant.
   */
  async anonymize(tenantId: string, customerId: string, reason: string): Promise<void> {
    const customer = await this.prisma.customer.findFirst({
      where: { tenantId, id: customerId },
      select: { id: true, anonymizedAt: true },
    });

    if (!customer) {
      throw new NotFoundException(ERROR_CODES.NOT_FOUND, 'Client introuvable.');
    }

    if (customer.anonymizedAt) return;

    const now = this.clock.now();
    // Numero de remplacement unique : la contrainte d'unicite par boutique
    // doit rester satisfaite apres anonymisation.
    const placeholder = `+213000${customerId.replace(/\D/g, '').slice(0, 6).padStart(6, '0')}`;

    await this.prisma.$transaction([
      this.prisma.customer.update({
        where: { id: customerId },
        data: {
          fullName: 'Client anonymise',
          phoneE164: placeholder,
          phoneRaw: null,
          secondaryPhone: null,
          email: null,
          notes: null,
          tags: [],
          anonymizedAt: now,
        },
      }),
      this.prisma.address.updateMany({
        where: { tenantId, customerId },
        data: { addressText: 'Adresse anonymisee', addressNormalized: null },
      }),
      this.prisma.order.updateMany({
        where: { tenantId, customerId },
        data: {
          customerNameSnapshot: 'Client anonymise',
          phoneSnapshot: placeholder,
          addressSnapshot: null,
        },
      }),
    ]);

    this.logger.log(
      `Client ${customerId} anonymise (boutique ${tenantId}). Motif : ${reason}. ` +
        'Historique commercial conserve.',
    );
  }
}
