-- =============================================================================
-- Matrice de capacites : alignement sur la liste de l'audit Ecomanager
--
-- POURQUOI UNE SECONDE MIGRATION SI PRES DE LA PREMIERE
--   La migration precedente (20260910130000) a cree la matrice a partir du
--   contrat `CarrierAdapter` et des operations du produit, faute d'acces au
--   document d'audit — qui vit dans le chantier de reecriture separe. La liste
--   de l'audit est desormais connue. Elle ne recoupe la version derivee qu'a
--   moitie, et la ou elle differe, c'est elle qui a raison : elle decrit ce
--   qu'un transporteur ALGERIEN propose a un commercant, la ou la version
--   derivee decrivait comment notre code lui parle.
--
--   La premiere migration n'est pas reecrite : elle est publiee, et le detour
--   fait partie de l'histoire du schema. On corrige par-dessus, en disant
--   pourquoi.
--
-- CE QUE L'AUDIT VOIT QUE LA VERSION DERIVEE NE VOYAIT PAS
--
--   1. LE VOLUME. « Ajout en masse » n'etait nulle part. Une journee de cent
--      commandes se poussait cent fois.
--
--   2. LE DETAIL DES ETATS. La version derivee avait UN drapeau de suivi
--      (`tracking_polling`). L'audit en distingue trois — tentatives, livrees,
--      echouees — et il a raison : beaucoup de transporteurs renvoient
--      « livre » sans jamais detailler les tentatives, or c'est la tentative
--      qui declenche le rappel du client.
--
--   3. LE TEMPS REEL COMME AXE, PAS COMME CASE. `tracking_webhook` etait un
--      seul booleen. L'audit croise les deux : QUOI est synchronise, et si
--      c'est POUSSE ou RELEVE. Un statut releve toutes les heures ne permet pas
--      de rappeler un client dans la demi-heure qui suit un echec.
--
--   4. L'ARGENT. « Bons d'encaissement » manquait completement. En paiement a
--      la livraison, c'est la seule source qui dit si l'argent est rentre : un
--      colis « livre » n'est pas un colis paye. C'est sans doute le manque le
--      plus couteux des dix.
--
--   5. LE SAV EN DEUX GESTES. Echange et reprise (« pick-up ») sont deux
--      operations distinctes, et un transporteur peut savoir faire l'une sans
--      l'autre.
--
--   6. LA MODIFICATION APRES DEPOT, dedoublee en adresse et prix. La version
--      derivee avait un `update_shipment` global, qui n'aurait rien permis de
--      decider : accepter un changement d'adresse et accepter un changement du
--      montant a encaisser n'engagent pas le meme risque cote transporteur.
--
-- CE QUE LA VERSION DERIVEE VOYAIT ET QUE L'AUDIT NE COUVRE PAS
--   Six capacites correspondaient a des champs REELS de `ShipmentRequest` /
--   `ShipmentCreated` : etiquette imprimable, annuaire des bureaux, paiement a
--   la livraison, colis ouvert avant paiement, second numero, poids declare.
--   Elles sont retirees de la matrice pour tenir les dix-sept de l'audit, et
--   l'ecart est journalise en D-049 plutot qu'efface : ce sont des questions
--   qui se reposeront.
--
-- CONSERVATION DES VALEURS
--   Les colonnes qui correspondent 1:1 sont RENOMMEES, pas recreees : les
--   quatre lignes deja amorcees gardent leur valeur. La ou un drapeau se
--   scinde en trois, la valeur d'origine est recopiee sur les trois, puis le
--   seed reprend la main avec les valeurs exactes de chaque connecteur.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La contrainte qui portait sur une colonne supprimee
--
--    PostgreSQL la supprimerait avec la colonne ; on le fait explicitement pour
--    que la lecture de cette migration ne laisse aucune ambiguite.
-- -----------------------------------------------------------------------------

ALTER TABLE "carrier_capabilities"
  DROP CONSTRAINT "carrier_capabilities_directory_requires_pickup_check";


-- -----------------------------------------------------------------------------
-- 2. Renommages 1:1 — la valeur amorcee est conservee
-- -----------------------------------------------------------------------------

ALTER TABLE "carrier_capabilities" RENAME COLUMN "create_shipment"       TO "add_order";
ALTER TABLE "carrier_capabilities" RENAME COLUMN "cancel_shipment"       TO "delete_order";
ALTER TABLE "carrier_capabilities" RENAME COLUMN "pickup_point_delivery" TO "stop_desk";
ALTER TABLE "carrier_capabilities" RENAME COLUMN "exchange_on_delivery"  TO "after_sales_exchange";

-- « Couverture interrogeable » et « wilayas non livrables poussees en temps
-- reel » sont la meme information vue des deux bouts : savoir ou le
-- transporteur ne livre pas, aujourd'hui.
ALTER TABLE "carrier_capabilities"
  RENAME COLUMN "wilaya_coverage_query" TO "realtime_undeliverable_wilayas";

-- Les deux drapeaux de suivi deviennent chacun le representant « livrees » de
-- leur mode ; leurs deux freres sont ajoutes juste apres et recoivent la meme
-- valeur de depart.
ALTER TABLE "carrier_capabilities" RENAME COLUMN "tracking_polling" TO "sync_delivered";
ALTER TABLE "carrier_capabilities" RENAME COLUMN "tracking_webhook" TO "realtime_delivered";


-- -----------------------------------------------------------------------------
-- 3. Colonnes ajoutees par l'audit
-- -----------------------------------------------------------------------------

ALTER TABLE "carrier_capabilities"
  ADD COLUMN "add_order_bulk"               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sync_attempted"               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sync_failed"                  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "realtime_attempted"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "realtime_failed"              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "realtime_collection_vouchers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "realtime_address_change"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "realtime_price_change"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "after_sales_pickup"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stock_at_carrier"             BOOLEAN NOT NULL DEFAULT false;

-- Report de la valeur d'origine sur les deux freres de chaque scission : un
-- connecteur qui savait relever ses statuts savait relever les trois etats.
UPDATE "carrier_capabilities"
   SET "sync_attempted"     = "sync_delivered",
       "sync_failed"        = "sync_delivered",
       "realtime_attempted" = "realtime_delivered",
       "realtime_failed"    = "realtime_delivered";

-- L'ancien `update_shipment` couvrait indistinctement les deux modifications.
UPDATE "carrier_capabilities"
   SET "realtime_address_change" = "update_shipment",
       "realtime_price_change"   = "update_shipment";


-- -----------------------------------------------------------------------------
-- 4. Colonnes sans equivalent dans la matrice de l'audit
--
--    Voir l'en-tete : six d'entre elles correspondent a des champs reels de
--    `ShipmentRequest`. Elles sortent de la MATRICE, pas du produit — les
--    champs existent toujours et continuent d'etre transmis aux connecteurs.
-- -----------------------------------------------------------------------------

ALTER TABLE "carrier_capabilities"
  DROP COLUMN "update_shipment",
  DROP COLUMN "proof_of_delivery",
  DROP COLUMN "printable_label",
  DROP COLUMN "pickup_manifest",
  DROP COLUMN "pickup_point_directory",
  DROP COLUMN "cash_on_delivery",
  DROP COLUMN "fee_quotation",
  DROP COLUMN "package_opening",
  DROP COLUMN "secondary_phone",
  DROP COLUMN "declared_weight";


-- -----------------------------------------------------------------------------
-- 5. Coherence interne
--
--    On ne depose pas cent commandes d'un coup chez un transporteur qui ne
--    sait pas en deposer une.
-- -----------------------------------------------------------------------------

ALTER TABLE "carrier_capabilities"
  ADD CONSTRAINT "carrier_capabilities_bulk_requires_single_check"
  CHECK ("add_order_bulk" = false OR "add_order" = true);
