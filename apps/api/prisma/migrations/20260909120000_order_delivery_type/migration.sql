-- =============================================================================
-- Mode de livraison : domicile ou bureau (« stopdesk »), porte par la COMMANDE
--
-- LE PROBLEME
--   « Vous preferez a domicile ou au bureau ? » est une question posee a chaque
--   appel de confirmation. La reponse n'etait stockee NULLE PART.
--
--   Le mode de livraison n'existait que comme parametre transitoire au moment
--   de creer le colis (`CarrierAdapter.deliveryType`), avec `'HOME'` pour
--   valeur par defaut. Autrement dit : l'agent notait la demande du client dans
--   la note libre — au mieux — et le colis partait quand meme en livraison a
--   domicile. Un client qui avait demande le bureau recevait un livreur devant
--   sa porte, ou rien du tout.
--
-- CE QUE FAIT CETTE MIGRATION
--   Le mode devient un champ de la commande, decide pendant l'appel et relu a
--   l'expedition. Les deux valeurs sont exactement celles que l'interface
--   transporteur attend deja, pour qu'aucune traduction ne s'intercale.
--
--   `DEFAULT 'HOME'` sur les lignes existantes : c'est le comportement qui
--   etait REELLEMENT applique jusqu'ici, la migration ne change donc l'issue
--   d'aucune commande deja passee. Elle rend seulement explicite ce qui etait
--   implicite.
-- =============================================================================

CREATE TYPE "DeliveryType" AS ENUM ('HOME', 'PICKUP_POINT');

ALTER TABLE "orders"
  ADD COLUMN "delivery_type" "DeliveryType" NOT NULL DEFAULT 'HOME';
