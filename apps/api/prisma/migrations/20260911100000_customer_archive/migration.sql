-- =============================================================================
-- Archivage d'un client : retirer de la liste sans rien effacer
--
-- LE PROBLEME
--   Les commandes et les produits s'archivent depuis l'origine
--   (`orders.archived_at`, `products.archived_at`), conformement au principe
--   pose en tete du schema : « les suppressions sont logiques ». Les clients,
--   eux, n'avaient AUCUN moyen d'etre retires d'une liste.
--
--   Le seul geste destructif disponible sur un client etait
--   `POST /customers/:id/anonymize`, qui efface les donnees personnelles et
--   est IRREVERSIBLE. Cabler une action « supprimer la selection » dessus
--   aurait transforme un menage de liste — geste courant, souvent fait vite,
--   parfois par erreur — en effacement definitif de donnees personnelles.
--
--   Les deux gestes existent pour des raisons differentes et ne doivent pas
--   partager un bouton :
--     - ARCHIVER repond a « je ne veux plus voir cette fiche » ;
--     - ANONYMISER repond a « ce client demande l'effacement de ses donnees ».
--
-- CE QUE FAIT CETTE MIGRATION
--   Une colonne, nullable, sans valeur par defaut : aucun client existant
--   n'est archive, et le comportement des ecrans ne change pas tant que
--   personne n'archive.
--
-- CE QU'ELLE NE FAIT PAS
--   Elle ne touche pas a `anonymized_at`, ni aux commandes du client. Un
--   client archive conserve son historique : la cle etrangere
--   `orders.customer_id` est en RESTRICT, et c'est voulu — une commande sans
--   client rendrait faux tout calcul de fiabilite et de rentabilite.
-- =============================================================================

ALTER TABLE "customers"
  ADD COLUMN "archived_at" TIMESTAMPTZ(3);

-- Les ecrans listent les clients ACTIFS : l'index partiel sert la requete
-- courante sans porter le poids des fiches retirees.
CREATE INDEX "customers_tenant_active_idx"
  ON "customers" ("tenant_id", "created_at")
  WHERE "archived_at" IS NULL;
