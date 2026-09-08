/**
 * Client de l'API Google Sheets.
 *
 * ANTICIPATION DES QUOTAS — Addendum §39, cahier de mission §38
 *
 *   L'API Google Sheets applique des quotas stricts par projet
 *   (lectures par minute). Avec plusieurs dizaines de boutiques synchronisant
 *   toutes les 10 minutes, le plafond est atteint rapidement. Trois mecanismes
 *   se combinent ici :
 *
 *   1. LIMITEUR DE DEBIT local (seau a jetons) : le processus ne depasse jamais
 *      le quota configure, ce qui evite de provoquer soi-meme le 429.
 *   2. REPRISE EXPONENTIELLE avec gigue sur 429 et 5xx. La gigue est
 *      essentielle : sans elle, toutes les boutiques bloquees reprendraient au
 *      meme instant et reprovoqueraient immediatement le quota.
 *   3. RESPECT DE `Retry-After` quand Google le fournit : c'est l'information
 *      la plus fiable disponible.
 *
 *   Lorsque les tentatives sont epuisees, l'erreur `GoogleQuotaExceededError`
 *   porte l'instant de reprise. L'appelant (`SheetSyncService`) l'enregistre
 *   sur la configuration : la synchronisation reprendra plus tard, exactement
 *   ou elle s'etait arretee. AUCUNE COMMANDE N'EST PERDUE.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/configuration';
import { asPrimitiveString } from '../../../common/utils/text';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';

/** Nombre de tentatives avant abandon (la premiere incluse). */
const MAX_ATTEMPTS = 4;

/** Delais de base entre tentatives, avant gigue. */
const BACKOFF_BASE_MS = [1_000, 4_000, 16_000];

const REQUEST_TIMEOUT_MS = 20_000;

export class GoogleQuotaExceededError extends Error {
  constructor(
    readonly retryAt: Date,
    readonly attempts: number,
  ) {
    super(
      `Quota Google Sheets depasse apres ${attempts} tentative(s). ` +
        `Reprise programmee a ${retryAt.toISOString()}.`,
    );
    this.name = 'GoogleQuotaExceededError';
  }
}

export class GoogleSheetsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleSheetsApiError';
  }
}

export interface SpreadsheetSummary {
  readonly spreadsheetId: string;
  readonly title: string;
  readonly sheets: readonly { sheetId: string; title: string; rowCount: number; columnCount: number }[];
}

export interface SheetRange {
  /** Valeurs brutes, ligne par ligne. Les cellules vides finales sont absentes. */
  readonly values: readonly (readonly string[])[];
  /** Plage effectivement retournee, telle que renvoyee par Google. */
  readonly range: string;
}

/**
 * Seau a jetons : autorise `capacity` requetes par minute, en lissant les
 * pics. Partage par tout le processus, tous tenants confondus — c'est bien le
 * quota du PROJET Google qui est en jeu, pas celui d'une boutique.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly capacity: number) {
    this.tokens = capacity;
  }

  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Attente du prochain jeton : mieux vaut ralentir que declencher un 429.
      const waitMs = Math.ceil(60_000 / this.capacity);
      await sleep(waitMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const refilled = (elapsed / 60_000) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefill = now;
  }
}

@Injectable()
export class GoogleSheetsClient {
  private readonly logger = new Logger(GoogleSheetsClient.name);
  private readonly bucket: TokenBucket;

  constructor(private readonly config: AppConfigService) {
    this.bucket = new TokenBucket(this.config.google.rateLimitPerMinute);
  }

  /** Metadonnees d'un classeur : titre et onglets disponibles. */
  async getSpreadsheet(accessToken: string, spreadsheetId: string): Promise<SpreadsheetSummary> {
    const data = await this.request<{
      spreadsheetId: string;
      properties: { title: string };
      sheets: {
        properties: {
          sheetId: number;
          title: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }[];
    }>(
      accessToken,
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}` +
        '?fields=spreadsheetId,properties.title,sheets.properties',
    );

    return {
      spreadsheetId: data.spreadsheetId,
      title: data.properties.title,
      sheets: data.sheets.map((sheet) => ({
        sheetId: String(sheet.properties.sheetId),
        title: sheet.properties.title,
        rowCount: sheet.properties.gridProperties?.rowCount ?? 0,
        columnCount: sheet.properties.gridProperties?.columnCount ?? 0,
      })),
    };
  }

  /**
   * Lit une plage de cellules.
   *
   * `valueRenderOption=UNFORMATTED_VALUE` renvoie les valeurs brutes plutot que
   * la chaine affichee : un prix formate « 4 500,00 DA » redevient `4500`, et
   * une date reste exploitable. `dateTimeRenderOption=FORMATTED_STRING` garde
   * en revanche les dates lisibles, plus faciles a interpreter qu'un numero de
   * serie Excel.
   */
  async getValues(
    accessToken: string,
    spreadsheetId: string,
    range: string,
  ): Promise<SheetRange> {
    const url =
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` +
      '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';

    const data = await this.request<{ range: string; values?: unknown[][] }>(accessToken, url);

    return {
      range: data.range,
      values: (data.values ?? []).map((row) =>
        // Une cellule peut techniquement contenir une valeur JSON non
        // primitive ; on la traite comme vide plutot que d'importer
        // « [object Object] » dans une commande.
        row.map((cell) => asPrimitiveString(cell) ?? ''),
      ),
    };
  }

  /** Ecrit une valeur unique (renvoi du statut dans la feuille). */
  async updateCell(
    accessToken: string,
    spreadsheetId: string,
    range: string,
    value: string,
  ): Promise<void> {
    const url =
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` +
      '?valueInputOption=RAW';

    await this.request(accessToken, url, {
      method: 'PUT',
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [[value]] }),
    });
  }

  /** Classeurs accessibles, pour l'assistant de configuration. */
  async listSpreadsheets(
    accessToken: string,
    limit = 50,
  ): Promise<readonly { id: string; name: string; modifiedAt: string }[]> {
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: 'files(id,name,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: String(limit),
    });

    const data = await this.request<{
      files: { id: string; name: string; modifiedTime: string }[];
    }>(accessToken, `${DRIVE_API_BASE}?${params.toString()}`);

    return data.files.map((file) => ({
      id: file.id,
      name: file.name,
      modifiedAt: file.modifiedTime,
    }));
  }

  // -------------------------------------------------------------------------

  /**
   * Execute une requete avec limitation de debit, reprise exponentielle et
   * traduction des erreurs Google en erreurs metier EcomFlow.
   */
  private async request<T>(
    accessToken: string,
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    let lastRetryAfterMs = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.bucket.take();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          ...init,
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            ...(init.headers ?? {}),
          },
          signal: controller.signal,
        });

        if (response.ok) {
          return (await response.json()) as T;
        }

        // --- Quota depasse -------------------------------------------------
        if (response.status === 429) {
          lastRetryAfterMs = this.readRetryAfter(response) ?? this.backoffDelay(attempt);

          if (attempt === MAX_ATTEMPTS) {
            const retryAt = new Date(Date.now() + lastRetryAfterMs);
            this.logger.warn(
              `Quota Google Sheets depasse (429) apres ${attempt} tentatives. ` +
                `Reprise a ${retryAt.toISOString()}.`,
            );
            throw new GoogleQuotaExceededError(retryAt, attempt);
          }

          this.logger.warn(
            `Quota Google Sheets (429), tentative ${attempt}/${MAX_ATTEMPTS}. ` +
              `Nouvel essai dans ${Math.round(lastRetryAfterMs / 1000)} s.`,
          );
          await sleep(lastRetryAfterMs);
          continue;
        }

        // --- Panne passagere ------------------------------------------------
        if (response.status >= 500) {
          if (attempt === MAX_ATTEMPTS) {
            throw new GoogleSheetsApiError(
              response.status,
              'GOOGLE_API_UNAVAILABLE',
              'L API Google Sheets est momentanement indisponible.',
            );
          }
          await sleep(this.backoffDelay(attempt));
          continue;
        }

        // --- Erreurs definitives : reessayer ne changerait rien ------------
        throw await this.toApiError(response);
      } catch (error) {
        if (
          error instanceof GoogleQuotaExceededError ||
          error instanceof GoogleSheetsApiError
        ) {
          throw error;
        }

        const aborted = (error as Error).name === 'AbortError';
        if (attempt === MAX_ATTEMPTS) {
          throw new GoogleSheetsApiError(
            0,
            'GOOGLE_API_UNAVAILABLE',
            aborted
              ? 'Delai depasse lors de l appel a Google Sheets.'
              : `Appel Google Sheets impossible : ${(error as Error).message}`,
          );
        }
        await sleep(this.backoffDelay(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    /* istanbul ignore next -- la boucle sort toujours par retour ou exception */
    throw new GoogleSheetsApiError(0, 'GOOGLE_API_UNAVAILABLE', 'Appel Google Sheets echoue.');
  }

  private async toApiError(response: Response): Promise<GoogleSheetsApiError> {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string };
    };
    const message = body.error?.message ?? `HTTP ${response.status}`;

    if (response.status === 404) {
      return new GoogleSheetsApiError(
        404,
        'GOOGLE_SHEET_NOT_FOUND',
        'Feuille introuvable. Elle a peut-etre ete supprimee, renommee ou son partage revoque.',
      );
    }

    if (response.status === 403) {
      return new GoogleSheetsApiError(
        403,
        'GOOGLE_AUTH_REVOKED',
        "Acces refuse par Google. Verifiez que le compte connecte a bien acces a ce classeur.",
      );
    }

    if (response.status === 400) {
      return new GoogleSheetsApiError(
        400,
        'GOOGLE_SHEET_TAB_NOT_FOUND',
        `Plage ou onglet invalide : ${message}`,
      );
    }

    if (response.status === 401) {
      return new GoogleSheetsApiError(
        401,
        'GOOGLE_AUTH_EXPIRED',
        'Session Google expiree. Reconnectez le compte.',
      );
    }

    return new GoogleSheetsApiError(response.status, 'GOOGLE_API_UNAVAILABLE', message);
  }

  /** Lit l'en-tete `Retry-After`, en secondes ou en date HTTP. */
  private readRetryAfter(response: Response): number | null {
    const header = response.headers.get('retry-after');
    if (!header) return null;

    const seconds = Number.parseInt(header, 10);
    if (!Number.isNaN(seconds)) return Math.max(1_000, seconds * 1_000);

    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(1_000, date - Date.now());

    return null;
  }

  /**
   * Delai de reprise avec gigue aleatoire (« full jitter »).
   *
   * Sans gigue, toutes les boutiques bloquees par un quota reprendraient
   * exactement au meme instant et le reprovoqueraient immediatement.
   */
  private backoffDelay(attempt: number): number {
    const base = BACKOFF_BASE_MS[attempt - 1] ?? BACKOFF_BASE_MS[BACKOFF_BASE_MS.length - 1] ?? 16_000;
    return Math.floor(base / 2 + Math.random() * (base / 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
