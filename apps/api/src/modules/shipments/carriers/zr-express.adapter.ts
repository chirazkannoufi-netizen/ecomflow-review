/**
 * Connecteur ZR Express — generation v2, plateforme Procolis.
 *
 * DEUX GENERATIONS, ET UNE SEULE EST BRANCHEE ICI
 *   ZR Express fait tourner deux API en parallele. La v2 (Procolis) adresse par
 *   NOM de wilaya et de commune, exactement comme notre referentiel. La v3
 *   (zrexpress.app) adresse par UUID de territoire : il lui faudrait une table
 *   de correspondance entre nos 58 wilayas, nos communes et ses identifiants,
 *   plus un moyen de la tenir a jour. Ce n'est pas une variante mineure de cet
 *   adaptateur, c'est un chantier d'adressage a part — le catalogue la porte
 *   donc en PLANNED, avec sa raison (D-070).
 *
 * CE QUE CETTE API NE FAIT PAS, ET QUE LA MATRICE DOIT DIRE
 *   Ni suppression, ni bordereau, ni historique d'evenements. Les deux
 *   integrations open-source consultees le declarent explicitement non
 *   supporte, et `lire` ne rend qu'une `Situation` — l'etat courant, sans les
 *   etapes qui y ont mene. Le suivi produit donc UN evenement, celui de
 *   maintenant : c'est moins qu'ailleurs, mais c'est vrai.
 *
 * L'IDEMPOTENCE PASSE PAR NOTRE PROPRE NUMERO DE SUIVI
 *   `Tracking` est un champ d'ENTREE facultatif : laisse vide, ZR en attribue
 *   un ; rempli, il refuse le doublon avec « Double Tracking ». Nous y plaçons
 *   la reference EcomFlow, et ce refus devient le mecanisme d'idempotence exige
 *   par le contrat — le meme que `order_id` chez Yalidine. Un rejeu apres un
 *   delai depasse ne peut donc pas creer deux colis.
 *
 *   Consequence assumee : le numero de suivi cote ZR EST notre reference. C'est
 *   aussi ce qu'un agent cite au telephone, donc un gain ; mais c'est le point
 *   qu'un premier compte reel doit confirmer, si ZR imposait son propre format.
 *
 * SOURCES
 *   Aucune documentation officielle publique : ZR Express l'envoie a
 *   l'ouverture du compte. Ces points d'entree viennent de deux integrations
 *   open-source independantes (CourierDZ et Vargo) qui concordent. Le
 *   transporteur reste donc UNVERIFIED tant qu'un compte marchand n'a pas
 *   repondu.
 */

import { Logger } from '@nestjs/common';
import type { ShipmentStatus } from '@ecomflow/shared';
import {
  carrierFailure,
  type CarrierAdapter,
  type CarrierContext,
  type CarrierHealth,
  type CarrierResult,
  type ShipmentCreated,
  type ShipmentRequest,
  type TrackingEvent,
} from './carrier-adapter.interface';
import {
  baseUrlField,
  resolveBaseUrl,
  type CarrierFamilyIdentity,
} from './carrier-family';
import { text } from '../../../common/utils/text';

const REQUEST_TIMEOUT_MS = 20_000;

export const ZR_EXPRESS_IDENTITY: CarrierFamilyIdentity = {
  code: 'ZR_EXPRESS',
  displayName: 'ZR Express',
  defaultBaseUrl: 'https://procolis.com/api_v1',
};

/**
 * Statuts Procolis -> statuts EcomFlow.
 *
 * Les libelles sont ceux de leur interface, en francais, ponctuation comprise
 * (« En Livraison ( 1528 ) », « En Traitement - Pret a Expedie »). Ils sont
 * compares apres normalisation — minuscules, sans accents, espaces reduits —
 * parce qu'une capitale ou un accent de plus n'est pas un statut different.
 *
 * TROIS DISTINCTIONS QUE NOUS TENONS ET QUE LES SDK CONSULTES PERDENT
 *   - « Appel sans Reponse » est une TENTATIVE ECHOUEE, pas un transit : c'est
 *     l'evenement qui declenche le rappel du client.
 *   - « Annuler par le Client » est une annulation, les « Retour ... » sont le
 *     trajet de retour. Confondre les deux ferait disparaitre du stock un colis
 *     qui revient.
 *   - « Retour Stock » est l'arrivee du retour ; les autres « Retour » sont le
 *     chemin.
 */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  'en preparation': 'CREATED',
  'en traitement - pret a expedie': 'CREATED',

  dispatcher: 'IN_TRANSIT',
  echange: 'IN_TRANSIT',

  'en livraison': 'OUT_FOR_DELIVERY',
  'en livraison ( 1528 )': 'OUT_FOR_DELIVERY',
  'au bureau': 'OUT_FOR_DELIVERY',
  'sd - en attente du client': 'OUT_FOR_DELIVERY',

  'a relance': 'FAILED_ATTEMPT',
  reporte: 'FAILED_ATTEMPT',
  'sd - reporte': 'FAILED_ATTEMPT',
  'appel sans reponse 1': 'FAILED_ATTEMPT',
  'appel sans reponse 2': 'FAILED_ATTEMPT',
  'appel sans reponse 3': 'FAILED_ATTEMPT',
  'sd - appel sans reponse 1': 'FAILED_ATTEMPT',
  'sd - appel sans reponse 2': 'FAILED_ATTEMPT',
  'sd - appel sans reponse 3': 'FAILED_ATTEMPT',

  livree: 'DELIVERED',
  'colis livree': 'DELIVERED',
  'livree [ encaisser ]': 'DELIVERED',

  'retour de dispatche': 'RETURNING',
  'retour livreur': 'RETURNING',
  'retour navette': 'RETURNING',
  'retour stock': 'RETURNED',

  'annuler par le client': 'CANCELLED',
  'sd - annuler par le client': 'CANCELLED',
  'sd - annuler 3x': 'CANCELLED',
};

export class ZrExpressAdapter implements CarrierAdapter {
  readonly code = ZR_EXPRESS_IDENTITY.code;
  readonly displayName = ZR_EXPRESS_IDENTITY.displayName;
  // La v2 ne pousse rien. La v3 expose des webhooks — une raison de plus pour
  // qu'elle soit une entree distincte plutot qu'une option de celle-ci.
  readonly supportsWebhooks = false;
  // Ni `supprimer` ni `annuler` chez Procolis : l'annulation se fait depuis le
  // tableau de bord ZR Express. Le declarer eviterait un bouton qui echoue.
  readonly supportsCancellation = false;

  readonly credentialFields = [
    {
      key: 'token',
      label: 'Token',
      secret: true,
      required: true,
      helpText: 'Portail ZR Express, Parametres puis Informations personnelles.',
    },
    {
      key: 'key',
      label: 'Cle API',
      secret: true,
      required: true,
      helpText: 'Delivree avec le token, au meme endroit.',
    },
    baseUrlField(ZR_EXPRESS_IDENTITY, 'https://procolis.com/api_v1'),
  ] as const;

  private readonly logger = new Logger(ZrExpressAdapter.name);

  async createShipment(
    context: CarrierContext,
    request: ShipmentRequest,
  ): Promise<CarrierResult<ShipmentCreated>> {
    const colis = {
      // Notre reference sert de numero de suivi : c'est ce qui rend le rejeu
      // inoffensif (voir l'en-tete de ce fichier).
      Tracking: request.orderReference,
      TypeLivraison: request.deliveryType === 'PICKUP_POINT' ? '1' : '0',
      TypeColis: request.allowExchange ? '1' : '0',
      // « Confrimee » — la faute de frappe est celle de l'API, pas la notre.
      // 1 = le colis part directement en « pret a expedier », ce qui est
      // exactement l'etat dans lequel EcomFlow le confie.
      Confrimee: '1',
      Client: request.customerName,
      MobileA: toLocalPhone(request.phoneE164),
      MobileB: request.secondaryPhone ? toLocalPhone(request.secondaryPhone) : '',
      Adresse: request.addressText,
      IDWilaya: String(request.wilayaCode),
      Commune: request.commune,
      // Procolis compte en dinars, pas en centimes.
      Total: String(Math.round(request.codAmountCentimes / 100)),
      Note: (request.notes ?? '').slice(0, 255),
      TProduit: request.items
        .map((item) => `${item.name} x${item.quantity}`)
        .join(', ')
        .slice(0, 255),
      id_Externe: request.orderReference,
      Source: 'EcomFlow',
    };

    const response = await this.request(context, 'POST', '/add_colis', { Colis: [colis] });
    if (!response.ok) return response.failure;

    const entry = firstColis(response.data);
    if (!entry) {
      return carrierFailure(
        'PROVIDER_ERROR',
        `Reponse ${this.displayName} inexploitable : aucun colis retourne.`,
        { retryable: true },
      );
    }

    const message = text(entry.MessageRetour);

    if (message === 'Double Tracking') {
      return carrierFailure(
        'ALREADY_EXISTS',
        `Ce colis existe deja chez ${this.displayName} sous la reference ${request.orderReference}.`,
        { retryable: false, providerDetail: message },
      );
    }

    if (message !== 'Good') {
      return carrierFailure('INVALID_ADDRESS', message || 'Creation refusee par ZR Express.', {
        retryable: false,
        providerDetail: JSON.stringify(entry).slice(0, 300),
      });
    }

    const trackingNumber = text(entry.Tracking) || request.orderReference;

    return {
      ok: true,
      trackingNumber,
      providerShipmentId: trackingNumber,
      // Procolis ne rend pas de bordereau par l'API : il s'imprime depuis le
      // tableau de bord ZR Express.
      labelUrl: null,
      costCentimes: null,
      providerStatus: text(entry.Situation) || null,
    };
  }

  async cancelShipment(): Promise<CarrierResult<{ cancelled: boolean }>> {
    // Refus EXPLICITE plutot que silence : l'agent doit lire pourquoi le geste
    // n'aboutit pas, et ou il aboutit — le tableau de bord ZR Express.
    return carrierFailure(
      'NOT_IMPLEMENTED',
      "L'API ZR Express (v2) n'annule pas un colis. L'annulation se fait depuis " +
        'le tableau de bord ZR Express.',
      { retryable: false },
    );
  }

  async getShipmentStatus(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ status: ShipmentStatus; providerStatus: string }>> {
    const entry = await this.read(context, trackingNumber);
    if (!entry.ok) return entry.failure;

    const providerStatus = text(entry.colis.Situation);
    if (providerStatus.length === 0) {
      return carrierFailure('NOT_FOUND', `Colis introuvable chez ${this.displayName}.`, {
        retryable: false,
      });
    }

    return { ok: true, status: this.normalizeStatus(providerStatus), providerStatus };
  }

  async getTrackingEvents(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ events: readonly TrackingEvent[] }>> {
    const entry = await this.read(context, trackingNumber);
    if (!entry.ok) return entry.failure;

    const providerStatus = text(entry.colis.Situation);
    if (providerStatus.length === 0) return { ok: true, events: [] };

    // UN evenement, et c'est tout ce que l'API donne : `lire` rend l'etat
    // COURANT, sans les etapes qui y ont mene. L'empreinte porte donc le statut
    // et non l'horodatage — resonder le meme etat ne doit pas empiler un
    // evenement par sondage.
    const occurredAt = parseDate(entry.colis.DateH_Action) ?? new Date();

    return {
      ok: true,
      events: [
        {
          providerStatus,
          normalizedStatus: this.normalizeStatus(providerStatus),
          description: text(entry.colis.Commentaire) || null,
          location: text(entry.colis.Commune) || null,
          occurredAt,
          fingerprint: `${trackingNumber}|${providerStatus}`,
          rawPayload: entry.colis,
        },
      ],
    };
  }

  normalizeStatus(providerStatus: string): ShipmentStatus {
    const normalized = normalizeLabel(providerStatus);

    const direct = STATUS_MAP[normalized];
    if (direct) return direct;

    // Recherche par inclusion : ZR suffixe parfois ses libelles d'un numero
    // d'agence, comme « En Livraison ( 1528 ) ».
    for (const [key, status] of Object.entries(STATUS_MAP)) {
      if (normalized.startsWith(key)) return status;
    }

    this.logger.warn(
      `Statut ${this.displayName} inconnu : « ${providerStatus} ». Normalise en ` +
        'IN_TRANSIT et conserve tel quel pour diagnostic.',
    );
    return 'IN_TRANSIT';
  }

  async healthCheck(context: CarrierContext): Promise<CarrierHealth> {
    const started = Date.now();
    const response = await this.request(context, 'GET', '/token');
    const latencyMs = Date.now() - started;

    if (!response.ok) return { ok: false, latencyMs, message: response.failure.message };

    // Procolis repond 200 meme quand l'acces n'est pas actif : c'est le champ
    // `Statut` qui tranche. S'arreter au code HTTP declarerait connecte un
    // compte qui ne peut rien deposer.
    const statut = text((response.data as Record<string, unknown> | undefined)?.Statut);
    const active = normalizeLabel(statut).includes('acces active');

    return active
      ? { ok: true, latencyMs }
      : {
          ok: false,
          latencyMs,
          message:
            statut.length > 0
              ? `ZR Express repond « ${statut} » : l acces API n est pas actif.`
              : 'ZR Express n a pas confirme l activation de l acces API.',
        };
  }

  // -------------------------------------------------------------------------

  private async read(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<
    | { ok: true; colis: Record<string, unknown> }
    | { ok: false; failure: ReturnType<typeof carrierFailure> }
  > {
    const response = await this.request(context, 'POST', '/lire', {
      Colis: [{ Tracking: trackingNumber }],
    });
    if (!response.ok) return response;

    const entry = firstColis(response.data);
    if (!entry) {
      return {
        ok: false,
        // `lire` rend litteralement `null` pour un colis inconnu.
        failure: carrierFailure('NOT_FOUND', `Colis introuvable chez ${this.displayName}.`, {
          retryable: false,
        }),
      };
    }

    return { ok: true, colis: entry };
  }

  private async request(
    context: CarrierContext,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<
    { ok: true; data: unknown } | { ok: false; failure: ReturnType<typeof carrierFailure> }
  > {
    const token = text(context.credentials.token);
    const key = text(context.credentials.key);

    if (token.length === 0 || key.length === 0) {
      return {
        ok: false,
        failure: carrierFailure(
          'AUTHENTICATION_FAILED',
          'Identifiants ZR Express manquants. Completez la configuration du transporteur.',
          { retryable: false },
        ),
      };
    }

    const resolved = resolveBaseUrl(context, ZR_EXPRESS_IDENTITY);
    if (!resolved.ok) return { ok: false, failure: resolved.failure };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${resolved.baseUrl}${path}`, {
        method,
        // Procolis lit ses identifiants dans deux en-tetes a lui, sans schema
        // d'autorisation standard.
        headers: {
          token,
          key,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.ok) {
        const raw = await response.text().catch(() => '');
        // Un colis inconnu produit la chaine « null » : ce n'est pas du JSON
        // exploitable, et le traiter comme un objet vide masquerait le NOT_FOUND.
        if (raw.trim().length === 0 || raw.trim() === 'null') return { ok: true, data: null };
        try {
          return { ok: true, data: JSON.parse(raw) };
        } catch {
          return {
            ok: false,
            failure: carrierFailure('PROVIDER_ERROR', 'Reponse ZR Express illisible.', {
              retryable: true,
              providerDetail: raw.slice(0, 300),
            }),
          };
        }
      }

      const detail = (await response.text().catch(() => '')).slice(0, 300);

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          failure: carrierFailure(
            'AUTHENTICATION_FAILED',
            'Identifiants ZR Express refuses. Verifiez le token et la cle API.',
            { retryable: false, providerDetail: detail },
          ),
        };
      }

      if (response.status === 429) {
        return {
          ok: false,
          failure: carrierFailure('RATE_LIMITED', 'Quota ZR Express atteint.', {
            retryable: true,
            providerDetail: detail,
          }),
        };
      }

      return {
        ok: false,
        failure: carrierFailure('PROVIDER_ERROR', `ZR Express a repondu ${response.status}.`, {
          retryable: response.status >= 500,
          providerDetail: detail,
        }),
      };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      return {
        ok: false,
        failure: carrierFailure(
          aborted ? 'TIMEOUT' : 'PROVIDER_ERROR',
          aborted
            ? 'Delai depasse lors de l appel a ZR Express.'
            : `Appel ZR Express impossible : ${(error as Error).message}`,
          { retryable: true },
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Procolis enveloppe tout dans `{ "Colis": [ ... ] }`, mais les integrations
 * consultees acceptent aussi un tableau nu. On lit les deux formes.
 */
function firstColis(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;

  const container = data as Record<string, unknown>;
  const list = Array.isArray(container.Colis)
    ? container.Colis
    : Array.isArray(data)
      ? (data as unknown[])
      : null;

  const entry = list?.[0];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
}

/** Minuscules, sans accents, espaces reduits : la forme de comparaison. */
function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

function parseDate(value: unknown): Date | null {
  const raw = text(value).trim();
  if (raw.length === 0) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Procolis attend le format national algerien (0XXXXXXXXX). */
function toLocalPhone(e164: string): string {
  return e164.startsWith('+213') ? `0${e164.slice(4)}` : e164;
}
