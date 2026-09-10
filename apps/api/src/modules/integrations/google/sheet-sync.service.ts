/**
 * Synchronisation Google Sheets -> commandes EcomFlow.
 *
 * Implemente le flux technique de la V2 §29 :
 *   OAuth -> selection du classeur/onglet -> mapping -> test -> premiere
 *   synchronisation controlee -> job periodique -> import -> validation ->
 *   deduplication -> creation -> journal.
 *
 * IDEMPOTENCE (V2 §12, cahier de mission §15)
 *   Chaque ligne source recoit une EMPREINTE stable :
 *     - l'identifiant externe de la ligne s'il existe (le plus fiable) ;
 *     - sinon un hash SHA-256 des valeurs metier de la ligne.
 *   Le NUMERO DE LIGNE n'est jamais utilise seul : inserer une ligne au milieu
 *   de la feuille decalerait toutes les suivantes et recreerait des dizaines de
 *   commandes deja traitees.
 *   L'empreinte est stockee avec un index UNIQUE `(config_id, fingerprint)` :
 *   la deduplication est donc garantie par la BASE, pas par une verification
 *   applicative qui laisserait une fenetre de course entre deux jobs.
 *
 * AUCUNE COMMANDE PERDUE SUR QUOTA (Addendum §39)
 *   Sur HTTP 429, la synchronisation s'arrete proprement, enregistre l'instant
 *   de reprise (`backoffUntil`) et la position atteinte (`lastProcessedRow`).
 *   L'execution suivante reprend exactement la ou elle s'etait arretee.
 *
 * ETALEMENT DE LA CHARGE
 *   Chaque configuration recoit un decalage de planification stable, derive de
 *   son identifiant. Cent boutiques configurees « toutes les 10 minutes » ne
 *   declenchent donc pas cent lectures a la meme seconde.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RunStatus, SyncTrigger } from '@prisma/client';
import { ERROR_CODES, buildSheetRowFingerprintSource } from '@ecomflow/shared';
import { ClockService } from '../../../infra/clock/clock.service';
import { RequestContextStore } from '../../../infra/context/request-context';
import { InjectPrisma, type PrismaClientExtended } from '../../../infra/prisma/prisma.service';
import { isUniqueConstraintError } from '../../../infra/prisma/prisma.service';
import {
  BusinessException,
  ConflictException,
  NotFoundException,
} from '../../../common/errors/business.exception';
import { HttpStatus } from '@nestjs/common';
import { OrdersService } from '../../orders/orders.service';
import { OutboxService, DOMAIN_EVENTS } from '../../events/outbox.service';
import { AppConfigService } from '../../../config/configuration';
import { GoogleOAuthService } from './google-oauth.service';
import {
  GoogleQuotaExceededError,
  GoogleSheetsApiError,
  GoogleSheetsClient,
} from './google-sheets.client';
import { columnToIndex, indexToColumn, parseRow, type ColumnMapping } from './sheet-row.parser';

export interface SyncResult {
  readonly syncRunId: string;
  readonly status: RunStatus;
  readonly rowsScanned: number;
  readonly rowsImported: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
  readonly retryAt: Date | null;
  readonly errorMessage: string | null;
}

/** Colonne la plus a droite lue par defaut : couvre 26 colonnes (A..Z). */
const DEFAULT_LAST_COLUMN = 'Z';

@Injectable()
export class SheetSyncService {
  private readonly logger = new Logger(SheetSyncService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly oauth: GoogleOAuthService,
    private readonly sheets: GoogleSheetsClient,
    private readonly orders: OrdersService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
  ) {}

  // ==========================================================================
  // SYNCHRONISATION
  // ==========================================================================

  /**
   * Synchronise une configuration.
   *
   * @param dryRun n'ecrit aucune commande : sert au « test d'import » de
   *        l'assistant d'onboarding (Addendum §34), ou le commercant doit
   *        pouvoir verifier son mapping SANS polluer sa base.
   */
  async sync(
    tenantId: string,
    configId: string,
    trigger: SyncTrigger,
    options: { dryRun?: boolean; maxRows?: number } = {},
  ): Promise<SyncResult> {
    const config = await this.loadConfig(tenantId, configId);

    // --- Verrou de concurrence -------------------------------------------
    // Deux synchronisations simultanees sur la meme feuille produiraient des
    // lectures redondantes et consommeraient deux fois le quota.
    const running = await this.prisma.syncRun.findFirst({
      where: { tenantId, configId, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true, startedAt: true },
    });

    if (running) {
      // Une execution bloquee depuis plus de 15 minutes est consideree comme
      // morte (processus tue) : on la clot pour ne pas bloquer la feuille
      // indefiniment.
      const stale =
        running.startedAt !== null &&
        this.clock.timestamp() - running.startedAt.getTime() > 15 * 60_000;

      if (!stale) {
        throw new ConflictException(
          ERROR_CODES.SYNC_ALREADY_RUNNING,
          'Une synchronisation est deja en cours pour cette feuille.',
        );
      }

      await this.prisma.syncRun.update({
        where: { id: running.id },
        data: {
          status: 'FAILED',
          errorMessage: 'Execution interrompue (processus arrete). Cloturee automatiquement.',
          finishedAt: this.clock.now(),
        },
      });
    }

    // --- Respect du delai de reprise apres quota --------------------------
    if (config.backoffUntil && this.clock.isFuture(config.backoffUntil) && trigger !== 'MANUAL') {
      this.logger.debug(
        `Synchronisation ${configId} differee jusqu a ${config.backoffUntil.toISOString()} (quota).`,
      );
      return {
        syncRunId: '',
        status: 'RATE_LIMITED',
        rowsScanned: 0,
        rowsImported: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        retryAt: config.backoffUntil,
        errorMessage: 'Reprise differee : quota Google atteint.',
      };
    }

    const run = await this.prisma.syncRun.create({
      data: {
        tenantId,
        integrationId: config.integrationId,
        configId,
        trigger,
        status: 'RUNNING',
        startedAt: this.clock.now(),
      },
      select: { id: true },
    });

    const startedAt = this.clock.timestamp();

    try {
      const result = await this.runSync(tenantId, config, run.id, options);
      await this.finishRun(run.id, result, startedAt);
      await this.updateConfigAfterSuccess(configId, result);
      return { ...result, syncRunId: run.id };
    } catch (error) {
      return this.handleSyncFailure(tenantId, config, run.id, error, startedAt);
    }
  }

  private async runSync(
    tenantId: string,
    config: SheetConfig,
    syncRunId: string,
    options: { dryRun?: boolean; maxRows?: number },
  ): Promise<Omit<SyncResult, 'syncRunId'>> {
    const accessToken = await this.oauth.getAccessToken(tenantId);
    const mapping = config.columnMapping;

    const maxRows = options.maxRows ?? this.config.google.maxRowsPerRun;
    const firstRow = Math.max(config.firstDataRow, config.lastProcessedRow + 1);
    const lastRow = firstRow + maxRows - 1;
    const lastColumn = this.resolveLastColumn(mapping);
    const range = `'${config.sheetName}'!A${firstRow}:${lastColumn}${lastRow}`;

    const sheet = await this.sheets.getValues(accessToken, config.spreadsheetId, range);

    let rowsScanned = 0;
    let rowsImported = 0;
    let rowsSkipped = 0;
    let rowsFailed = 0;
    let lastNonEmptyRow = config.lastProcessedRow;

    for (const [offset, values] of sheet.values.entries()) {
      const sourceRowNumber = firstRow + offset;

      // Une ligne entierement vide marque generalement la fin des donnees ;
      // on la saute sans la compter ni avancer le curseur, au cas ou le
      // commercant remplirait plus bas.
      if (values.every((cell) => cell.trim().length === 0)) continue;

      rowsScanned += 1;
      lastNonEmptyRow = sourceRowNumber;

      const fingerprint = this.computeFingerprint(config, values, mapping);

      // --- Deja importee ? ------------------------------------------------
      const existing = await this.prisma.sheetRowImport.findFirst({
        where: { configId: config.id, fingerprint },
        select: { id: true, status: true },
      });

      if (existing && existing.status !== 'FAILED') {
        rowsSkipped += 1;
        continue;
      }

      // --- Analyse ---------------------------------------------------------
      const parsed = parseRow(values, mapping, {
        defaultDeliveryFeeCentimes: 0,
        defaultQuantity: 1,
      });

      if (!parsed.ok) {
        rowsFailed += 1;
        if (!options.dryRun) {
          await this.recordRowFailure(
            tenantId,
            config.id,
            syncRunId,
            fingerprint,
            sourceRowNumber,
            values,
            parsed.code,
            parsed.message,
            existing?.id,
          );
        }
        continue;
      }

      // --- Filtre optionnel sur le statut source ---------------------------
      if (
        config.acceptedSourceStatuses.length > 0 &&
        parsed.value.sourceStatus &&
        !config.acceptedSourceStatuses.some(
          (accepted) => accepted.toLowerCase() === parsed.value.sourceStatus?.toLowerCase(),
        )
      ) {
        rowsSkipped += 1;
        continue;
      }

      if (options.dryRun) {
        rowsImported += 1;
        continue;
      }

      // --- Creation de la commande ----------------------------------------
      try {
        const created = await this.orders.createOrder({
          tenantId,
          source: 'GOOGLE_SHEETS',
          externalOrderId: fingerprint,
          customerName: parsed.value.customerName,
          phone: parsed.value.phoneE164,
          wilaya: parsed.value.wilayaCode,
          commune: parsed.value.commune,
          addressText: parsed.value.addressText,
          lines: [
            {
              sku: parsed.value.sku ?? undefined,
              quantity: parsed.value.quantity,
              ...(parsed.value.unitPriceCentimes !== null
                ? { unitPriceCentimes: parsed.value.unitPriceCentimes }
                : {}),
            },
          ],
          deliveryFeeCentimes: parsed.value.deliveryFeeCentimes,
          expectedTotalCentimes: parsed.value.totalCentimes,
          notes: parsed.value.notes,
          orderedAt: parsed.value.orderedAt ?? this.clock.now(),
        });

        await this.recordRowSuccess(
          tenantId,
          config.id,
          syncRunId,
          fingerprint,
          sourceRowNumber,
          parsed.value.externalId,
          created.orderId,
          created.alreadyExisted,
          existing?.id,
        );

        if (created.alreadyExisted) rowsSkipped += 1;
        else rowsImported += 1;
      } catch (error) {
        rowsFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        // Trois familles, pas deux. Un article regle sur « refuser la commande »
        // fait echouer la ligne DELIBEREMENT : la ranger dans
        // `UNEXPECTED_ERROR` ferait passer une decision du commercant pour une
        // panne de la synchronisation, et enverrait chercher un bug la ou il
        // n'y a qu'un stock vide.
        const code = !(error instanceof BusinessException)
          ? 'UNEXPECTED_ERROR'
          : error.code === ERROR_CODES.VALIDATION_FAILED
            ? 'MAPPING_ERROR'
            : error.code === ERROR_CODES.INSUFFICIENT_STOCK
              ? 'STOCK_REFUSED'
              : 'UNEXPECTED_ERROR';

        await this.recordRowFailure(
          tenantId,
          config.id,
          syncRunId,
          fingerprint,
          sourceRowNumber,
          values,
          code,
          message,
          existing?.id,
        );
      }
    }

    // Le curseur n'avance QUE sur les lignes reellement examinees : une
    // interruption a mi-parcours ne fait donc jamais sauter de lignes.
    if (!options.dryRun && lastNonEmptyRow > config.lastProcessedRow) {
      await this.prisma.sheetSyncConfig.update({
        where: { id: config.id },
        data: { lastProcessedRow: lastNonEmptyRow },
      });
    }

    const status: RunStatus =
      rowsFailed === 0 ? 'SUCCESS' : rowsImported > 0 || rowsSkipped > 0 ? 'PARTIAL_SUCCESS' : 'FAILED';

    return {
      status,
      rowsScanned,
      rowsImported,
      rowsSkipped,
      rowsFailed,
      retryAt: null,
      errorMessage: null,
    };
  }

  // ==========================================================================
  // GESTION DES ERREURS
  // ==========================================================================

  /**
   * Traite un echec de synchronisation.
   *
   * Le cas du QUOTA est traite a part : ce n'est pas une panne mais une
   * limite attendue. On enregistre l'instant de reprise et on notifie la
   * boutique sans marquer l'integration en erreur — elle fonctionne
   * parfaitement, elle attend simplement son tour.
   */
  private async handleSyncFailure(
    tenantId: string,
    config: SheetConfig,
    syncRunId: string,
    error: unknown,
    startedAt: number,
  ): Promise<SyncResult> {
    const durationMs = this.clock.timestamp() - startedAt;

    if (error instanceof GoogleQuotaExceededError) {
      await this.prisma.$transaction(async (tx) => {
        await tx.syncRun.update({
          where: { id: syncRunId },
          data: {
            status: 'RATE_LIMITED',
            errorCode: ERROR_CODES.GOOGLE_QUOTA_EXCEEDED,
            errorMessage: error.message,
            retryAfter: error.retryAt,
            finishedAt: this.clock.now(),
            durationMs,
          },
        });

        await tx.sheetSyncConfig.update({
          where: { id: config.id },
          data: { backoffUntil: error.retryAt, lastSyncAt: this.clock.now() },
        });

        await this.outbox.publish(tx, {
          tenantId,
          eventType: DOMAIN_EVENTS.SYNC_RATE_LIMITED,
          payload: {
            configId: config.id,
            spreadsheetId: config.spreadsheetId,
            retryAt: error.retryAt.toISOString(),
          },
        });
      });

      this.logger.warn(
        `Quota Google atteint pour la boutique ${tenantId}. ` +
          `Reprise automatique a ${error.retryAt.toISOString()}. Aucune commande perdue.`,
      );

      return {
        syncRunId,
        status: 'RATE_LIMITED',
        rowsScanned: 0,
        rowsImported: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        retryAt: error.retryAt,
        errorMessage: error.message,
      };
    }

    const { code, message } = this.describeError(error);

    await this.prisma.$transaction(async (tx) => {
      await tx.syncRun.update({
        where: { id: syncRunId },
        data: {
          status: 'FAILED',
          errorCode: code,
          errorMessage: message,
          finishedAt: this.clock.now(),
          durationMs,
        },
      });

      await tx.sheetSyncConfig.update({
        where: { id: config.id },
        data: { consecutiveFailures: { increment: 1 }, lastSyncAt: this.clock.now() },
      });

      await tx.integration.update({
        where: { id: config.integrationId },
        data: {
          status: code === ERROR_CODES.GOOGLE_AUTH_REVOKED ? 'ERROR' : 'DEGRADED',
          lastErrorCode: code,
          lastErrorMessage: message,
          lastCheckedAt: this.clock.now(),
        },
      });

      await this.outbox.publish(tx, {
        tenantId,
        eventType: DOMAIN_EVENTS.SYNC_FAILED,
        payload: { configId: config.id, errorCode: code, errorMessage: message },
      });
    });

    this.logger.error(`Synchronisation ${config.id} en echec : ${code} — ${message}`);

    return {
      syncRunId,
      status: 'FAILED',
      rowsScanned: 0,
      rowsImported: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      retryAt: null,
      errorMessage: message,
    };
  }

  private describeError(error: unknown): { code: string; message: string } {
    if (error instanceof GoogleSheetsApiError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof BusinessException) {
      return { code: error.code, message: error.message };
    }
    return {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // ==========================================================================
  // REJEU
  // ==========================================================================

  /**
   * Rejoue les lignes en erreur d'une configuration.
   *
   * Les valeurs brutes ayant ete conservees, le rejeu n'exige pas de relire la
   * feuille : il ne consomme donc aucun quota Google, ce qui permet au
   * commercant de corriger son catalogue puis de relancer immediatement.
   */
  async retryFailedRows(tenantId: string, configId: string): Promise<{
    retried: number;
    succeeded: number;
    stillFailing: number;
  }> {
    const config = await this.loadConfig(tenantId, configId);

    const failedRows = await this.prisma.sheetRowImport.findMany({
      where: { tenantId, configId, status: 'FAILED' },
      select: { id: true, fingerprint: true, rawValues: true, sourceRowNumber: true },
      take: 500,
    });

    let succeeded = 0;
    let stillFailing = 0;

    for (const row of failedRows) {
      const values = (row.rawValues as string[] | null) ?? [];
      const parsed = parseRow(values, config.columnMapping, { defaultQuantity: 1 });

      if (!parsed.ok) {
        stillFailing += 1;
        await this.prisma.sheetRowImport.update({
          where: { id: row.id },
          data: {
            retryCount: { increment: 1 },
            errorCode: parsed.code,
            errorMessage: parsed.message,
          },
        });
        continue;
      }

      try {
        const created = await this.orders.createOrder({
          tenantId,
          source: 'GOOGLE_SHEETS',
          externalOrderId: row.fingerprint,
          customerName: parsed.value.customerName,
          phone: parsed.value.phoneE164,
          wilaya: parsed.value.wilayaCode,
          commune: parsed.value.commune,
          addressText: parsed.value.addressText,
          lines: [
            {
              sku: parsed.value.sku ?? undefined,
              quantity: parsed.value.quantity,
              ...(parsed.value.unitPriceCentimes !== null
                ? { unitPriceCentimes: parsed.value.unitPriceCentimes }
                : {}),
            },
          ],
          deliveryFeeCentimes: parsed.value.deliveryFeeCentimes,
          expectedTotalCentimes: parsed.value.totalCentimes,
          notes: parsed.value.notes,
          orderedAt: parsed.value.orderedAt ?? this.clock.now(),
        });

        await this.prisma.sheetRowImport.update({
          where: { id: row.id },
          data: {
            status: 'IMPORTED',
            orderId: created.orderId,
            errorCode: null,
            errorMessage: null,
            retryCount: { increment: 1 },
          },
        });
        succeeded += 1;
      } catch (error) {
        stillFailing += 1;
        await this.prisma.sheetRowImport.update({
          where: { id: row.id },
          data: {
            retryCount: { increment: 1 },
            errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
          },
        });
      }
    }

    return { retried: failedRows.length, succeeded, stillFailing };
  }

  // ==========================================================================
  // PLANIFICATION
  // ==========================================================================

  /**
   * Configurations dues pour synchronisation.
   *
   * Le decalage `scheduleOffsetSeconds` etale les executions : cent boutiques
   * reglees sur 10 minutes ne declenchent pas cent lectures a la meme seconde
   * (Addendum §39).
   */
  async findDueConfigs(limit = 50): Promise<
    readonly { tenantId: string; configId: string }[]
  > {
    return RequestContextStore.runUnscoped('BACKGROUND_JOB', async () => {
      const rows = await this.prisma.$queryRaw<{ tenant_id: string; id: string }[]>`
        SELECT c.tenant_id, c.id
        FROM sheet_sync_configs c
        JOIN integrations i ON i.id = c.integration_id
        JOIN subscriptions s ON s.tenant_id = c.tenant_id
        WHERE c.is_active = true
          AND i.status = 'CONNECTED'
          -- Une boutique dont l'essai est termine ne consomme plus de quota.
          AND s.status IN ('TRIAL_ACTIVE', 'TRIAL_ENDING', 'ACTIVE', 'PAST_DUE')
          AND (c.backoff_until IS NULL OR c.backoff_until <= NOW())
          AND (
            c.last_sync_at IS NULL
            OR c.last_sync_at + (c.sync_interval_minutes * INTERVAL '1 minute')
               + (c.schedule_offset_seconds * INTERVAL '1 second') <= NOW()
          )
        ORDER BY c.last_sync_at ASC NULLS FIRST
        LIMIT ${limit}
      `;

      return rows.map((row) => ({ tenantId: row.tenant_id, configId: row.id }));
    });
  }

  // ==========================================================================
  // Utilitaires internes
  // ==========================================================================

  /**
   * Empreinte stable d'une ligne source.
   *
   * DEUX STRATEGIES, dans cet ordre de preference :
   *
   *  1. L'IDENTIFIANT EXTERNE de la ligne, si le commercant dispose d'une
   *     colonne d'identifiant. C'est la strategie ideale : elle distingue
   *     parfaitement deux commandes, meme rigoureusement identiques.
   *
   *  2. A defaut, un hash des VALEURS METIER de la ligne : client, telephone,
   *     produit, quantite, date.
   *
   * LE NUMERO DE LIGNE N'ENTRE JAMAIS DANS L'EMPREINTE.
   *   C'est un choix delibere, et le point le plus subtil de tout l'import.
   *   Inclure la position rendrait l'empreinte instable : inserer une ligne au
   *   milieu de la feuille — geste banal — decalerait toutes les suivantes et
   *   recreerait des dizaines de commandes deja traitees. Le cahier des charges
   *   en fait un critere d'acceptation repete trois fois : « une
   *   resynchronisation ne cree AUCUN doublon » (V1 §29, V2 §12, V2 §37).
   *
   * LIMITE ASSUMEE, ET SA PARADE
   *   Deux lignes rigoureusement identiques — meme client, meme telephone,
   *   meme produit, meme quantite, MEME DATE — produisent la meme empreinte :
   *   la seconde est enregistree comme SKIPPED_DUPLICATE et reste visible dans
   *   le journal d'import. Le commercant qui a reellement deux commandes
   *   identiques le meme jour doit ajouter une colonne d'identifiant, ce que
   *   `externalIdColumn` prend en charge et que l'assistant de configuration
   *   recommande.
   *   Ce compromis est le bon sens : perdre silencieusement une commande est
   *   grave, mais creer des dizaines de doublons a chaque insertion de ligne
   *   l'est davantage — et le second cas se produirait tous les jours.
   *   Voir DECISIONS.md — D-028.
   */
  private computeFingerprint(
    config: SheetConfig,
    values: readonly string[],
    mapping: ColumnMapping,
  ): string {
    const externalId = config.externalIdColumn
      ? (values[columnToIndex(config.externalIdColumn)] ?? '').trim()
      : mapping.externalId !== undefined
        ? (values[columnToIndex(mapping.externalId)] ?? '').trim()
        : '';

    // Colonnes qui identifient METIER la commande. Le total, les frais et le
    // statut en sont exclus a dessein : les corriger dans la feuille ne doit
    // pas recreer la commande.
    const businessValues = (
      ['customerName', 'phone', 'sku', 'productName', 'quantity', 'date'] as const
    ).map((field) => {
      const column = mapping[field];
      if (column === undefined) return '';
      return values[columnToIndex(column)] ?? '';
    });

    const source = buildSheetRowFingerprintSource({
      spreadsheetId: config.spreadsheetId,
      sheetId: config.sheetGid,
      externalRowId: externalId.length > 0 ? externalId : null,
      businessValues: externalId.length > 0 ? undefined : businessValues,
    });

    return createHash('sha256').update(source).digest('hex').slice(0, 40);
  }

  /** Derniere colonne a lire, deduite du mapping. */
  private resolveLastColumn(mapping: ColumnMapping): string {
    let maxIndex = 0;
    for (const column of Object.values(mapping)) {
      if (column === undefined) continue;
      const index = columnToIndex(column);
      if (index > maxIndex) maxIndex = index;
    }
    return maxIndex > 0 ? indexToColumn(maxIndex) : DEFAULT_LAST_COLUMN;
  }

  private async recordRowSuccess(
    tenantId: string,
    configId: string,
    syncRunId: string,
    fingerprint: string,
    sourceRowNumber: number,
    externalRowId: string | null,
    orderId: string,
    alreadyExisted: boolean,
    existingId?: string,
  ): Promise<void> {
    const data = {
      status: alreadyExisted ? ('SKIPPED_DUPLICATE' as const) : ('IMPORTED' as const),
      orderId,
      sourceRowNumber,
      externalRowId,
      syncRunId,
      errorCode: null,
      errorMessage: null,
    };

    if (existingId) {
      await this.prisma.sheetRowImport.update({ where: { id: existingId }, data });
      return;
    }

    try {
      await this.prisma.sheetRowImport.create({
        data: { tenantId, configId, fingerprint, ...data },
      });
    } catch (error) {
      // Course entre deux executions : la contrainte UNIQUE a tranche. C'est
      // exactement le comportement voulu — la ligne n'est importee qu'une fois.
      if (!isUniqueConstraintError(error, 'fingerprint')) throw error;
    }
  }

  private async recordRowFailure(
    tenantId: string,
    configId: string,
    syncRunId: string,
    fingerprint: string,
    sourceRowNumber: number,
    values: readonly string[],
    errorCode: string,
    errorMessage: string,
    existingId?: string,
  ): Promise<void> {
    const data = {
      status: 'FAILED' as const,
      sourceRowNumber,
      syncRunId,
      errorCode,
      errorMessage: errorMessage.slice(0, 500),
      // Les valeurs brutes permettent de rejouer sans relire la feuille.
      rawValues: [...values] as unknown as object,
    };

    if (existingId) {
      await this.prisma.sheetRowImport.update({
        where: { id: existingId },
        data: { ...data, retryCount: { increment: 1 } },
      });
      return;
    }

    try {
      await this.prisma.sheetRowImport.create({
        data: { tenantId, configId, fingerprint, ...data },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error, 'fingerprint')) throw error;
    }
  }

  private async finishRun(
    syncRunId: string,
    result: Omit<SyncResult, 'syncRunId'>,
    startedAt: number,
  ): Promise<void> {
    await this.prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: result.status,
        rowsScanned: result.rowsScanned,
        rowsImported: result.rowsImported,
        rowsSkipped: result.rowsSkipped,
        rowsFailed: result.rowsFailed,
        finishedAt: this.clock.now(),
        durationMs: this.clock.timestamp() - startedAt,
      },
    });
  }

  private async updateConfigAfterSuccess(
    configId: string,
    result: Omit<SyncResult, 'syncRunId'>,
  ): Promise<void> {
    await this.prisma.sheetSyncConfig.update({
      where: { id: configId },
      data: {
        lastSyncAt: this.clock.now(),
        lastSuccessAt: result.status === 'FAILED' ? undefined : this.clock.now(),
        consecutiveFailures: result.status === 'FAILED' ? { increment: 1 } : 0,
        backoffUntil: null,
      },
    });
  }

  private async loadConfig(tenantId: string, configId: string): Promise<SheetConfig> {
    const config = await this.prisma.sheetSyncConfig.findFirst({
      where: { tenantId, id: configId },
      select: {
        id: true,
        integrationId: true,
        spreadsheetId: true,
        sheetName: true,
        sheetGid: true,
        firstDataRow: true,
        columnMapping: true,
        externalIdColumn: true,
        acceptedSourceStatuses: true,
        lastProcessedRow: true,
        backoffUntil: true,
      },
    });

    if (!config) {
      throw new NotFoundException(
        ERROR_CODES.INTEGRATION_NOT_FOUND,
        'Configuration de synchronisation introuvable.',
      );
    }

    const mapping = config.columnMapping as ColumnMapping;
    if (!mapping || Object.keys(mapping).length === 0) {
      throw new BusinessException(
        ERROR_CODES.MAPPING_INVALID,
        'Le mapping des colonnes n est pas configure pour cette feuille.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return { ...config, columnMapping: mapping };
  }
}

interface SheetConfig {
  readonly id: string;
  readonly integrationId: string;
  readonly spreadsheetId: string;
  readonly sheetName: string;
  readonly sheetGid: string;
  readonly firstDataRow: number;
  readonly columnMapping: ColumnMapping;
  readonly externalIdColumn: string | null;
  readonly acceptedSourceStatuses: string[];
  readonly lastProcessedRow: number;
  readonly backoffUntil: Date | null;
}
