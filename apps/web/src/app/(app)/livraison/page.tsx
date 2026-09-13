'use client';

/**
 * En livraison — V1 §12, V2 §17.
 *
 * Les colis qui roulent. La question de l'ecran est « depuis combien de temps,
 * et combien de fois le livreur s'est-il deja presente ? » : ce sont les deux
 * seuls signaux qui declenchent un appel avant qu'un colis ne parte en retour.
 *
 * Le corps est partage avec « Livre » (`DeliveryQueue`) : meme table, memes
 * filtres, meme export. Seule l'etape change.
 */

import { DeliveryQueue } from '@/components/delivery-queue';

export default function InDeliveryPage() {
  return <DeliveryQueue stage="IN_DELIVERY" />;
}
