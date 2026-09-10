-- =============================================================================
-- Etiquette imprimable : dix-huitieme capacite, hors liste de l'audit
--
-- POURQUOI ROUVRIR UNE MATRICE QU'ON VIENT D'ALIGNER
--   La migration precedente retirait `printable_label` pour tenir les dix-sept
--   capacites de l'audit. C'etait respecter le CHIFFRE au detriment du
--   PRINCIPE — et le principe est la vraie trouvaille de l'audit : ne jamais
--   afficher une action que le transporteur ne sait pas faire.
--
--   `Shipment.label_url` commande un lien visible dans deux ecrans,
--   `/expeditions` et la fiche commande. Ce lien s'affiche aujourd'hui « si
--   l'URL existe », donc disparait en silence. L'exploitant ne peut pas
--   distinguer deux situations qui appellent deux gestes opposes :
--
--     - le transporteur ne produit PAS d'etiquette (rien a attendre, il faut
--       recopier le bordereau a la main) ;
--     - le transporteur en produit une mais la creation a echoue (il faut
--       relancer, ou appeler).
--
--   Un champ absent ne dit pas laquelle des deux. La capacite, si.
--
-- LES CINQ AUTRES RESTENT DE SIMPLES CHAMPS
--   `pickup_point_id`, `cod_amount_centimes`, `allow_opening`,
--   `secondary_phone`, `weight_grams` ont ete examines selon le meme critere :
--   « ce champ commande-t-il une affordance visible ? ». Aucun ne le fait
--   aujourd'hui — l'action d'expedition envoie un corps vide, et aucun ecran
--   n'expose de controle pour eux. Il n'y a donc aucune fausse promesse a
--   supprimer. Le detail, et les deux qui redeviendraient candidats le jour ou
--   la boite d'expedition gagnerait des options, sont en D-049.
--
-- VALEUR PAR DEFAUT
--   `false`. Une capacite ne se presume pas : c'est le seed, en regard de ce
--   que chaque connecteur sait reellement faire, qui la declare.
-- =============================================================================

ALTER TABLE "carrier_capabilities"
  ADD COLUMN "printable_label" BOOLEAN NOT NULL DEFAULT false;

-- Les quatre connecteurs du catalogue produisent tous une etiquette : c'est ce
-- que declarait la matrice avant son alignement, et rien n'a change de leur
-- cote. On restaure donc la valeur plutot que de laisser le defaut effacer une
-- information deja etablie ; le seed la reaffirmera de toute facon.
UPDATE "carrier_capabilities" SET "printable_label" = true;

-- On ne produit pas l'etiquette d'une commande qu'on ne sait pas deposer.
ALTER TABLE "carrier_capabilities"
  ADD CONSTRAINT "carrier_capabilities_label_requires_order_check"
  CHECK ("printable_label" = false OR "add_order" = true);
