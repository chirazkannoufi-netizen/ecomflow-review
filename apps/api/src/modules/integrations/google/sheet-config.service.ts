/**
 * Configuration d'une feuille synchronisee — V2 §12, §29 (etapes 2 a 5).
 *
 * Ce service porte le parcours que suit le commercant dans l'assistant
 * d'onboarding (Addendum §34) :
 *   lister ses classeurs -> choisir un onglet -> proposer un mapping ->
 *   le corriger -> tester l'import -> activer.
 *
 * OBJECTIF : « configuration sans developpeur » (cahier de mission §31).
 * Le mapping est donc DEDUIT automatiquement des en-tetes, et l'aperçu montre
 * au commercant, ligne par ligne, ce qu'EcomFlow a compris de sa feuille avant
 * qu'il ne valide quoi que ce soit.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ERROR_CODES } from '@ecomflow/shared';
import { InjectPrisma, type PrismaClientExtended } from '../../../infra/prisma/prisma.service';
import {
  ConflictException,
  NotFoundException,
  ValidationException,
} from '../../../common/errors/business.exception';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleSheetsClient } from './google-sheets.client';
import {
  MAPPABLE_FIELDS,
  REQUIRED_FIELDS,
  columnToIndex,
  indexToColumn,
  inferMappingFromHeaders,
  parseRow,
  type ColumnMapping,
} from './sheet-row.parser';

/** Nombre de lignes lues pour l'aperçu de configuration. */
const PREVIEW_ROWS = 10;

export interface SheetPreview {
  readonly headers: readonly string[];
  /** Mapping propose automatiquement, corrigeable par le commercant. */
  readonly suggestedMapping: ColumnMapping;
  /** Champs obligatoires qu'aucune colonne ne remplit. */
  readonly missingRequiredFields: readonly string[];
  /** Lignes d'exemple, telles qu'EcomFlow les interprete. */
  readonly sampleRows: readonly {
    rowNumber: number;
    raw: readonly string[];
    parsed: Record<string, unknown> | null;
    error: { code: string; message: string } | null;
  }[];
}

export interface CreateConfigInput {
  readonly tenantId: string;
  readonly spreadsheetId: string;
  readonly sheetName: string;
  readonly sheetGid: string;
  readonly columnMapping: ColumnMapping;
  readonly headerRow?: number;
  readonly firstDataRow?: number;
  readonly externalIdColumn?: string | null;
  readonly syncIntervalMinutes?: number;
  readonly acceptedSourceStatuses?: readonly string[];
}

@Injectable()
export class SheetConfigService {
  private readonly logger = new Logger(SheetConfigService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly oauth: GoogleOAuthService,
    private readonly sheets: GoogleSheetsClient,
  ) {}

  /** Classeurs accessibles au compte connecte. */
  async listSpreadsheets(tenantId: string) {
    const token = await this.oauth.getAccessToken(tenantId);
    return this.sheets.listSpreadsheets(token);
  }

  /** Onglets d'un classeur. */
  async listSheets(tenantId: string, spreadsheetId: string) {
    const token = await this.oauth.getAccessToken(tenantId);
    const summary = await this.sheets.getSpreadsheet(token, spreadsheetId);
    return { title: summary.title, sheets: summary.sheets };
  }

  /**
   * Aperçu d'un onglet : en-tetes, mapping propose et interpretation des
   * premieres lignes.
   *
   * C'est l'ecran qui evite les mauvaises surprises : le commercant voit que
   * « 0555 12 34 56 » devient « +213555123456 » et que « Alger » est bien
   * reconnu comme la wilaya 16, AVANT de lancer un import reel.
   */
  async previewSheet(
    tenantId: string,
    spreadsheetId: string,
    sheetName: string,
    options: { headerRow?: number; mapping?: ColumnMapping } = {},
  ): Promise<SheetPreview> {
    const token = await this.oauth.getAccessToken(tenantId);
    const headerRow = options.headerRow ?? 1;
    const lastRow = headerRow + PREVIEW_ROWS;

    const range = `'${sheetName}'!A${headerRow}:Z${lastRow}`;
    const data = await this.sheets.getValues(token, spreadsheetId, range);

    const headers = data.values[0] ?? [];
    const mapping = options.mapping ?? inferMappingFromHeaders(headers);

    const missingRequiredFields = REQUIRED_FIELDS.filter(
      (field) => mapping[field] === undefined,
    ).map(String);

    const sampleRows = data.values.slice(1).map((row, index) => {
      const rowNumber = headerRow + 1 + index;
      const result = parseRow(row, mapping, { defaultQuantity: 1 });

      return {
        rowNumber,
        raw: row,
        parsed: result.ok
          ? {
              client: result.value.customerName,
              telephone: result.value.phoneE164,
              wilaya: `${result.value.wilayaCode} — ${result.value.wilayaName}`,
              commune: result.value.commune,
              adresse: result.value.addressText,
              sku: result.value.sku,
              produit: result.value.productName,
              quantite: result.value.quantity,
              prixUnitaireCentimes: result.value.unitPriceCentimes,
              livraisonCentimes: result.value.deliveryFeeCentimes,
              statutSource: result.value.sourceStatus,
            }
          : null,
        error: result.ok ? null : { code: result.code, message: result.message },
      };
    });

    return { headers, suggestedMapping: mapping, missingRequiredFields, sampleRows };
  }

  /**
   * Enregistre une configuration de synchronisation.
   *
   * Le mapping est valide AVANT enregistrement : accepter une configuration
   * incomplete produirait des echecs en boucle a chaque execution du job, ce
   * qui est le pire des deux mondes (bruit et absence de commandes).
   */
  async createConfig(input: CreateConfigInput): Promise<{ configId: string }> {
    this.validateMapping(input.columnMapping);

    const integration = await this.prisma.integration.findFirst({
      where: { tenantId: input.tenantId, provider: 'GOOGLE_SHEETS', status: 'CONNECTED' },
      select: { id: true },
    });

    if (!integration) {
      throw new NotFoundException(
        ERROR_CODES.INTEGRATION_NOT_CONNECTED,
        'Connectez d abord un compte Google.',
      );
    }

    const existing = await this.prisma.sheetSyncConfig.findFirst({
      where: {
        tenantId: input.tenantId,
        spreadsheetId: input.spreadsheetId,
        sheetGid: input.sheetGid,
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        ERROR_CODES.CONFLICT,
        'Cet onglet est deja synchronise pour cette boutique.',
      );
    }

    const headerRow = input.headerRow ?? 1;
    const firstDataRow = input.firstDataRow ?? headerRow + 1;

    if (firstDataRow <= headerRow) {
      throw new ValidationException(
        'La premiere ligne de donnees doit se situer apres la ligne d en-tete.',
      );
    }

    const config = await this.prisma.sheetSyncConfig.create({
      data: {
        tenantId: input.tenantId,
        integrationId: integration.id,
        spreadsheetId: input.spreadsheetId,
        sheetName: input.sheetName,
        sheetGid: input.sheetGid,
        headerRow,
        firstDataRow,
        columnMapping: input.columnMapping as object,
        externalIdColumn: input.externalIdColumn ?? null,
        syncIntervalMinutes: input.syncIntervalMinutes ?? 10,
        acceptedSourceStatuses: [...(input.acceptedSourceStatuses ?? [])],
        // Decalage stable derive de l'identifiant du classeur : deux boutiques
        // reglees sur le meme intervalle ne synchronisent pas au meme instant,
        // ce qui lisse la consommation du quota Google (Addendum §39).
        scheduleOffsetSeconds: this.deriveScheduleOffset(input.spreadsheetId, input.sheetGid),
        isActive: true,
      },
      select: { id: true },
    });

    await this.prisma.onboardingProgress.updateMany({
      where: { tenantId: input.tenantId },
      data: { currentStep: 'TEST_IMPORT_PASSED' },
    });

    this.logger.log(
      `Feuille configuree pour la boutique ${input.tenantId} : ` +
        `${input.spreadsheetId}/${input.sheetName}.`,
    );

    return { configId: config.id };
  }

  /** Modifie une configuration existante. */
  async updateConfig(
    tenantId: string,
    configId: string,
    changes: {
      columnMapping?: ColumnMapping;
      syncIntervalMinutes?: number;
      isActive?: boolean;
      externalIdColumn?: string | null;
      acceptedSourceStatuses?: readonly string[];
    },
  ): Promise<void> {
    if (changes.columnMapping) this.validateMapping(changes.columnMapping);

    if (
      changes.syncIntervalMinutes !== undefined &&
      (changes.syncIntervalMinutes < 5 || changes.syncIntervalMinutes > 1_440)
    ) {
      // En deca de 5 minutes, le quota Google est consomme sans benefice reel :
      // une commande saisie a la main met de toute facon plus longtemps a
      // arriver.
      throw new ValidationException(
        'L intervalle de synchronisation doit etre compris entre 5 minutes et 24 heures.',
      );
    }

    const updated = await this.prisma.sheetSyncConfig.updateMany({
      where: { tenantId, id: configId },
      data: {
        ...(changes.columnMapping ? { columnMapping: changes.columnMapping as object } : {}),
        ...(changes.syncIntervalMinutes !== undefined
          ? { syncIntervalMinutes: changes.syncIntervalMinutes }
          : {}),
        ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
        ...(changes.externalIdColumn !== undefined
          ? { externalIdColumn: changes.externalIdColumn }
          : {}),
        ...(changes.acceptedSourceStatuses
          ? { acceptedSourceStatuses: [...changes.acceptedSourceStatuses] }
          : {}),
      },
    });

    if (updated.count === 0) {
      throw new NotFoundException(
        ERROR_CODES.INTEGRATION_NOT_FOUND,
        'Configuration introuvable.',
      );
    }
  }

  /** Configurations de la boutique, avec leur etat de synchronisation. */
  async listConfigs(tenantId: string) {
    return this.prisma.sheetSyncConfig.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        spreadsheetId: true,
        spreadsheetName: true,
        sheetName: true,
        columnMapping: true,
        isActive: true,
        syncIntervalMinutes: true,
        lastSyncAt: true,
        lastSuccessAt: true,
        lastProcessedRow: true,
        consecutiveFailures: true,
        backoffUntil: true,
        _count: { select: { rowImports: { where: { status: 'FAILED' } } } },
      },
    });
  }

  /** Journal d'import : lignes en erreur, avec leur motif (V1 §6). */
  async listRowErrors(tenantId: string, configId: string, limit = 100) {
    return this.prisma.sheetRowImport.findMany({
      where: { tenantId, configId, status: 'FAILED' },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        sourceRowNumber: true,
        errorCode: true,
        errorMessage: true,
        retryCount: true,
        rawValues: true,
        updatedAt: true,
      },
    });
  }

  /** Historique des executions de synchronisation (V2 §30). */
  async listSyncRuns(tenantId: string, configId: string | null, limit = 30) {
    return this.prisma.syncRun.findMany({
      where: { tenantId, ...(configId ? { configId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        trigger: true,
        status: true,
        rowsScanned: true,
        rowsImported: true,
        rowsSkipped: true,
        rowsFailed: true,
        errorCode: true,
        errorMessage: true,
        retryAfter: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
      },
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Valide un mapping avant enregistrement.
   *
   * Deux verifications : tous les champs obligatoires sont pourvus, et aucune
   * colonne n'est affectee a deux champs differents — une collision produirait
   * des donnees silencieusement fausses (le telephone lu dans la colonne du
   * prix, par exemple).
   */
  private validateMapping(mapping: ColumnMapping): void {
    const missing = REQUIRED_FIELDS.filter((field) => mapping[field] === undefined);
    if (missing.length > 0) {
      throw new ValidationException(
        `Mapping incomplet : les champs suivants doivent etre associes a une colonne — ${missing.join(', ')}.`,
        { details: { missingFields: missing } },
      );
    }

    const usedColumns = new Map<number, string>();
    for (const field of MAPPABLE_FIELDS) {
      const column = mapping[field];
      if (column === undefined) continue;

      const index = columnToIndex(column);
      if (index < 0) {
        throw new ValidationException(
          `Colonne invalide pour le champ « ${field} » : « ${String(column)} ».`,
        );
      }

      const conflict = usedColumns.get(index);
      if (conflict) {
        throw new ValidationException(
          `La colonne ${indexToColumn(index)} est affectee a la fois a « ${conflict} » ` +
            `et a « ${field} ». Chaque colonne ne peut alimenter qu un seul champ.`,
        );
      }
      usedColumns.set(index, field);
    }
  }

  /**
   * Decalage de planification stable dans [0, 300) secondes.
   * Derive d'un hash : il ne change jamais pour une meme feuille, ce qui rend
   * la planification previsible et reproductible.
   */
  private deriveScheduleOffset(spreadsheetId: string, sheetGid: string): number {
    const digest = createHash('sha256').update(`${spreadsheetId}:${sheetGid}`).digest();
    return digest.readUInt16BE(0) % 300;
  }
}
