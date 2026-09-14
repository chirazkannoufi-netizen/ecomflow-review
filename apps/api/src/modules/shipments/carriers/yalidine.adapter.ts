/**
 * Connecteur Yalidine Express.
 *
 * PORTEE ET HONNETETE DE CETTE IMPLEMENTATION (cahier de mission §5)
 *
 *   Ce connecteur appelle la VRAIE API de Yalidine
 *   (`https://api.yalidine.app/v1`), telle que documentee publiquement au
 *   moment de l'ecriture : creation de colis, consultation, annulation,
 *   historique. Il ne simule rien.
 *
 *   MAIS : la disponibilite et la stabilite de cette API ne dependent pas
 *   d'EcomFlow. Les cahiers des charges le disent eux-memes — « les noms et
 *   exemples de transporteurs sont des cibles d'integration et ne constituent
 *   pas une garantie de disponibilite d'une API » (V2 §42).
 *
 *   Ce connecteur doit donc etre VALIDE CONTRE UN COMPTE REEL avant mise en
 *   production. Tant que ce n'est pas fait, les tests l'exercent via des
 *   reponses enregistrees, et le connecteur `MOCK_CARRIER` sert aux parcours
 *   de bout en bout. Les champs exacts de la reponse sont lus defensivement
 *   (plusieurs noms possibles) precisement parce qu'ils n'ont pas encore ete
 *   confrontes a la production.
 *
 * IDEMPOTENCE
 *   Yalidine identifie un colis par sa reference d'expediteur
 *   (`order_id`). On y place la reference EcomFlow : un rejeu apres un delai
 *   depasse est alors detecte par Yalidine, qui refuse le doublon. C'est le
 *   mecanisme d'idempotence exige par la V2 §16.
 */

import { Injectable, Logger } from '@nestjs/common';
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
import { text } from '../../../common/utils/text';
import {
  baseUrlField,
  resolveBaseUrl,
  type CarrierFamilyIdentity,
} from './carrier-family';

const DEFAULT_BASE_URL = 'https://api.yalidine.app/v1';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Les quatre societes de la famille Yalidine.
 *
 * Guepex, Yalitec et We Can Services REVENDENT le reseau Yalidine : memes
 * points d'entree, memes noms de champs, meme authentification API ID / API
 * Token. Seuls le domaine et les identifiants changent — et leur domaine n'est
 * publie nulle part, d'ou l'URL de base demandee au marchand.
 *
 * Leurs conditions commerciales, elles, different : tarifs et wilayas couvertes
 * sont propres a chacune. C'est la couverture par wilaya du catalogue qui porte
 * cette difference, pas l'adaptateur.
 */
export const YALIDINE_IDENTITY: CarrierFamilyIdentity = {
  code: 'YALIDINE',
  displayName: 'Yalidine Express',
  defaultBaseUrl: DEFAULT_BASE_URL,
};

export const YALIDINE_RESELLERS: readonly CarrierFamilyIdentity[] = [
  { code: 'GUEPEX', displayName: 'Guepex' },
  { code: 'YALITEC', displayName: 'Yalitec' },
  { code: 'WECAN', displayName: 'We Can Services' },
];

/**
 * Correspondance statuts Yalidine -> statuts EcomFlow.
 *
 * Les libelles sont ceux observes dans la documentation Yalidine. La table est
 * volontairement PERMISSIVE : un statut inconnu ne fait pas echouer le
 * traitement, il est conserve tel quel en `providerStatus` et normalise en
 * `IN_TRANSIT`, ce qui evite de bloquer un colis pour un simple libelle
 * nouveau.
 */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  'pas encore expédié': 'CREATED',
  'pas encore expedie': 'CREATED',
  'a vérifier': 'CREATED',
  'a verifier': 'CREATED',
  'en préparation': 'CREATED',
  'en preparation': 'CREATED',
  'pas encore ramassé': 'CREATED',
  'pas encore ramasse': 'CREATED',
  'prêt à expédier': 'CREATED',
  'pret a expedier': 'CREATED',
  ramassé: 'PICKED_UP',
  ramasse: 'PICKED_UP',
  'bloqué': 'FAILED_ATTEMPT',
  bloque: 'FAILED_ATTEMPT',
  'débloqué': 'IN_TRANSIT',
  debloque: 'IN_TRANSIT',
  'transfert': 'IN_TRANSIT',
  'expédié': 'IN_TRANSIT',
  expedie: 'IN_TRANSIT',
  'centre': 'IN_TRANSIT',
  'en localisation': 'IN_TRANSIT',
  'vers wilaya': 'IN_TRANSIT',
  'reçu à wilaya': 'IN_TRANSIT',
  'recu a wilaya': 'IN_TRANSIT',
  'en attente du client': 'OUT_FOR_DELIVERY',
  'prêt pour livreur': 'OUT_FOR_DELIVERY',
  'pret pour livreur': 'OUT_FOR_DELIVERY',
  'sorti en livraison': 'OUT_FOR_DELIVERY',
  'en attente': 'OUT_FOR_DELIVERY',
  'livré': 'DELIVERED',
  livre: 'DELIVERED',
  'échec livraison': 'FAILED_ATTEMPT',
  'echec livraison': 'FAILED_ATTEMPT',
  'tentative échouée': 'FAILED_ATTEMPT',
  'tentative echouee': 'FAILED_ATTEMPT',
  'retour vers centre': 'RETURNING',
  'retourné au centre': 'RETURNING',
  'retourne au centre': 'RETURNING',
  'retour transfert': 'RETURNING',
  'retour groupé': 'RETURNING',
  'retour groupe': 'RETURNING',
  'retour à retirer': 'RETURNING',
  'retour a retirer': 'RETURNING',
  'retourné au vendeur': 'RETURNED',
  'retourne au vendeur': 'RETURNED',
  'echange échoué': 'RETURNED',
  annulé: 'CANCELLED',
  annule: 'CANCELLED',
  supprimé: 'CANCELLED',
  supprime: 'CANCELLED',
};

export class YalidineFamilyAdapter implements CarrierAdapter {
  readonly code: string;
  readonly displayName: string;
  // Aucune societe de la famille ne publie de webhook sortant : le suivi passe
  // par sondage.
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
    this.logger = new Logger(`${YalidineFamilyAdapter.name}:${identity.code}`);
    this.credentialFields = [
      {
        key: 'apiId',
        label: 'API ID',
        secret: false,
        required: true,
        helpText: `Disponible dans votre espace ${identity.displayName}, rubrique Developpeurs.`,
      },
      {
        key: 'apiToken',
        label: 'API Token',
        secret: true,
        required: true,
        helpText: 'Jeton secret. Ne le partagez jamais.',
      },
      {
        key: 'fromWilayaName',
        label: 'Wilaya d expedition',
        secret: false,
        required: true,
        helpText: 'Wilaya depuis laquelle vos colis sont enleves.',
      },
      baseUrlField(identity, 'https://api.exemple.app/v1'),
    ];
  }

  async createShipment(
    context: CarrierContext,
    request: ShipmentRequest,
  ): Promise<CarrierResult<ShipmentCreated>> {
    const payload = [
      {
        // Reference expediteur : c'est la cle d'idempotence cote Yalidine.
        order_id: request.orderReference,
        firstname: splitName(request.customerName).first,
        familyname: splitName(request.customerName).last,
        contact_phone: toLocalPhone(request.phoneE164),
        address: request.addressText,
        to_commune_name: request.commune,
        to_wilaya_name: request.wilayaName,
        from_wilaya_name: String(context.credentials.fromWilayaName ?? ''),
        product_list: request.items
          .map((item) => `${item.name} x${item.quantity}`)
          .join(', ')
          .slice(0, 255),
        // Yalidine attend des dinars, pas des centimes.
        price: Math.round(request.codAmountCentimes / 100),
        declared_value: Math.round(request.declaredValueCentimes / 100),
        do_insurance: false,
        // « stopdesk » = retrait en bureau ; 0 = livraison a domicile.
        is_stopdesk: request.deliveryType === 'PICKUP_POINT',
        stopdesk_id: request.pickupPointId ? Number(request.pickupPointId) : undefined,
        freeshipping: false,
        has_exchange: request.allowExchange ?? false,
        weight: request.weightGrams ? Math.ceil(request.weightGrams / 1000) : undefined,
      },
    ];

    const response = await this.request(context, 'POST', '/parcels/', payload);
    if (!response.ok) return response.failure;

    // Yalidine renvoie un objet indexe par `order_id`.
    const body = response.data as Record<string, unknown>;
    const entry = (body[request.orderReference] ?? Object.values(body)[0]) as
      | Record<string, unknown>
      | undefined;

    if (!entry) {
      return carrierFailure(
        'PROVIDER_ERROR',
        `Reponse ${this.displayName} inexploitable : aucun colis retourne.`,
        { retryable: true },
      );
    }

    if (entry.success === false) {
      const message = text(entry.message, `Creation refusee par ${this.displayName}.`);
      const duplicate = /existe|already/i.test(message);
      return carrierFailure(
        duplicate ? 'ALREADY_EXISTS' : 'INVALID_ADDRESS',
        message,
        { retryable: false, providerDetail: message },
      );
    }

    const trackingNumber = text(entry.tracking) || text(entry.tracking_number);
    if (trackingNumber.length === 0) {
      return carrierFailure(
        'PROVIDER_ERROR',
        `${this.displayName} n a pas retourne de numero de suivi.`,
        { retryable: true },
      );
    }

    return {
      ok: true,
      trackingNumber,
      providerShipmentId: trackingNumber,
      labelUrl: typeof entry.label === 'string' ? entry.label : null,
      costCentimes: null,
      providerStatus: typeof entry.last_status === 'string' ? entry.last_status : null,
    };
  }

  async cancelShipment(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ cancelled: boolean }>> {
    const response = await this.request(
      context,
      'DELETE',
      `/parcels/?tracking=${encodeURIComponent(trackingNumber)}`,
    );

    if (!response.ok) {
      // Yalidine refuse l'annulation d'un colis deja pris en charge : ce n'est
      // pas une panne, c'est une reponse metier que l'agent doit voir.
      if (response.failure.code === 'PROVIDER_ERROR') {
        return carrierFailure(
          'NOT_CANCELLABLE',
          `Ce colis ne peut plus etre annule chez ${this.displayName} (deja pris en charge).`,
          { retryable: false },
        );
      }
      return response.failure;
    }

    return { ok: true, cancelled: true };
  }

  async getShipmentStatus(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ status: ShipmentStatus; providerStatus: string }>> {
    const response = await this.request(
      context,
      'GET',
      `/parcels/?tracking=${encodeURIComponent(trackingNumber)}`,
    );
    if (!response.ok) return response.failure;

    const body = response.data as { data?: { last_status?: string }[] };
    const providerStatus = body.data?.[0]?.last_status;

    if (!providerStatus) {
      return carrierFailure('NOT_FOUND', `Colis introuvable chez ${this.displayName}.`, {
        retryable: false,
      });
    }

    return {
      ok: true,
      status: this.normalizeStatus(providerStatus),
      providerStatus,
    };
  }

  async getTrackingEvents(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ events: readonly TrackingEvent[] }>> {
    const response = await this.request(
      context,
      'GET',
      `/histories/?tracking=${encodeURIComponent(trackingNumber)}`,
    );
    if (!response.ok) return response.failure;

    const body = response.data as {
      data?: { status?: string; date_status?: string; reason?: string; center_name?: string }[];
    };

    const events: TrackingEvent[] = (body.data ?? [])
      .filter((entry) => Boolean(entry.status))
      .map((entry) => {
        const providerStatus = entry.status as string;
        const occurredAt = entry.date_status ? new Date(entry.date_status) : new Date();

        return {
          providerStatus,
          normalizedStatus: this.normalizeStatus(providerStatus),
          description: entry.reason ?? null,
          location: entry.center_name ?? null,
          occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
          // L'empreinte combine le colis, le statut et l'horodatage : rejouer
          // le meme historique ne cree aucun evenement en double.
          fingerprint: `${trackingNumber}|${providerStatus}|${entry.date_status ?? ''}`,
          rawPayload: entry,
        };
      });

    return { ok: true, events };
  }

  normalizeStatus(providerStatus: string): ShipmentStatus {
    const normalized = providerStatus
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const direct = STATUS_MAP[normalized] ?? STATUS_MAP[providerStatus.trim().toLowerCase()];
    if (direct) return direct;

    // Recherche par inclusion : Yalidine enrichit parfois ses libelles
    // (\u00ab Sorti en livraison (2eme tentative) \u00bb, par exemple).
    for (const [key, status] of Object.entries(STATUS_MAP)) {
      const normalizedKey = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (normalized.includes(normalizedKey)) return status;
    }

    this.logger.warn(
      `Statut ${this.displayName} inconnu : « ${providerStatus} ». Normalise en IN_TRANSIT ` +
        'et conserve tel quel pour diagnostic.',
    );
    return 'IN_TRANSIT';
  }

  async healthCheck(context: CarrierContext): Promise<CarrierHealth> {
    const started = Date.now();
    // `/wilayas/` est le point le plus leger de l'API : il valide les
    // identifiants sans rien creer.
    const response = await this.request(context, 'GET', '/wilayas/?page_size=1');
    const latencyMs = Date.now() - started;

    return response.ok
      ? { ok: true, latencyMs }
      : { ok: false, latencyMs, message: response.failure.message };
  }

  // -------------------------------------------------------------------------

  private async request(
    context: CarrierContext,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; failure: ReturnType<typeof carrierFailure> }> {
    const apiId = String(context.credentials.apiId ?? '');
    const apiToken = String(context.credentials.apiToken ?? '');

    if (!apiId || !apiToken) {
      return {
        ok: false,
        failure: carrierFailure(
          'AUTHENTICATION_FAILED',
          `Identifiants ${this.displayName} manquants. Completez la configuration du transporteur.`,
          { retryable: false },
        ),
      };
    }

    const resolved = resolveBaseUrl(context, this.identity);
    if (!resolved.ok) return { ok: false, failure: resolved.failure };

    const baseUrl = resolved.baseUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'X-API-ID': apiId,
          'X-API-TOKEN': apiToken,
          'content-type': 'application/json',
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
            `Identifiants ${this.displayName} refuses. Verifiez l API ID et le token.`,
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

/**
 * Yalidine — l'operateur d'origine, seul membre de la famille a etre VERIFIE.
 *
 * Reste `@Injectable` parce que le module et les tests le designent par son
 * type. Ses revendeurs, eux, n'ont pas de classe : ils sont la MEME
 * implementation, instanciee avec une autre identite (D-070).
 */
@Injectable()
export class YalidineAdapter extends YalidineFamilyAdapter {
  constructor() {
    super(YALIDINE_IDENTITY);
  }
}

/** Les revendeurs du reseau Yalidine, un adaptateur chacun, un seul code. */
export function createYalidineResellers(): readonly YalidineFamilyAdapter[] {
  return YALIDINE_RESELLERS.map((identity) => new YalidineFamilyAdapter(identity));
}

/**
 * Yalidine attend un prenom et un nom separes.
 * Un nom en un seul mot est place en prenom, le nom restant vide : c'est le
 * comportement le moins surprenant a l'affichage sur l'etiquette.
 */
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] ?? '', last: '' };
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

/** Yalidine attend le format national algerien (0XXXXXXXXX). */
function toLocalPhone(e164: string): string {
  return e164.startsWith('+213') ? `0${e164.slice(4)}` : e164;
}
