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
  ORDER_STATUS_LABELS,
  buildPageMeta,
  isTerminalStatus,
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
  /**
   * La ligne peut-elle revenir a son emplacement d'origine ?
   *
   * CALCULE ICI, PAS DECOUVERT AU CLIC. Une action proposee qui echoue est
   * exactement le defaut que la matrice de capacites transporteur a servi a
   * supprimer (D-049) : on ne dessine pas un bouton qui ne marchera pas.
   */
  readonly restorable: boolean;
  /** Pourquoi la ligne ne peut pas revenir. `null` quand elle le peut. */
  readonly blockedReason: string | null;
}

export interface RestoreSelection {
  readonly orders?: readonly string[];
  readonly products?: readonly string[];
  readonly customers?: readonly string[];
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
              status: true,
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
            select: {
              id: true,
              fullName: true,
              phoneE164: true,
              anonymizedAt: true,
              archivedAt: true,
            },
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
        // Une commande ANNULEE ne peut pas revenir en file : `CANCELLED` est
        // declare terminal (`TERMINAL_ORDER_STATUSES`), et un test interdit
        // nommement `CANCELLED -> TO_CONFIRM`. Lever `archivedAt` la sortirait
        // de la corbeille en la laissant annulee — visible nulle part ou l'on
        // travaille. On le DIT au lieu de le decouvrir au clic.
        ...(isTerminalStatus(row.status)
          ? {
              restorable: false,
              blockedReason: `${row.reference} est ${ORDER_STATUS_LABELS[row.status].toLowerCase()} : ce statut est definitif, la commande ne peut pas reprendre son cours.`,
            }
          : { restorable: true, blockedReason: null }),
      })),
      ...products.map((row) => ({
        kind: 'PRODUCT' as const,
        id: row.id,
        label: row.name,
        sublabel: row.sku,
        archivedAt: row.archivedAt as Date,
        restorable: true,
        blockedReason: null,
      })),
      ...customers.map((row) => ({
        kind: 'CUSTOMER' as const,
        id: row.id,
        label: row.fullName,
        sublabel: row.phoneE164,
        archivedAt: row.archivedAt as Date,
        // Un client anonymise n'a plus rien a restaurer : ses donnees
        // personnelles sont effacees, volontairement et sans retour.
        ...(row.anonymizedAt
          ? {
              restorable: false,
              blockedReason: 'Ce client a ete anonymise : il n y a plus de donnees a restaurer.',
            }
          : { restorable: true, blockedReason: null }),
      })),
    ].sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());

    const start = (page - 1) * take;

    return {
      data: items.slice(start, start + take),
      meta: buildPageMeta(page, take, items.length),
    };
  }

  /**
   * Remet des lignes archivees a leur emplacement d'origine.
   *
   * POUR LES PRODUITS ET LES CLIENTS, LEVER `archivedAt` SUFFIT
   *   L'archivage de ces deux entites ne touche a rien d'autre : la fiche
   *   disparait des listes, et reapparait telle quelle.
   *
   * POUR LES COMMANDES, PAS TOUJOURS — ET C'EST LE PIEGE
   *   « Annuler et archiver » fait DEUX choses : passer la commande en
   *   ANNULEE, puis l'archiver. N'inverser que la seconde la sortirait de la
   *   corbeille en la laissant annulee, donc visible nulle part ou l'on
   *   travaille.
   *
   *   Inverser la premiere est IMPOSSIBLE en l'etat : `CANCELLED` figure dans
   *   `TERMINAL_ORDER_STATUSES`, et un test interdit nommement
   *   `CANCELLED -> TO_CONFIRM`. Ce n'est pas un oubli mais une regle ecrite.
   *
   *   Ces lignes sont donc REFUSEES, avec leur motif — et signalees comme non
   *   restaurables dans la liste, pour que le bouton ne soit meme pas propose.
   *   Une commande archivee SANS avoir ete annulee, elle, revient sans
   *   difficulte : son statut n'a jamais change.
   */
  async restore(
    tenantId: string,
    selection: RestoreSelection,
    membershipId: string,
  ): Promise<BulkArchiveResult> {
    const restored: string[] = [];
    const skipped: BulkArchiveSkip[] = [];

    const log = (kind: ArchivedKind, id: string, label: string) =>
      this.audit.record({
        action: 'ORDER_UPDATED',
        entityType: kind,
        entityId: id,
        tenantId,
        metadata: { restored: true, label, membershipId },
      });

    for (const id of selection.orders ?? []) {
      const order = await this.prisma.order.findFirst({
        where: { tenantId, id, archivedAt: { not: null } },
        select: { reference: true, status: true },
      });

      if (!order) {
        skipped.push({
          id,
          code: ERROR_CODES.NOT_FOUND,
          message: 'Commande introuvable ou non archivee.',
        });
        continue;
      }

      if (isTerminalStatus(order.status)) {
        skipped.push({
          id,
          code: ERROR_CODES.ORDER_INVALID_TRANSITION,
          message: `${order.reference} est ${ORDER_STATUS_LABELS[order.status].toLowerCase()} : ce statut est definitif, la commande ne peut pas reprendre son cours.`,
        });
        continue;
      }

      await this.prisma.order.updateMany({
        where: { tenantId, id },
        data: { archivedAt: null },
      });
      await log('ORDER', id, order.reference);
      restored.push(id);
    }

    for (const id of selection.products ?? []) {
      const product = await this.prisma.product.findFirst({
        where: { tenantId, id, archivedAt: { not: null } },
        select: { name: true },
      });

      if (!product) {
        skipped.push({
          id,
          code: ERROR_CODES.NOT_FOUND,
          message: 'Produit introuvable ou non archive.',
        });
        continue;
      }

      // DEUX NIVEAUX A RELEVER, ET UN QU'ON NE TOUCHE PAS.
      //
      //   `archiveProduct` pose `archivedAt` sur le produit ET sur ses
      //   variantes. Ne relever que celui du produit le ferait reapparaitre
      //   sans aucune declinaison vendable — une fiche vide, inutilisable.
      //
      //   Il pose AUSSI `isActive: false`, et celui-la reste en place : rien ne
      //   permet de distinguer un produit desactive PAR l'archivage d'un
      //   produit que le commercant avait deja retire de la vente. Le remettre
      //   en vente d'office reactiverait des articles qu'on avait
      //   volontairement sortis. Le produit revient donc visible mais inactif,
      //   et sa reactivation reste un geste conscient.
      await this.prisma.product.updateMany({
        where: { tenantId, id },
        data: { archivedAt: null },
      });
      await this.prisma.productVariant.updateMany({
        where: { tenantId, productId: id },
        data: { archivedAt: null },
      });
      await log('PRODUCT', id, product.name);
      restored.push(id);
    }

    for (const id of selection.customers ?? []) {
      const customer = await this.prisma.customer.findFirst({
        where: { tenantId, id, archivedAt: { not: null } },
        select: { fullName: true, anonymizedAt: true },
      });

      if (!customer) {
        skipped.push({
          id,
          code: ERROR_CODES.NOT_FOUND,
          message: 'Client introuvable ou non archive.',
        });
        continue;
      }

      if (customer.anonymizedAt) {
        skipped.push({
          id,
          code: ERROR_CODES.CONFLICT,
          message: 'Ce client a ete anonymise : il n y a plus de donnees a restaurer.',
        });
        continue;
      }

      await this.prisma.customer.updateMany({
        where: { tenantId, id },
        data: { archivedAt: null },
      });
      await log('CUSTOMER', id, customer.fullName);
      restored.push(id);
    }

    return { archived: restored.length, skipped };
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
