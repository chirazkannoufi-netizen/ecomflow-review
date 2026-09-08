-- =============================================================================
-- EcomFlow — Contraintes d'integrite non exprimables dans le schema Prisma
--
-- Cette migration ajoute la DERNIERE LIGNE DE DEFENSE de l'isolation
-- multi-tenant et de la coherence du stock. Elle est volontairement ecrite a
-- la main : Prisma ne sait declarer ni les cles etrangeres composites, ni les
-- index partiels, ni les contraintes CHECK.
--
-- Trois familles de garanties :
--
--  1. INTEGRITE MULTI-TENANT (cles etrangeres composites)
--     Sans elles, un defaut applicatif pourrait rattacher une commande du
--     tenant A a un client du tenant B : la base l'accepterait. Avec elles,
--     PostgreSQL refuse l'ecriture, quelle que soit la faille applicative.
--     C'est la traduction en SQL de la regle « les donnees de deux boutiques
--     ne sont jamais melangees » (V1 §29, V2 §37).
--
--  2. INTEGRITE DU STOCK (contraintes CHECK)
--     Un niveau de stock ne peut jamais devenir negatif, une quantite de
--     mouvement est toujours strictement positive (le sens est porte par le
--     type du mouvement). Cf. V2 §14.
--
--  3. UNICITE CONDITIONNELLE (index partiels)
--     Un seul retour ouvert par commande, un seul colis actif par commande,
--     un seul role par defaut, etc.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Cles candidates (tenant_id, id) requises par les cles etrangeres composites
-- -----------------------------------------------------------------------------

ALTER TABLE "customers"          ADD CONSTRAINT "customers_tenant_id_id_key"          UNIQUE ("tenant_id", "id");
ALTER TABLE "addresses"          ADD CONSTRAINT "addresses_tenant_id_id_key"          UNIQUE ("tenant_id", "id");
ALTER TABLE "products"           ADD CONSTRAINT "products_tenant_id_id_key"           UNIQUE ("tenant_id", "id");
ALTER TABLE "product_variants"   ADD CONSTRAINT "product_variants_tenant_id_id_key"   UNIQUE ("tenant_id", "id");
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_id_key" UNIQUE ("tenant_id", "id");
ALTER TABLE "orders"             ADD CONSTRAINT "orders_tenant_id_id_key"             UNIQUE ("tenant_id", "id");
ALTER TABLE "order_items"        ADD CONSTRAINT "order_items_tenant_id_id_key"        UNIQUE ("tenant_id", "id");
ALTER TABLE "memberships"        ADD CONSTRAINT "memberships_tenant_id_id_key"        UNIQUE ("tenant_id", "id");
ALTER TABLE "shipments"          ADD CONSTRAINT "shipments_tenant_id_id_key"          UNIQUE ("tenant_id", "id");
ALTER TABLE "returns"            ADD CONSTRAINT "returns_tenant_id_id_key"            UNIQUE ("tenant_id", "id");
ALTER TABLE "carrier_accounts"   ADD CONSTRAINT "carrier_accounts_tenant_id_id_key"   UNIQUE ("tenant_id", "id");
ALTER TABLE "integrations"       ADD CONSTRAINT "integrations_tenant_id_id_key"       UNIQUE ("tenant_id", "id");
ALTER TABLE "sheet_sync_configs" ADD CONSTRAINT "sheet_sync_configs_tenant_id_id_key" UNIQUE ("tenant_id", "id");
ALTER TABLE "sync_runs"          ADD CONSTRAINT "sync_runs_tenant_id_id_key"          UNIQUE ("tenant_id", "id");
ALTER TABLE "whatsapp_threads"   ADD CONSTRAINT "whatsapp_threads_tenant_id_id_key"   UNIQUE ("tenant_id", "id");


-- -----------------------------------------------------------------------------
-- 2. Cles etrangeres composites : la relation ne peut pas franchir un tenant
--
-- On remplace chaque FK simple par une FK (tenant_id, <fk>) -> (tenant_id, id).
-- -----------------------------------------------------------------------------

-- --- Adresses -> clients ---
ALTER TABLE "addresses" DROP CONSTRAINT "addresses_customer_id_fkey";
ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_tenant_customer_fkey"
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Produits -> categories ---
ALTER TABLE "products" DROP CONSTRAINT "products_category_id_fkey";
ALTER TABLE "products"
  ADD CONSTRAINT "products_tenant_category_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "product_categories"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Variantes -> produits ---
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_product_id_fkey";
ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_tenant_product_fkey"
  FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Niveaux de stock -> variantes ---
ALTER TABLE "inventory_levels" DROP CONSTRAINT "inventory_levels_variant_id_fkey";
ALTER TABLE "inventory_levels"
  ADD CONSTRAINT "inventory_levels_tenant_variant_fkey"
  FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Mouvements de stock -> variantes ---
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_variant_id_fkey";
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_tenant_variant_fkey"
  FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Commandes -> clients / adresses / membres ---
ALTER TABLE "orders" DROP CONSTRAINT "orders_customer_id_fkey";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tenant_customer_fkey"
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders" DROP CONSTRAINT "orders_address_id_fkey";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tenant_address_fkey"
  FOREIGN KEY ("tenant_id", "address_id") REFERENCES "addresses"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orders" DROP CONSTRAINT "orders_assigned_membership_id_fkey";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tenant_assignee_fkey"
  FOREIGN KEY ("tenant_id", "assigned_membership_id") REFERENCES "memberships"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orders" DROP CONSTRAINT "orders_prepared_by_membership_id_fkey";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tenant_preparer_fkey"
  FOREIGN KEY ("tenant_id", "prepared_by_membership_id") REFERENCES "memberships"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Lignes de commande -> commandes / variantes ---
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_id_fkey";
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_tenant_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_items" DROP CONSTRAINT "order_items_variant_id_fkey";
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_tenant_variant_fkey"
  FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Historique de statut / tentatives d'appel -> commandes ---
ALTER TABLE "order_status_history" DROP CONSTRAINT "order_status_history_order_id_fkey";
ALTER TABLE "order_status_history"
  ADD CONSTRAINT "order_status_history_tenant_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_call_attempts" DROP CONSTRAINT "order_call_attempts_order_id_fkey";
ALTER TABLE "order_call_attempts"
  ADD CONSTRAINT "order_call_attempts_tenant_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_call_attempts" DROP CONSTRAINT "order_call_attempts_membership_id_fkey";
ALTER TABLE "order_call_attempts"
  ADD CONSTRAINT "order_call_attempts_tenant_membership_fkey"
  FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Doublons -> commandes (sujet et candidat) ---
ALTER TABLE "order_duplicate_flags" DROP CONSTRAINT "order_duplicate_flags_subject_order_id_fkey";
ALTER TABLE "order_duplicate_flags"
  ADD CONSTRAINT "order_duplicate_flags_tenant_subject_fkey"
  FOREIGN KEY ("tenant_id", "subject_order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_duplicate_flags" DROP CONSTRAINT "order_duplicate_flags_candidate_order_id_fkey";
ALTER TABLE "order_duplicate_flags"
  ADD CONSTRAINT "order_duplicate_flags_tenant_candidate_fkey"
  FOREIGN KEY ("tenant_id", "candidate_order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Expeditions -> commandes / comptes transporteur ---
ALTER TABLE "shipments" DROP CONSTRAINT "shipments_order_id_fkey";
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_tenant_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shipments" DROP CONSTRAINT "shipments_carrier_account_id_fkey";
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_tenant_carrier_account_fkey"
  FOREIGN KEY ("tenant_id", "carrier_account_id") REFERENCES "carrier_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipment_events" DROP CONSTRAINT "shipment_events_shipment_id_fkey";
ALTER TABLE "shipment_events"
  ADD CONSTRAINT "shipment_events_tenant_shipment_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Retours -> commandes / colis / lignes ---
ALTER TABLE "returns" DROP CONSTRAINT "returns_order_id_fkey";
ALTER TABLE "returns"
  ADD CONSTRAINT "returns_tenant_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "returns" DROP CONSTRAINT "returns_shipment_id_fkey";
ALTER TABLE "returns"
  ADD CONSTRAINT "returns_tenant_shipment_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "return_items" DROP CONSTRAINT "return_items_return_id_fkey";
ALTER TABLE "return_items"
  ADD CONSTRAINT "return_items_tenant_return_fkey"
  FOREIGN KEY ("tenant_id", "return_id") REFERENCES "returns"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "return_items" DROP CONSTRAINT "return_items_order_item_id_fkey";
ALTER TABLE "return_items"
  ADD CONSTRAINT "return_items_tenant_order_item_fkey"
  FOREIGN KEY ("tenant_id", "order_item_id") REFERENCES "order_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "return_items" DROP CONSTRAINT "return_items_variant_id_fkey";
ALTER TABLE "return_items"
  ADD CONSTRAINT "return_items_tenant_variant_fkey"
  FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Integrations Google Sheets ---
ALTER TABLE "sheet_sync_configs" DROP CONSTRAINT "sheet_sync_configs_integration_id_fkey";
ALTER TABLE "sheet_sync_configs"
  ADD CONSTRAINT "sheet_sync_configs_tenant_integration_fkey"
  FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "integrations"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sheet_row_imports" DROP CONSTRAINT "sheet_row_imports_config_id_fkey";
ALTER TABLE "sheet_row_imports"
  ADD CONSTRAINT "sheet_row_imports_tenant_config_fkey"
  FOREIGN KEY ("tenant_id", "config_id") REFERENCES "sheet_sync_configs"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sheet_row_imports" DROP CONSTRAINT "sheet_row_imports_order_id_fkey";
ALTER TABLE "sheet_row_imports"
  ADD CONSTRAINT "sheet_row_imports_tenant_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sheet_row_imports" DROP CONSTRAINT "sheet_row_imports_sync_run_id_fkey";
ALTER TABLE "sheet_row_imports"
  ADD CONSTRAINT "sheet_row_imports_tenant_sync_run_fkey"
  FOREIGN KEY ("tenant_id", "sync_run_id") REFERENCES "sync_runs"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_integration_id_fkey";
ALTER TABLE "sync_runs"
  ADD CONSTRAINT "sync_runs_tenant_integration_fkey"
  FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "integrations"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_config_id_fkey";
ALTER TABLE "sync_runs"
  ADD CONSTRAINT "sync_runs_tenant_config_fkey"
  FOREIGN KEY ("tenant_id", "config_id") REFERENCES "sheet_sync_configs"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- WhatsApp ---
ALTER TABLE "whatsapp_threads" DROP CONSTRAINT "whatsapp_threads_order_id_fkey";
ALTER TABLE "whatsapp_threads"
  ADD CONSTRAINT "whatsapp_threads_tenant_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_threads" DROP CONSTRAINT "whatsapp_threads_integration_id_fkey";
ALTER TABLE "whatsapp_threads"
  ADD CONSTRAINT "whatsapp_threads_tenant_integration_fkey"
  FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "integrations"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- 3. Contraintes CHECK — integrite du stock et des montants
-- -----------------------------------------------------------------------------

-- Un niveau de stock ne peut jamais devenir negatif (V2 §14).
ALTER TABLE "inventory_levels"
  ADD CONSTRAINT "inventory_levels_non_negative_chk"
  CHECK ("on_hand" >= 0 AND "reserved" >= 0 AND "quarantine" >= 0);

-- La quantite d'un mouvement est toujours strictement positive : le sens du
-- mouvement est porte par la colonne `type`, jamais par le signe.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_positive_quantity_chk"
  CHECK ("quantity" > 0);

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_non_negative_state_chk"
  CHECK ("on_hand_after" >= 0 AND "reserved_after" >= 0 AND "quarantine_after" >= 0);

-- Une ligne de commande porte au moins une unite.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_positive_quantity_chk"
  CHECK ("quantity" > 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_non_negative_amounts_chk"
  CHECK ("unit_price_centimes" >= 0 AND "discount_centimes" >= 0);

-- La quantite preparee ne peut pas depasser la quantite commandee.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_prepared_quantity_chk"
  CHECK ("prepared_quantity" IS NULL OR ("prepared_quantity" >= 0 AND "prepared_quantity" <= "quantity"));

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_non_negative_amounts_chk"
  CHECK (
    "items_total_centimes" >= 0
    AND "discount_centimes" >= 0
    AND "delivery_fee_centimes" >= 0
    AND "total_centimes" >= 0
    AND "carrier_cost_centimes" >= 0
    AND "return_cost_centimes" >= 0
  );

-- La wilaya figee sur la commande appartient au referentiel officiel (1-58).
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_wilaya_range_chk"
  CHECK ("wilaya_code_snapshot" IS NULL OR ("wilaya_code_snapshot" BETWEEN 1 AND 58));

ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_wilaya_range_chk"
  CHECK ("wilaya_code" BETWEEN 1 AND 58);

ALTER TABLE "return_items"
  ADD CONSTRAINT "return_items_positive_quantity_chk"
  CHECK ("quantity" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_positive_amount_chk"
  CHECK ("amount_centimes" > 0);

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_non_negative_price_chk"
  CHECK ("price_centimes" >= 0);

-- Le score de fiabilite reste dans sa plage documentee.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_reliability_score_range_chk"
  CHECK ("reliability_score" IS NULL OR ("reliability_score" BETWEEN 0 AND 100));

-- Un essai se termine forcement apres son debut.
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_trial_order_chk"
  CHECK ("trial_start_at" IS NULL OR "trial_end_at" IS NULL OR "trial_end_at" > "trial_start_at");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_period_order_chk"
  CHECK (
    "current_period_start" IS NULL
    OR "current_period_end" IS NULL
    OR "current_period_end" > "current_period_start"
  );

-- Un role de plateforme n'appartient a aucun tenant, et inversement.
ALTER TABLE "roles"
  ADD CONSTRAINT "roles_scope_tenant_coherence_chk"
  CHECK (
    ("scope" = 'PLATFORM' AND "tenant_id" IS NULL)
    OR ("scope" = 'TENANT' AND "tenant_id" IS NOT NULL)
  );


-- -----------------------------------------------------------------------------
-- 4. Index UNIQUE partiels — unicite conditionnelle
-- -----------------------------------------------------------------------------

-- Un seul retour OUVERT par commande. Un retour cloture n'empeche pas la
-- creation d'un nouveau retour (SAV ulterieur), mais un webhook transporteur
-- rejoue ne peut pas creer un second retour en cours.
CREATE UNIQUE INDEX "returns_one_open_per_order_uidx"
  ON "returns" ("tenant_id", "order_id")
  WHERE "status" NOT IN ('CLOSED', 'CANCELLED');

-- Un seul colis ACTIF par commande (V2 §17 : « eviter de creer deux colis
-- pour la meme commande »). Un colis annule ou en erreur peut etre remplace.
CREATE UNIQUE INDEX "shipments_one_active_per_order_uidx"
  ON "shipments" ("tenant_id", "order_id")
  WHERE "status" NOT IN ('CANCELLED', 'ERROR', 'RETURNED', 'DELIVERED');

-- Un seul transporteur par defaut par boutique.
CREATE UNIQUE INDEX "carrier_accounts_single_default_uidx"
  ON "carrier_accounts" ("tenant_id")
  WHERE "is_default" = true;

-- Une seule variante « par defaut » par produit.
CREATE UNIQUE INDEX "product_variants_single_default_uidx"
  ON "product_variants" ("product_id")
  WHERE "is_default" = true;

-- Une seule adresse par defaut par client.
CREATE UNIQUE INDEX "addresses_single_default_uidx"
  ON "addresses" ("customer_id")
  WHERE "is_default" = true;

-- Un numero de telephone verifie n'ouvre qu'un seul essai (Addendum §38).
-- Index partiel : les lignes sans numero verifie ne se bloquent pas entre elles.
CREATE UNIQUE INDEX "trial_registrations_verified_phone_uidx"
  ON "trial_registrations" ("verified_phone_e164")
  WHERE "verified_phone_e164" IS NOT NULL;

-- Un seul essai en attente de revue par tenant.
CREATE INDEX "trial_registrations_pending_review_idx"
  ON "trial_registrations" ("created_at")
  WHERE "decision" = 'MANUAL_REVIEW' AND "reviewed_at" IS NULL;


-- -----------------------------------------------------------------------------
-- 5. Index de performance complementaires
-- -----------------------------------------------------------------------------

-- File de confirmation : requete la plus chaude de l'application.
-- Index partiel restreint aux statuts reellement presents dans la file.
CREATE INDEX "orders_confirmation_queue_idx"
  ON "orders" ("tenant_id", "queue_priority", "next_callback_at", "created_at")
  WHERE "status" IN ('TO_CONFIRM', 'NO_ANSWER', 'CALL_BACK', 'POSTPONED')
    AND "archived_at" IS NULL;

-- File de preparation.
CREATE INDEX "orders_preparation_queue_idx"
  ON "orders" ("tenant_id", "confirmed_at")
  WHERE "status" IN ('CONFIRMED', 'IN_PREPARATION') AND "archived_at" IS NULL;

-- Colis a synchroniser par polling : on ne balaye que les colis en vol.
CREATE INDEX "shipments_pending_tracking_idx"
  ON "shipments" ("last_synced_at")
  WHERE "status" IN ('CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'RETURNING');

-- Boite d'envoi : seuls les evenements en attente sont scannes.
CREATE INDEX "outbox_events_pending_idx"
  ON "outbox_events" ("available_at")
  WHERE "status" IN ('PENDING', 'FAILED');

-- Fils WhatsApp arrives a expiration, a rendre a un agent humain.
CREATE INDEX "whatsapp_threads_timeout_idx"
  ON "whatsapp_threads" ("timeout_at")
  WHERE "state" IN ('PENDING', 'SENT');

-- Recherche plein texte legere sur le nom du client (recherche globale, V2 §22).
CREATE INDEX "customers_name_trgm_idx"
  ON "customers" USING gin ("full_name" gin_trgm_ops);

CREATE INDEX "products_name_trgm_idx"
  ON "products" USING gin ("name" gin_trgm_ops);
