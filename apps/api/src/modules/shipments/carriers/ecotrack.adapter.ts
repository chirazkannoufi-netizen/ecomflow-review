/**
 * Connecteur de la famille Ecotrack — Ecotrack, DHD, UPS (Conexlog), SpeedMail.
 *
 * CE QU'ECOTRACK EST
 *   Pas une societe de livraison : une PLATEFORME logistique en marque blanche,
 *   utilisee par plus de quatre-vingts societes algeriennes independantes.
 *   Chacune a sa flotte, ses tarifs et son compte partenaire, mais toutes
 *   exposent la meme API sur leur propre domaine. Un seul adaptateur, instancie
 *   une fois par societe (D-070).
 *
 *   « UPS » designe ici CONEXLOG EURL, licencie algerien de la marque. Ce n'est
 *   PAS l'API mondiale de United Parcel Service : Conexlog livre sur Ecotrack,
 *   exactement comme DHD. Le catalogue le nomme « UPS (Conexlog) » pour que
 *   personne ne s'y trompe — ni un commercant, ni un developpeur.
 *
 * D'OU VIENNENT CES POINTS D'ENTREE, ET CE QUE CELA IMPLIQUE
 *   D'aucune documentation officielle : il n'en existe pas de publique. Ils
 *   viennent de deux integrations open-source fonctionnelles et independantes
 *   (CourierDZ et Vargo), qui concordent sur les chemins, l'authentification et
 *   les noms de champs.
 *
 *   Concorder n'est pas etre verifie. Ce transporteur est donc catalogue
 *   UNVERIFIED : selectionnable — sans quoi rien ne pourrait jamais le
 *   confronter a un vrai compte — mais ses capacites restent DECLAREES tant
 *   qu'un compte marchand reel n'a pas repondu.
 *
 * DEUX POINTS QUE LES SOURCES NE TRANCHENT PAS DE LA MEME FACON
 *   1. Le nom du produit a recuperer lors d'un echange : `produit_a_recupere`
 *      chez CourierDZ, `produit_a_recuperer` chez Vargo. Nous n'envoyons ce
 *      champ que sur un echange, et sous les deux formes serait pire : une cle
 *      inconnue peut faire echouer la requete entiere. La forme de Vargo est
 *      retenue — c'est celle qui est EMISE par un client, l'autre n'est qu'une
 *      regle de validation ecrite cote appelant.
 *   2. L'annulation. La fiche de synthese affirme qu'aucun point d'annulation
 *      n'existe ; Vargo appelle pourtant `DELETE api/v1/delete/order`. Nous
 *      l'implementons, et la matrice le declare — en sachant que « supprimer »
 *      pourrait ne valoir qu'avant enlevement. C'est precisement ce qu'un
 *      premier compte reel dira.
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

/**
 * Les societes de la famille, telles que le catalogue les nomme.
 *
 * Les domaines de DHD et de Conexlog sont publics ; celui de SpeedMail ne l'est
 * pas, et l'entree generique sert un transporteur Ecotrack quelconque, dont le
 * sous-domaine est propre au marchand. Dans ces deux cas l'URL est demandee.
 */
export const ECOTRACK_TENANTS: readonly CarrierFamilyIdentity[] = [
  { code: 'ECOTRACK', displayName: 'Ecotrack' },
  { code: 'DHD', displayName: 'DHD', defaultBaseUrl: 'https://platform.dhd-dz.com' },
  {
    code: 'UPS_CONEXLOG',
    displayName: 'UPS (Conexlog)',
    defaultBaseUrl: 'https://app.conexlog-dz.com',
  },
  { code: 'SPEEDMAIL', displayName: 'SpeedMail' },
];

/**
 * Statuts Ecotrack -> statuts EcomFlow.
 *
 * NOTRE TABLE EST PLUS FINE QUE CELLE DES SDK CONSULTES
 *   Vargo range tous les retours sous un unique « echec de livraison ». Notre
 *   machine a etats distingue RETURNING — le colis revient — de RETURNED — il
 *   est arrive. Les confondre couterait la moitie de l'ecran des retours :
 *   c'est entre ces deux instants que le stock se reserve et que le litige se
 *   traite.
 *
 *   De meme, « suspendu » n'est pas un retour : c'est une tentative qui a
 *   echoue et qui attend. Le colis est encore chez le transporteur.
 */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  order_information_received_by_carrier: 'CREATED',
  notification_on_order: 'CREATED',
  prete_a_expedier: 'CREATED',
  en_preparation_stock: 'CREATED',
  en_preparation: 'CREATED',

  picked: 'PICKED_UP',
  en_ramassage: 'PICKED_UP',

  accepted_by_carrier: 'IN_TRANSIT',
  vers_hub: 'IN_TRANSIT',
  en_hub: 'IN_TRANSIT',
  vers_wilaya: 'IN_TRANSIT',

  dispatched_to_driver: 'OUT_FOR_DELIVERY',
  en_livraison: 'OUT_FOR_DELIVERY',

  attempt_delivery: 'FAILED_ATTEMPT',
  suspendu: 'FAILED_ATTEMPT',

  livred: 'DELIVERED',
  encaissed: 'DELIVERED',
  payed: 'DELIVERED',
  livre_non_encaisse: 'DELIVERED',
  encaisse_non_paye: 'DELIVERED',
  paiements_prets: 'DELIVERED',
  paye_et_archive: 'DELIVERED',

  return_asked: 'RETURNING',
  return_in_transit: 'RETURNING',
  retour_chez_livreur: 'RETURNING',
  retour_transit_entrepot: 'RETURNING',
  retour_en_traitement: 'RETURNING',

  return_received: 'RETURNED',
  retour_recu: 'RETURNED',
  retour_archive: 'RETURNED',

  annule: 'CANCELLED',
};

interface EcotrackActivity {
  readonly status?: string;
  readonly date?: string;
  readonly time?: string;
  readonly reason?: string;
  readonly station?: string;
  readonly scanLocation?: string;
}

export class EcotrackAdapter implements CarrierAdapter {
  readonly code: string;
  readonly displayName: string;
  // Aucune des integrations consultees ne recoit de push : le suivi passe par
  // sondage. Un webhook Ecotrack existe peut-etre cote plateforme ; tant qu'il
  // n'est pas constate, le declarer serait promettre un temps reel absent.
  readonly supportsWebhooks = false;
  readonly supportsCancellation = true;

  readonly credentialFields: readonly {
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    helpText?: string;
  }[];

  private readonly identity: CarrierFamilyIdentity;
  private readonly logger: Logger;

  constructor(identity: CarrierFamilyIdentity) {
    this.identity = identity;
    this.code = identity.code;
    this.displayName = identity.displayName;
    this.logger = new Logger(`${EcotrackAdapter.name}:${identity.code}`);
    this.credentialFields = [
      {
        key: 'apiToken',
        label: 'Jeton API',
        secret: true,
        required: true,
        helpText:
          `Genere depuis le tableau de bord ${identity.displayName}. ` +
          'Chaque societe Ecotrack delivre le sien : il n y a pas de compte central.',
      },
      baseUrlField(identity, 'https://votre-transporteur.ecotrack.dz'),
    ];
  }

  async createShipment(
    context: CarrierContext,
    request: ShipmentRequest,
  ): Promise<CarrierResult<ShipmentCreated>> {
    const exchange = request.allowExchange ?? false;

    const payload: Record<string, unknown> = {
      // Notre reference voyage cote transporteur : c'est elle qu'un agent cite
      // au telephone, et le seul lien entre les deux systemes.
      reference: request.orderReference,
      nom_client: request.customerName,
      telephone: toLocalPhone(request.phoneE164),
      adresse: request.addressText,
      commune: request.commune,
      code_wilaya: request.wilayaCode,
      // Ecotrack compte en dinars, pas en centimes.
      montant: Math.round(request.codAmountCentimes / 100),
      produit: request.items
        .map((item) => `${item.name} x${item.quantity}`)
        .join(', ')
        .slice(0, 255),
      // 1 = Livraison, 2 = Echange, 3 = Pick-up, 4 = Recouvrement.
      type: exchange ? 2 : 1,
      stop_desk: request.deliveryType === 'PICKUP_POINT' ? 1 : 0,
    };

    if (request.secondaryPhone) payload.telephone_2 = toLocalPhone(request.secondaryPhone);
    if (request.notes) payload.remarque = request.notes.slice(0, 255);
    // `produit_a_recuperer` n'a de sens que sur un echange, et une cle inutile
    // peut faire refuser la requete entiere : on ne l'envoie que la.
    if (exchange) payload.produit_a_recuperer = 'Produit a recuperer';

    const response = await this.request(context, 'POST', '/api/v1/create/order', payload);
    if (!response.ok) return response.failure;

    const body = (response.data ?? {}) as Record<string, unknown>;

    if (body.success === false) {
      const message = text(body.message, `Creation refusee par ${this.displayName}.`);
      return carrierFailure(
        /existe|deja|duplicate|already/i.test(message) ? 'ALREADY_EXISTS' : 'INVALID_ADDRESS',
        message,
        { retryable: false, providerDetail: message },
      );
    }

    // Les sources ne s'accordent pas sur l'enveloppe de la reponse : on lit
    // donc les deux formes constatees plutot que d'en parier une.
    const data = (body.data ?? body) as Record<string, unknown>;
    const trackingNumber = text(data.tracking) || text(data.tracking_number) || text(body.tracking);

    if (trackingNumber.length === 0) {
      return carrierFailure(
        'PROVIDER_ERROR',
        `${this.displayName} n a pas retourne de numero de suivi.`,
        { retryable: true, providerDetail: JSON.stringify(body).slice(0, 300) },
      );
    }

    return {
      ok: true,
      trackingNumber,
      providerShipmentId: trackingNumber,
      // Le bordereau existe, mais l'API le rend en OCTETS PDF, pas en URL. Tant
      // qu'aucune route ne les sert, il n'y a pas de lien a promettre — et la
      // matrice declare donc `printableLabel: false` (D-049, D-070).
      labelUrl: null,
      costCentimes: null,
      providerStatus: text(data.status) || null,
    };
  }

  async cancelShipment(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ cancelled: boolean }>> {
    const response = await this.request(context, 'DELETE', '/api/v1/delete/order', {
      tracking: trackingNumber,
    });

    if (!response.ok) {
      // Un colis deja enleve n'est plus supprimable : c'est une reponse metier,
      // pas une panne, et l'agent doit la lire telle quelle.
      if (response.failure.code === 'PROVIDER_ERROR') {
        return carrierFailure(
          'NOT_CANCELLABLE',
          `Ce colis ne peut plus etre supprime chez ${this.displayName} (deja pris en charge).`,
          { retryable: false, providerDetail: response.failure.providerDetail },
        );
      }
      return response.failure;
    }

    const body = (response.data ?? {}) as Record<string, unknown>;
    if (body.success === false) {
      return carrierFailure(
        'NOT_CANCELLABLE',
        text(body.message, `Suppression refusee par ${this.displayName}.`),
        { retryable: false },
      );
    }

    return { ok: true, cancelled: true };
  }

  async getShipmentStatus(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ status: ShipmentStatus; providerStatus: string }>> {
    const tracking = await this.fetchTracking(context, trackingNumber);
    if (!tracking.ok) return tracking.failure;

    const last = tracking.activities.at(-1);
    const providerStatus = text(last?.status) || tracking.status;

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
    const tracking = await this.fetchTracking(context, trackingNumber);
    if (!tracking.ok) return tracking.failure;

    const events: TrackingEvent[] = tracking.activities
      .filter((activity) => text(activity.status).length > 0)
      .map((activity) => {
        const providerStatus = text(activity.status);
        const occurredAt = parseDateTime(activity.date, activity.time);

        return {
          providerStatus,
          normalizedStatus: this.normalizeStatus(providerStatus),
          description: text(activity.reason) || null,
          location: text(activity.scanLocation) || text(activity.station) || null,
          occurredAt,
          // L'empreinte combine colis, statut et horodatage : resonder le meme
          // historique ne cree aucun evenement en double.
          fingerprint: `${trackingNumber}|${providerStatus}|${text(activity.date)}${text(activity.time)}`,
          rawPayload: activity as unknown as Record<string, unknown>,
        };
      });

    return { ok: true, events };
  }

  normalizeStatus(providerStatus: string): ShipmentStatus {
    // Les libelles Ecotrack sont des identifiants techniques en minuscules
    // (`en_livraison`), mais un tenant peut en renvoyer une variante accentuee
    // (« payé_et_archivé ») : on compare sur une forme sans accents.
    const normalized = providerStatus
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');

    const direct = STATUS_MAP[normalized];
    if (direct) return direct;

    this.logger.warn(
      `Statut ${this.displayName} inconnu : « ${providerStatus} ». Normalise en ` +
        'IN_TRANSIT et conserve tel quel pour diagnostic.',
    );
    return 'IN_TRANSIT';
  }

  async healthCheck(context: CarrierContext): Promise<CarrierHealth> {
    const started = Date.now();
    // Le referentiel des wilayas est le point le plus leger : il valide le
    // jeton sans rien creer.
    const response = await this.request(context, 'GET', '/api/v1/get/wilayas');
    const latencyMs = Date.now() - started;

    return response.ok
      ? { ok: true, latencyMs }
      : { ok: false, latencyMs, message: response.failure.message };
  }

  // -------------------------------------------------------------------------

  private async fetchTracking(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<
    | { ok: true; activities: readonly EcotrackActivity[]; status: string }
    | { ok: false; failure: ReturnType<typeof carrierFailure> }
  > {
    const response = await this.request(
      context,
      'GET',
      `/api/v1/get/tracking/info?tracking=${encodeURIComponent(trackingNumber)}`,
    );
    if (!response.ok) return response;

    const body = (response.data ?? {}) as Record<string, unknown>;

    // Le suivi revient parfois indexe par numero de colis plutot qu'a plat. On
    // cherche le NOTRE, au lieu de prendre le premier venu : un mauvais
    // appariement ecrirait l'historique d'un colis sur un autre.
    const scoped = (body[trackingNumber] ?? body) as Record<string, unknown>;
    const activities = Array.isArray(scoped.activity)
      ? (scoped.activity as EcotrackActivity[]).filter(
          (entry): entry is EcotrackActivity => typeof entry === 'object' && entry !== null,
        )
      : [];

    // Les evenements arrivent sans ordre garanti ; l'ordre chronologique est ce
    // dont le reste du produit a besoin.
    const sorted = [...activities].sort(
      (left, right) =>
        parseDateTime(left.date, left.time).getTime() -
        parseDateTime(right.date, right.time).getTime(),
    );

    return { ok: true, activities: sorted, status: text(scoped.status) };
  }

  private async request(
    context: CarrierContext,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<
    { ok: true; data: unknown } | { ok: false; failure: ReturnType<typeof carrierFailure> }
  > {
    const apiToken = text(context.credentials.apiToken);

    if (apiToken.length === 0) {
      return {
        ok: false,
        failure: carrierFailure(
          'AUTHENTICATION_FAILED',
          `Jeton API ${this.displayName} manquant. Completez la configuration du transporteur.`,
          { retryable: false },
        ),
      };
    }

    const resolved = resolveBaseUrl(context, this.identity);
    if (!resolved.ok) return { ok: false, failure: resolved.failure };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${resolved.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.ok) {
        return { ok: true, data: await response.json().catch(() => ({})) };
      }

      const detail = (await response.text().catch(() => '')).slice(0, 300);

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          failure: carrierFailure(
            'AUTHENTICATION_FAILED',
            `Jeton ${this.displayName} refuse. Verifiez-le dans votre tableau de bord.`,
            { retryable: false, providerDetail: detail },
          ),
        };
      }

      if (response.status === 404) {
        return {
          ok: false,
          failure: carrierFailure('NOT_FOUND', `Ressource introuvable chez ${this.displayName}.`, {
            retryable: false,
            providerDetail: detail,
          }),
        };
      }

      if (response.status === 429) {
        return {
          ok: false,
          failure: carrierFailure('RATE_LIMITED', `Quota ${this.displayName} atteint.`, {
            retryable: true,
            providerDetail: detail,
          }),
        };
      }

      if (response.status === 422) {
        return {
          ok: false,
          failure: carrierFailure(
            'INVALID_ADDRESS',
            `${this.displayName} a refuse les donnees du colis.`,
            { retryable: false, providerDetail: detail },
          ),
        };
      }

      return {
        ok: false,
        failure: carrierFailure(
          'PROVIDER_ERROR',
          `${this.displayName} a repondu ${response.status}.`,
          { retryable: response.status >= 500, providerDetail: detail },
        ),
      };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      return {
        ok: false,
        failure: carrierFailure(
          aborted ? 'TIMEOUT' : 'PROVIDER_ERROR',
          aborted
            ? `Delai depasse lors de l appel a ${this.displayName}.`
            : `Appel ${this.displayName} impossible : ${(error as Error).message}`,
          { retryable: true },
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Un adaptateur par societe de la famille, tous sur la meme implementation. */
export function createEcotrackAdapters(): readonly EcotrackAdapter[] {
  return ECOTRACK_TENANTS.map((identity) => new EcotrackAdapter(identity));
}

/**
 * Date et heure arrivent en deux champs separes, et parfois pas du tout.
 * Une date illisible devient « maintenant » plutot que `Invalid Date` : un
 * evenement mal date reste un evenement, une date invalide casse un tri.
 */
function parseDateTime(date: unknown, time: unknown): Date {
  const day = text(date).trim();
  if (day.length === 0) return new Date();

  const clock = text(time).trim();
  const parsed = new Date(clock.length > 0 ? `${day} ${clock}` : day);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** Les plateformes algeriennes attendent le format national (0XXXXXXXXX). */
function toLocalPhone(e164: string): string {
  return e164.startsWith('+213') ? `0${e164.slice(4)}` : e164;
}
