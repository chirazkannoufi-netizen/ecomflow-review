'use client';

/**
 * Livre — V1 §12, V2 §17.
 *
 * « Livre » ne dit pas si l'argent est rentre. En paiement a la livraison, le
 * reversement du transporteur arrive souvent des semaines apres la remise du
 * colis : c'est un FAIT SEPARE, et cet ecran est le seul endroit ou les deux se
 * lisent cote a cote.
 *
 * Le corps est partage avec « En livraison » (`DeliveryQueue`), qui n'affiche
 * pas la colonne d'encaissement : une somme non encore due n'est pas une
 * creance.
 */

import { DeliveryQueue } from '@/components/delivery-queue';

export default function DeliveredPage() {
  return <DeliveryQueue stage="DELIVERED" />;
}
