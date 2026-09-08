/**
 * Journal d'audit des operations sensibles (V1 §20, V2 §23).
 *
 * REGLES NON NEGOCIABLES
 *
 *  1. APPEND-ONLY. Aucune methode de modification ni de suppression n'est
 *     exposee. Le nettoyage par retention est un job dedie, trace lui-meme.
 *
 *  2. AUCUN SECRET. Les metadonnees passent par une liste noire de cles
 *     (mot de passe, jeton, cle d'API...) ET par une troncature. Un
 *     developpeur qui journaliserait par megarde un corps de requete complet
 *     ne peut pas faire fuiter un secret dans l'audit.
 *
 *  3. L'ECHEC D'AUDIT NE CASSE PAS L'ACTION METIER. Une commande confirmee
 *     doit le rester meme si l'ecriture du journal echoue. L'echec est
 *     journalise en `error` pour etre detecte par la supervision.
 *
 *  4. IDENTITE FIGEE. `actorLabel` conserve une trace lisible de l'auteur
 *     meme apres anonymisation de son compte : l'audit doit rester
 *     exploitable, sans pour autant reconstituer une donnee personnelle
 *     effacee (on y stocke l'e-mail masque, pas l'e-mail complet).
 */

import { Injectable, Logger } from '@nestjs/common';
import type { AuditAction } from '@ecomflow/shared';
import { RequestContextStore } from '../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';
import type { PrismaTransactionClient } from '../../infra/prisma/prisma.service';

/** Cles dont la valeur n'est JAMAIS ecrite dans le journal. */
const REDACTED_KEYS = [
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'apikey',
  'api_key',
  'clientsecret',
  'authorization',
  'cookie',
  'credentials',
  'credentialsencrypted',
  'signature',
  'otp',
  'code',
  'proof',
  'pepper',
  'encryptionkey',
];

const MAX_METADATA_STRING_LENGTH = 500;
const MAX_METADATA_DEPTH = 4;
import { asPrimitiveString } from '../../common/utils/text';

export interface AuditEntry {
  readonly action: AuditAction | (string & {});
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly metadata?: Record<string, unknown>;
  /** Force le tenant, sinon celui du contexte courant est utilise. */
  readonly tenantId?: string | null;
  /** Force l'acteur, sinon celui du contexte courant est utilise. */
  readonly actorUserId?: string | null;
  readonly actorLabel?: string | null;
  readonly actorKind?: 'USER' | 'SYSTEM';
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectPrisma() private readonly prisma: PrismaClientExtended) {}

  /**
   * Enregistre une entree d'audit.
   *
   * N'echoue jamais : une erreur d'ecriture est journalisee mais n'interrompt
   * pas l'action metier appelante.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.write(this.prisma, entry);
    } catch (error) {
      this.logger.error(
        `Ecriture du journal d audit impossible (action=${entry.action}) : ${(error as Error).message}`,
      );
    }
  }

  /**
   * Enregistre une entree DANS une transaction en cours.
   *
   * A utiliser quand l'audit doit etre atomique avec l'action : un changement
   * de statut de commande et sa trace sont ecrits ensemble, ou pas du tout.
   * Contrairement a `record`, une erreur est ici propagee : elle annule la
   * transaction, ce qui est le comportement voulu.
   */
  async recordInTransaction(tx: PrismaTransactionClient, entry: AuditEntry): Promise<void> {
    await this.write(tx, entry);
  }

  private async write(
    client: PrismaClientExtended | PrismaTransactionClient,
    entry: AuditEntry,
  ): Promise<void> {
    const context = RequestContextStore.get();

    await client.auditLog.create({
      data: {
        tenantId: entry.tenantId !== undefined ? entry.tenantId : (context?.tenantId ?? null),
        actorUserId: entry.actorUserId !== undefined ? entry.actorUserId : (context?.userId ?? null),
        actorKind: entry.actorKind ?? (context?.userId ? 'USER' : 'SYSTEM'),
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ? (sanitizeMetadata(entry.metadata) as object) : undefined,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent?.slice(0, 255) ?? null,
        correlationId: context?.correlationId ?? null,
      },
    });
  }
}

/**
 * Nettoie les metadonnees avant ecriture.
 *
 * Exportee pour etre testee unitairement : c'est une garantie de securite,
 * elle merite ses propres tests plutot qu'une confiance aveugle.
 */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > MAX_METADATA_DEPTH) return '[profondeur maximale atteinte]';

  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    return value.length > MAX_METADATA_STRING_LENGTH
      ? `${value.slice(0, MAX_METADATA_STRING_LENGTH)}…[tronque]`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    // Les tableaux tres longs sont tronques : l'audit doit rester lisible et
    // ne pas devenir un second stockage des donnees metier.
    const limited = value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));
    return value.length > 50 ? [...limited, `…${value.length - 50} element(s) supplementaire(s)`] : limited;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.includes(key.toLowerCase())) {
        result[key] = '[expurge]';
        continue;
      }
      result[key] = sanitizeMetadata(entry, depth + 1);
    }
    return result;
  }

  // Fonctions, symboles, BigInt : hors perimetre d'un journal.
  return asPrimitiveString(value) ?? `[${typeof value}]`;
}
