/**
 * Corbeille de la boutique : ce qui a ete archive, et ce qu'on peut en faire.
 *
 * POURQUOI UNE VUE UNIQUE SUR TROIS ENTITES
 *   Archiver est le meme geste partout — retirer des listes sans rien effacer.
 *   Mais jusqu'ici, ce qui avait ete retire n'etait visible NULLE PART : une
 *   commande archivee par erreur ne se retrouvait qu'en connaissant sa
 *   reference. Une corbeille par ecran aurait multiplie par trois un besoin qui
 *   se formule d'une seule facon : « qu'est-ce que j'ai mis de cote ? ».
 *
 * LA SUPPRESSION DEFINITIVE REFUSE PLUS SOUVENT QU'ELLE N'ACCEPTE
 *   Les cles etrangeres du schema sont en `Restrict` la ou l'historique doit
 *   survivre :
 *     - un CLIENT qui a passe une commande ne peut pas etre efface
 *       (`Order.customer`) ;
 *     - un PRODUIT qui a connu un mouvement de stock ou figure sur une ligne de
 *       commande non plus (`InventoryMovement.variant`, `OrderItem.variant`) ;
 *     - une COMMANDE dont une ligne a fait l'objet d'un retour non plus
 *       (`ReturnItem.orderItem`).
 *
 *   Ce n'est pas un defaut a contourner : c'est la garantie que les chiffres
 *   passes restent calculables. Le service ne force donc rien — il tente, et
 *   rend compte ligne par ligne du motif de chaque refus.
 *
 *   En pratique, sur des donnees reelles, la quasi-totalite des produits et la
 *   majorite des clients sont concernes. L'ecran doit le dire plutot que de
 *   laisser croire a une panne.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  buildPageMeta,
  toSkipTake,
  type BulkArchiveResult,
  type BulkArchiveSkip,
  type Paginated,
} from '@ecomflow/shared';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export type ArchivedKind = 'ORDER' | 'PRODUCT' | 'CUSTOMER';

export interface ArchivedItem {
  readonly kind: ArchivedKind;
  readonly id: string;
  /** Ce qui identifie la ligne pour un humain : reference, nom, telephone. */
  readonly label: string;
  readonly sublabel: string | null;
  readonly archivedAt: Date;
}

export interface PurgeSelection {
  readonly orders?: readonly string[];
  readonly products?: readonly string[];
  readonly customers?: readonly string[];
}

/** Code Prisma d'une violation de cle etrangere. */
const FOREIGN_KEY_VIOLATION = 'P2003';

@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly audit: AuditService,
  ) {}

  /**
   * Liste unifiee, triee du plus recemment archive au plus ancien.
   *
   * Les trois requetes sont lancees en parallele puis fusionnees EN MEMOIRE.
   * Une union SQL serait plus economique, mais imposerait du SQL brut sur trois
   * tables — donc trois filtres `tenant_id` ecrits a la main, hors de portee du
   * garde d'isolation (D-004). Le volume d'une corbeille ne justifie pas
   * d'echanger une garantie contre quelques millisecondes.
   */
  async list(
    tenantId: string,
    filters: { kind?: ArchivedKind } = {},
    options: { page?: number; pageSize?: number } = {},
  ): Promise<Paginated<ArchivedItem>> {
    const { take } = toSkipTake(options);
    const page = Math.max(1, Math.trunc(options.page ?? 1));

    const wants = (kind: ArchivedKind) => !filters.kind || filters.kind === kind;

    const [orders, products, customers] = await Promise.all([
      wants('ORDER')
        ? this.prisma.order.findMany({
            where: { tenantId, archivedAt: { not: null } },
            orderBy: { archivedAt: 'desc' },
            take: 200,
            select: {
              id: true,
              reference: true,
              customerNameSnapshot: true,
              archivedAt: true,
            },
          })
        : [],
      wants('PRODUCT')
        ? this.prisma.product.findMany({
            where: { tenantId, archivedAt: { not: null } },
            orderBy: { archivedAt: 'desc' },
            take: 200,
            select: { id: true, name: true, sku: true, archivedAt: true },
          })
        : [],
      wants('CUSTOMER')
        ? this.prisma.customer.findMany({
            where: { tenantId, archivedAt: { not: null } },
            orderBy: { archivedAt: 'desc' },
            take: 200,
            select: { id: true, fullName: true, phoneE164: true, archivedAt: true },
          })
        : [],
    ]);

    const items: ArchivedItem[] = [
      ...orders.map((row) => ({
        kind: 'ORDER' as const,
        id: row.id,
        label: row.reference,
        sublabel: row.customerNameSnapshot,
        archivedAt: row.archivedAt as Date,
      })),
      ...products.map((row) => ({
        kind: 'PRODUCT' as const,
        id: row.id,
        label: row.name,
        sublabel: row.sku,
        archivedAt: row.archivedAt as Date,
      })),
      ...customers.map((row) => ({
        kind: 'CUSTOMER' as const,
        id: row.id,
        label: row.fullName,
        sublabel: row.phoneE164,
        archivedAt: row.archivedAt as Date,
      })),
    ].sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());

    const start = (page - 1) * take;

    return {
      data: items.slice(start, start + take),
      meta: buildPageMeta(page, take, items.length),
    };
  }

  /**
   * Supprime DEFINITIVEMENT une selection de lignes archivees.
   *
   * TROIS GARDE-FOUS, DANS CET ORDRE
   *   1. La ligne doit etre ARCHIVEE. On ne supprime jamais directement depuis
   *      une liste de travail : archiver d'abord oblige a passer par un etat ou
   *      l'erreur se rattrape encore.
   *   2. La base a le dernier mot. Une violation de cle etrangere n'est pas
   *      rattrapee ni contournee — elle devient un motif de refus lisible.
   *   3. Chaque suppression est journalisee AVANT de disparaitre : c'est la
   *      seule trace qui restera de la ligne.
   */
  async purge(
    tenantId: string,
    selection: PurgeSelection,
    membershipId: string,
  ): Promise<BulkArchiveResult> {
    const deleted: string[] = [];
    const skipped: BulkArchiveSkip[] = [];

    const run = async (
      kind: ArchivedKind,
      id: string,
      label: () => Promise<string | null>,
      remove: () => Promise<void>,
    ) => {
      const identity = await label();

      if (identity === null) {
        skipped.push({
          id,
          code: ERROR_CODES.NOT_FOUND,
          message: 'Ligne introuvable ou non archivee.',
        });
        return;
      }

      try {
        // Journalise AVANT : apres, il ne reste rien a decrire.
        await this.audit.record({
          action: 'DATA_PURGED',
          entityType: kind,
          entityId: id,
          tenantId,
          metadata: { label: identity, membershipId },
        });

        await remove();
        deleted.push(id);
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          skipped.push({ id, code: ERROR_CODES.CONFLICT, message: refusalFor(kind, identity) });
          return;
        }
        throw error;
      }
    };

    for (const id of selection.orders ?? []) {
      await run(
        'ORDER',
        id,
        async () =>
          (
            await this.prisma.order.findFirst({
              where: { tenantId, id, archivedAt: { not: null } },
              select: { reference: true },
            })
          )?.reference ?? null,
        async () => {
          await this.prisma.order.delete({ where: { id } });
        },
      );
    }

    for (const id of selection.products ?? []) {
      await run(
        'PRODUCT',
        id,
        async () =>
          (
            await this.prisma.product.findFirst({
              where: { tenantId, id, archivedAt: { not: null } },
              select: { name: true },
            })
          )?.name ?? null,
        async () => {
          await this.prisma.product.delete({ where: { id } });
        },
      );
    }

    for (const id of selection.customers ?? []) {
      await run(
        'CUSTOMER',
        id,
        async () =>
          (
            await this.prisma.customer.findFirst({
              where: { tenantId, id, archivedAt: { not: null } },
              select: { fullName: true },
            })
          )?.fullName ?? null,
        async () => {
          await this.prisma.customer.delete({ where: { id } });
        },
      );
    }

    this.logger.log(
      `Purge : ${deleted.length} ligne(s) supprimee(s), ${skipped.length} refusee(s).`,
    );

    return { archived: deleted.length, skipped };
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error).code === FOREIGN_KEY_VIOLATION
  );
}

/**
 * Le motif du refus, dans les termes du metier.
 *
 * « Violation de contrainte de cle etrangere » ne dit rien a un commercant. Ce
 * qu'il doit comprendre, c'est QUELLE trace retient la ligne — et que cette
 * trace est la raison pour laquelle ses chiffres passes restent justes.
 */
function refusalFor(kind: ArchivedKind, label: string): string {
  switch (kind) {
    case 'CUSTOMER':
      return `${label} a passe au moins une commande : sa fiche ne peut pas etre effacee sans rendre cet historique incoherent. Utilisez « Anonymiser » pour effacer ses donnees personnelles.`;
    case 'PRODUCT':
      return `${label} figure sur une commande ou un mouvement de stock : l'effacer fausserait les marges et l'inventaire deja calcules.`;
    case 'ORDER':
      return `${label} est rattachee a un retour : l'effacer romprait le lien avec la marchandise revenue.`;
  }
}
