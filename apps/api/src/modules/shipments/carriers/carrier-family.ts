/**
 * Familles de transporteurs — une implementation, plusieurs societes (D-070).
 *
 * CE QUE « FAMILLE » VEUT DIRE ICI
 *   Plusieurs societes de livraison algeriennes n'exposent pas des API
 *   differentes : elles exposent LA MEME, chacune sur son domaine et avec ses
 *   identifiants. Guepex, Yalitec et We Can revendent le reseau Yalidine ;
 *   DHD, Conexlog (« UPS » en Algerie) et SpeedMail tournent sur la plateforme
 *   partagee Ecotrack, qui heberge plus de quatre-vingts societes.
 *
 *   Ecrire un adaptateur par societe reviendrait a copier trois fois le meme
 *   fichier, et a corriger trois fois chaque defaut trouve — en en oubliant un.
 *   Un adaptateur par FAMILLE, instancie une fois par societe avec son identite
 *   et son domaine, dit la verite technique : c'est le meme code parce que
 *   c'est la meme API.
 *
 * L'URL DE BASE EST UNE DONNEE DU COMPTE, PAS DU CODE
 *   Les revendeurs ne publient pas leur domaine : le marchand le lit dans son
 *   propre tableau de bord. Il est donc saisi comme un champ d'identifiants —
 *   non secret, mais propre au compte, exactement comme la wilaya d'expedition
 *   de Yalidine l'etait deja.
 */

import { carrierFailure, type CarrierContext, type CarrierFailure } from './carrier-adapter.interface';
import { text } from '../../../common/utils/text';

/** Identite d'une societe au sein d'une famille technique. */
export interface CarrierFamilyIdentity {
  /** Code stable, identique a `carriers.code` en base. */
  readonly code: string;
  readonly displayName: string;
  /**
   * Domaine connu publiquement, quand il l'est.
   *
   * Absent pour les societes dont le domaine n'est publie nulle part : le
   * champ devient alors OBLIGATOIRE a la saisie. Mieux vaut demander une URL
   * que d'en deviner une et d'appeler un hote qui n'est pas le bon.
   */
  readonly defaultBaseUrl?: string;
}

/** Champ d'identifiant « URL de base », adapte a ce que la famille sait deja. */
export function baseUrlField(identity: CarrierFamilyIdentity, example: string) {
  return {
    key: 'baseUrl',
    label: 'URL de base',
    secret: false,
    // Une societe dont le domaine est connu n'a pas a le faire ressaisir ;
    // une societe dont il ne l'est pas ne peut pas s'en passer.
    required: identity.defaultBaseUrl === undefined,
    helpText:
      identity.defaultBaseUrl === undefined
        ? `Domaine de votre espace ${identity.displayName}, visible dans son tableau de bord (ex. ${example}).`
        : `Laissez vide pour utiliser ${identity.defaultBaseUrl}.`,
  } as const;
}

/**
 * Resout l'URL de base d'un compte, et refuse ce qui n'en est pas une.
 *
 * POURQUOI VALIDER ICI PLUTOT QUE FAIRE CONFIANCE
 *   Cette URL vient d'un formulaire : c'est le seul endroit du produit ou un
 *   utilisateur choisit l'hote que le SERVEUR va appeler. Une faute de frappe
 *   enverrait les identifiants du marchand a un domaine quelconque ; un
 *   `http://` les enverrait en clair. On exige donc HTTPS et un nom d'hote
 *   qualifie, et on refuse tout le reste AVANT le premier appel.
 */
export function resolveBaseUrl(
  context: CarrierContext,
  identity: CarrierFamilyIdentity,
): { ok: true; baseUrl: string } | { ok: false; failure: CarrierFailure } {
  const raw = (
    text(context.credentials.baseUrl) ||
    text(context.config.baseUrl) ||
    identity.defaultBaseUrl ||
    ''
  ).trim();

  if (raw.length === 0) {
    return {
      ok: false,
      failure: carrierFailure(
        'AUTHENTICATION_FAILED',
        `URL de base manquante pour ${identity.displayName}. ` +
          'Renseignez-la depuis votre tableau de bord transporteur.',
        { retryable: false },
      ),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, failure: invalidBaseUrl(identity, raw) };
  }

  // HTTPS seulement : ces appels transportent un jeton d'API.
  // Un hote sans point est soit une machine du reseau local, soit une faute de
  // frappe — dans les deux cas, ce n'est pas un transporteur.
  if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.')) {
    return { ok: false, failure: invalidBaseUrl(identity, raw) };
  }

  // Le chemin est conserve — `https://procolis.com/api_v1` en a un — mais la
  // barre finale part, sans quoi chaque appel porterait un double slash.
  return { ok: true, baseUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') };
}

function invalidBaseUrl(identity: CarrierFamilyIdentity, raw: string): CarrierFailure {
  return carrierFailure(
    'AUTHENTICATION_FAILED',
    `URL de base invalide pour ${identity.displayName} : « ${raw} ». ` +
      'Attendu : une adresse HTTPS complete, par exemple https://exemple.com.',
    { retryable: false },
  );
}
