/**
 * Contrat commun des connecteurs transporteurs — V1 §12, V2 §16.
 *
 * OBJECTIF : « ne pas coupler les regles metier a un transporteur unique »
 * (V2 §38). Les services d'expedition et de tracking ne connaissent que cette
 * interface ; ajouter Yalidine, ZR Express ou Ecotrack n'exige aucune
 * modification du coeur.
 *
 * PRINCIPES DE CONCEPTION
 *
 *  1. AUCUNE EXCEPTION POUR UN ECHEC METIER. Les methodes retournent un
 *     resultat discrimine (`ok: true | false`). Un transporteur qui refuse une
 *     wilaya non desservie n'est pas un incident technique : c'est une reponse
 *     metier que l'agent doit lire et traiter. Seules les erreurs de
 *     PROGRAMMATION levent une exception.
 *
 *  2. LE CARACTERE REESSAYABLE EST EXPLICITE. Chaque echec declare s'il vaut la
 *     peine d'etre rejoue. Rejouer une adresse invalide est inutile ; rejouer
 *     un delai depasse est indispensable.
 *
 *  3. LA NORMALISATION DES STATUTS APPARTIENT AU CONNECTEUR. Lui seul connait
 *     le vocabulaire de son transporteur. Le coeur ne manipule que les statuts
 *     EcomFlow, tout en CONSERVANT le statut brut pour le diagnostic (V2 §17).
 *
 *  4. IDEMPOTENCE. `createShipment` recoit une cle d'idempotence : un rejeu
 *     apres un delai depasse ne doit jamais produire deux colis chez le
 *     transporteur.
 */

import type { ShipmentStatus } from '@ecomflow/shared';

/** Coordonnees et contenu du colis a expedier. */
export interface ShipmentRequest {
  /** Cle d'idempotence, stable pour une meme tentative d'expedition. */
  readonly idempotencyKey: string;
  readonly orderReference: string;

  readonly customerName: string;
  readonly phoneE164: string;
  /** Second numero, transmis quand le transporteur le supporte. */
  readonly secondaryPhone?: string | null;

  readonly wilayaCode: number;
  readonly wilayaName: string;
  readonly commune: string;
  readonly addressText: string;

  /** Livraison a domicile, ou retrait en point relais / bureau. */
  readonly deliveryType: 'HOME' | 'PICKUP_POINT';
  /** Identifiant du point relais, requis si `deliveryType = PICKUP_POINT`. */
  readonly pickupPointId?: string | null;

  /** Montant a encaisser a la livraison (COD), en centimes. */
  readonly codAmountCentimes: number;
  readonly declaredValueCentimes: number;
  readonly weightGrams?: number | null;

  readonly items: readonly {
    name: string;
    sku: string;
    quantity: number;
  }[];

  readonly notes?: string | null;
  /** Le colis peut-il etre ouvert avant paiement ? Usage courant en Algerie. */
  readonly allowOpening?: boolean;
  /** Echange autorise a la livraison. */
  readonly allowExchange?: boolean;
}

export interface ShipmentCreated {
  readonly trackingNumber: string;
  /** Identifiant interne du transporteur, si different du tracking. */
  readonly providerShipmentId?: string | null;
  /** URL de l'etiquette a imprimer. */
  readonly labelUrl?: string | null;
  /** Cout facture par le transporteur, en centimes, si communique. */
  readonly costCentimes?: number | null;
  readonly providerStatus?: string | null;
}

export interface TrackingEvent {
  readonly providerStatus: string;
  readonly normalizedStatus: ShipmentStatus;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly occurredAt: Date;
  /**
   * Empreinte stable de l'evenement, calculee par le connecteur.
   * Permet de rejouer un webhook ou un sondage sans creer de doublon.
   */
  readonly fingerprint: string;
  readonly rawPayload?: Record<string, unknown> | null;
}

/** Echec declare par un connecteur. */
export interface CarrierFailure {
  readonly ok: false;
  /** Code stable, exploitable par l'interface et les tests. */
  readonly code:
    | 'INVALID_ADDRESS'
    | 'UNSUPPORTED_WILAYA'
    | 'AUTHENTICATION_FAILED'
    | 'RATE_LIMITED'
    | 'TIMEOUT'
    | 'PROVIDER_ERROR'
    | 'ALREADY_EXISTS'
    | 'NOT_FOUND'
    | 'NOT_CANCELLABLE'
    | 'NOT_IMPLEMENTED';
  readonly message: string;
  /** Une nouvelle tentative a-t-elle une chance d'aboutir ? */
  readonly retryable: boolean;
  readonly providerDetail?: string | null;
}

export type CarrierResult<T> = ({ readonly ok: true } & T) | CarrierFailure;

export interface CarrierHealth {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly message?: string;
}

/** Identifiants et parametres d'un compte transporteur, dechiffres. */
export interface CarrierCredentials {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface CarrierContext {
  readonly credentials: CarrierCredentials;
  /** Parametres non sensibles : adresse d'enlevement, options de service. */
  readonly config: Record<string, unknown>;
}

/**
 * Connecteur transporteur.
 *
 * Les methodes correspondent exactement a celles listees en V2 §16 :
 * `createShipment`, `cancelShipment`, `getShipmentStatus`, `getTrackingEvents`,
 * `normalizeStatus`, `healthCheck`.
 */
export interface CarrierAdapter {
  /** Code stable, identique a `carriers.code` en base. */
  readonly code: string;
  readonly displayName: string;

  /** Le connecteur sait-il recevoir des webhooks de tracking ? */
  readonly supportsWebhooks: boolean;
  readonly supportsCancellation: boolean;

  /** Champs d'identifiants attendus, pour generer l'ecran de configuration. */
  readonly credentialFields: readonly {
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    helpText?: string;
  }[];

  createShipment(
    context: CarrierContext,
    request: ShipmentRequest,
  ): Promise<CarrierResult<ShipmentCreated>>;

  cancelShipment(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ cancelled: boolean }>>;

  getShipmentStatus(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ status: ShipmentStatus; providerStatus: string }>>;

  getTrackingEvents(
    context: CarrierContext,
    trackingNumber: string,
  ): Promise<CarrierResult<{ events: readonly TrackingEvent[] }>>;

  /** Traduit un statut transporteur en statut EcomFlow. */
  normalizeStatus(providerStatus: string): ShipmentStatus;

  healthCheck(context: CarrierContext): Promise<CarrierHealth>;

  /**
   * Analyse un webhook entrant. Retourne `null` si la charge utile ne concerne
   * pas ce connecteur ou n'est pas exploitable.
   */
  parseWebhook?(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    context: CarrierContext,
  ): { trackingNumber: string; events: readonly TrackingEvent[] } | null;

  /** Verifie la signature d'un webhook entrant. */
  verifyWebhookSignature?(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    context: CarrierContext,
  ): boolean;
}

/** Jeton d'injection du registre de connecteurs. */
export const CARRIER_ADAPTERS = Symbol('ECOMFLOW_CARRIER_ADAPTERS');

/** Construit un echec typique de facon concise. */
export function carrierFailure(
  code: CarrierFailure['code'],
  message: string,
  options: { retryable?: boolean; providerDetail?: string | null } = {},
): CarrierFailure {
  return {
    ok: false,
    code,
    message,
    // Par defaut, seuls les codes explicitement transitoires sont reessayables :
    // rejouer indefiniment une adresse invalide ne ferait qu'user le quota du
    // transporteur et retarder la correction par un humain.
    retryable:
      options.retryable ?? ['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR'].includes(code),
    providerDetail: options.providerDetail ?? null,
  };
}
