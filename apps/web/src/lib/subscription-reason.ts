/**
 * Traduction du motif de blocage d'un abonnement.
 *
 * LE PROBLEME QUE CE MODULE RESOUT
 *   `GET /subscriptions/current` renvoie un champ `reason` : une phrase deja
 *   REDIGEE, en francais, composee cote serveur par `deriveSubscriptionState`
 *   (packages/shared/src/trial.ts) — « Essai gratuit termine. Un abonnement
 *   actif est requis. ».
 *
 *   Affichee telle quelle, elle laissait du francais brut au milieu de
 *   l'interface arabe, et precisement dans les deux endroits concus pour etre
 *   impossibles a manquer : le bandeau bloquant de la coque applicative et
 *   l'encart « Acces restreint » de l'ecran Abonnement.
 *
 * LE STATUT PORTE LA TRADUCTION, PAS LA PHRASE
 *   `status` est un code stable (`SubscriptionStatus`), partage par les deux
 *   bouts de la chaine et deja utilise pour decider de l'affichage. C'est donc
 *   lui qui indexe le catalogue. `reason` ne sert plus que de FILET : si le
 *   serveur introduit un statut que le catalogue ne connait pas encore, une
 *   phrase francaise exacte reste preferable a une cle brute a l'ecran.
 *
 *   Traduire cote serveur aurait suppose que l'API connaisse la langue de
 *   l'utilisateur a chaque appel ; or la preference vit dans la session du
 *   navigateur et peut changer sans rechargement. Le rendu est donc le seul
 *   endroit qui connaisse a coup sur la langue affichee.
 */

/**
 * Statuts non operationnels dont le motif est traduit
 * (`subscriptionBanner.reasons.*`, present dans les deux catalogues).
 *
 * Les statuts operationnels (`TRIAL_ACTIVE`, `TRIAL_ENDING`, `ACTIVE`,
 * `PAST_DUE`) n'apparaissent dans aucun bandeau de blocage : ils n'ont pas
 * de motif a traduire.
 */
const TRANSLATED_REASON_STATUSES: readonly string[] = [
  'TRIAL_ENDED',
  'EXPIRED',
  'SUSPENDED',
  'CANCELLED',
];

/**
 * Cle de traduction du motif, ou `null` si le statut n'en a pas.
 *
 * Retourner une CLE plutot qu'un libelle garde ce module independant de
 * next-intl : l'appelant possede deja sa fonction `t`, liee au bon espace de
 * noms, et c'est elle qui sait quoi faire d'une cle absente.
 */
export function subscriptionReasonKey(status: string): string | null {
  return TRANSLATED_REASON_STATUSES.includes(status) ? `reasons.${status}` : null;
}
