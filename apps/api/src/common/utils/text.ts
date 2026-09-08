/**
 * Conversion sure d'une valeur inconnue vers du texte.
 *
 * POURQUOI CE MODULE EXISTE
 *   Trois sources produisent des valeurs faiblement typees dans cette
 *   application : les parametres de requete HTTP, les charges utiles JSON des
 *   notifications, et les reponses des API transporteurs. Les interpoler
 *   directement dans un gabarit (`${value}`) donne « [object Object] » des que
 *   la valeur est un objet.
 *
 *   Ce n'est pas theorique : `?from[gte]=2026-01-01` produit un objet, et une
 *   API transporteur peut renvoyer `{"message": {"fr": "..."}}` la ou l'on
 *   attendait une chaine. Dans les deux cas, l'utilisateur lirait
 *   « [object Object] » dans un message d'erreur ou une notification.
 *
 * REGLE RETENUE
 *   Seules les valeurs PRIMITIVES sont converties. Un objet ou un tableau
 *   n'est jamais aplati : il est traite comme absent, et l'appelant fournit
 *   une valeur de repli lisible.
 */

/**
 * Forme textuelle d'une valeur primitive, ou `null` si la valeur n'en est pas
 * une (objet, tableau, fonction, `null`, `undefined`).
 */
export function asPrimitiveString(value: unknown): string | null {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? String(value) : null;
    case 'bigint':
      return value.toString();
    case 'boolean':
      return String(value);
    default:
      // Une date est le seul objet dont la representation textuelle est
      // univoque et utile.
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
      }
      return null;
  }
}

/**
 * Texte affichable pour une valeur inconnue.
 *
 * @param fallback ce qui est affiche lorsque la valeur n'est pas exploitable.
 *                 Prefererez toujours un libelle lisible a une chaine vide
 *                 dans un message destine a un utilisateur.
 */
export function text(value: unknown, fallback = ''): string {
  return asPrimitiveString(value) ?? fallback;
}
