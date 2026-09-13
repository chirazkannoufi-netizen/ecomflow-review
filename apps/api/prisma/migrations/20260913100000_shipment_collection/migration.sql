-- =============================================================================
-- Encaissement : « livre » ne veut pas dire « paye »
--
-- LE MANQUE, ET SON COUT
--   Le produit savait dire qu'un colis etait livre. Il ne savait rien dire de
--   l'ARGENT. En paiement a la livraison, ce sont deux evenements distincts,
--   souvent separes de plusieurs semaines : le client paie au livreur, et le
--   transporteur reverse a la boutique lors d'une remise de fonds.
--
--   Entre les deux, la somme n'existe nulle part dans le systeme. C'est
--   exactement la que disparaissent les montants qu'une boutique ne reclame
--   jamais — non par negligence, mais parce que rien ne lui dit lesquels
--   manquent. La matrice de capacites (D-049) nommait deja cette donnee
--   (« bons d'encaissement ») sans qu'aucune colonne ne puisse l'accueillir.
--
-- TROIS ETATS, ET LE TROISIEME EST LE PLUS IMPORTANT
--   1. `collected_centimes` renseigne : le transporteur a reverse.
--   2. `collected_centimes` NULL, mais le transporteur publie la donnee :
--      pas encore reverse — c'est une creance, et l'ecran doit la montrer.
--   3. `collected_centimes` NULL parce que le transporteur NE PUBLIE PAS cette
--      donnee : il n'y a rien a attendre, et afficher un vide identique au cas
--      precedent ferait lire « impaye » la ou il faut lire « inconnu ».
--
--   La colonne ne peut pas distinguer 2 de 3 — c'est
--   `carrier_capabilities.realtime_collection_vouchers` qui tranche. Les deux
--   doivent etre lues ensemble, et l'ecran le fait.
--
-- CE QUE CETTE MIGRATION NE PROMET PAS
--   Sur les quatre connecteurs du catalogue, UN SEUL declare publier cette
--   donnee : le transporteur de test. Yalidine — le seul reellement
--   implemente et utilise — ne la publie pas. Ces colonnes resteront donc
--   vides en production tant qu'un connecteur capable n'aura pas ete integre,
--   et l'ecran l'annoncera explicitement plutot que de laisser croire a des
--   impayes.
-- =============================================================================

ALTER TABLE "shipments"
  ADD COLUMN "collected_centimes"    INTEGER,
  ADD COLUMN "collected_at"          TIMESTAMPTZ(3),
  ADD COLUMN "remittance_reference"  TEXT;

-- Un reversement negatif n'a pas de sens ; zero en a un (colis refuse, rien
-- encaisse, mais le transporteur l'a bien declare).
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_collected_non_negative_check"
  CHECK ("collected_centimes" IS NULL OR "collected_centimes" >= 0);

-- Un montant sans date de reversement serait inexploitable pour un
-- rapprochement comptable : on ne saurait pas de quelle remise il releve.
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_collected_needs_date_check"
  CHECK ("collected_centimes" IS NULL OR "collected_at" IS NOT NULL);

-- « Qu'est-ce qui est livre mais pas encore encaisse ? » est LA question que
-- cette colonne existe pour repondre. L'index partiel la sert directement.
CREATE INDEX "shipments_pending_collection_idx"
  ON "shipments" ("tenant_id", "status")
  WHERE "collected_centimes" IS NULL;
