-- =============================================================================
-- Transporteur choisi AVANT l'expedition
--
-- LE MANQUE
--   `Shipment` porte le compte transporteur, mais il n'existe qu'a partir du
--   moment ou le colis est cree. Or le choix du livreur se fait AVANT : on
--   prepare une tournee, on repartit les commandes entre deux societes, puis on
--   expedie.
--
--   Sans ce champ, ce choix n'avait nulle part ou se poser. Le parametre
--   `carrierAccountId` de `createShipment` existait, mais aucun ecran ne le
--   renseignait : toute expedition retombait sur le compte PAR DEFAUT de la
--   boutique. Une boutique travaillant avec deux transporteurs ne pouvait donc
--   pas choisir lequel, autrement qu'en changeant son defaut entre deux clics.
--
-- INTENTION ICI, FAIT LA-BAS
--   Ce champ enregistre une INTENTION, revisable tant que le colis n'est pas
--   cree. Une fois `Shipment` existant, c'est `shipments.carrier_account_id`
--   qui fait foi — la commande peut avoir ete expediee par un autre
--   transporteur que celui prevu, et l'historique doit garder le vrai.
--
--   C'est la raison pour laquelle les deux colonnes coexistent sans que l'une
--   soit une copie de l'autre.
--
-- ON DELETE SET NULL, ET NON RESTRICT
--   Supprimer un compte transporteur ne doit pas bloquer sur des commandes qui
--   ne sont pas encore parties : l'intention devient simplement caduque, et
--   l'ecran redemandera un choix. `shipments.carrier_account_id` reste en
--   RESTRICT, lui, parce qu'un colis PARTI par ce compte est un fait qu'on
--   n'efface pas.
-- =============================================================================

ALTER TABLE "orders"
  ADD COLUMN "carrier_account_id" UUID;

-- Cle etrangere COMPOSITE (D-004) : une commande ne peut pas viser le compte
-- transporteur d'une autre boutique. La cle candidate (tenant_id, id) sur
-- `carrier_accounts` existe depuis la migration 20260829000100.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tenant_carrier_account_fkey"
  FOREIGN KEY ("tenant_id", "carrier_account_id")
  REFERENCES "carrier_accounts"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- « Quelles commandes sont affectees a ce livreur, et ou en sont-elles ? » est
-- la question de la tournee du jour.
CREATE INDEX "orders_tenant_id_carrier_account_id_status_idx"
  ON "orders" ("tenant_id", "carrier_account_id", "status");
