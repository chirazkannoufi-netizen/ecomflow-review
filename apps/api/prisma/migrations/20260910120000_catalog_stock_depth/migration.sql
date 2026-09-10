-- =============================================================================
-- Produits & stock : ce que le catalogue ne savait pas encore dire
--
-- LE PROBLEME
--   Le catalogue savait « combien reste-t-il ? ». Il ne savait rien dire de
--   quatre questions que l'exploitation pose tous les jours :
--
--     1. « On le vend quand meme, en rupture ? » Le seul reglage existant,
--        `tenant_settings.allow_oversell`, vaut pour TOUTE la boutique. Or la
--        reponse depend de l'article : une precommande assumee sur un produit
--        d'appel, un refus net sur un article perissable.
--     2. « Lequel dois-je sortir en premier ? » Deux receptions du meme article
--        a deux prix, ou a deux dates de peremption, etaient additionnees en un
--        seul nombre. Le detail — donc le cout d'achat reel et la peremption —
--        etait perdu a l'entree.
--     3. « Qu'est-ce que je dis au client au telephone ? » Les consignes de
--        vente vivaient dans la tete du commercant, ou dans un message a part.
--     4. « Ca coute combien de livrer a Adrar ? » Les frais de livraison
--        etaient saisis a la main, commande par commande, sans grille.
--
--   S'y ajoute une ligne manquante dans les totaux : l'ECHANGE. Un client qui
--   rapporte un article et en reprend un autre produit une difference de prix
--   qui n'etait ni une remise, ni un frais de livraison, et qui finissait donc
--   dans l'un des deux — faussant au choix le taux de remise accorde ou le
--   cout de transport.
--
-- CE QUE FAIT CETTE MIGRATION
--   Elle ajoute ces quatre dimensions SANS changer le comportement d'aucune
--   boutique existante. C'est la contrainte qui a dicte chaque valeur par
--   defaut :
--
--     - `out_of_stock_behavior` vaut `INHERIT` : la variante continue de suivre
--       le reglage de boutique. Choisir `ALLOW` par defaut, comme le suggerait
--       le brouillon de specification, aurait autorise la survente sur tout le
--       catalogue le jour du deploiement — l'inverse exact du reglage par
--       defaut de la boutique (`allow_oversell = false`).
--     - `stock_exit_strategy` vaut `FIFO`, mais reste sans effet tant qu'une
--       variante n'a aucun lot : une variante sans lot sort de
--       `inventory_levels` comme auparavant.
--     - `exchange_amount_centimes` vaut 0 : aucun total deja calcule ne bouge.
--     - Les deux tables de frais sont VIDES a la creation, et une grille vide
--       se comporte comme aujourd'hui (frais saisis sur la commande).
--
--   Autrement dit : rien ne change tant que personne ne remplit ces champs.
--
-- CE QU'ELLE NE FAIT PAS
--   Elle ne cree aucun lot pour le stock existant. Un lot porte une date de
--   reception et un cout d'achat reels ; les inventer retroactivement
--   produirait des chiffres de marge faux et credibles, ce qui est pire que
--   leur absence. Les variantes basculent au suivi par lots a leur prochaine
--   reception.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------

CREATE TYPE "OutOfStockBehavior" AS ENUM (
  'INHERIT',
  'ALLOW',
  'REFUSE_ORDER',
  'REFUSE_CONFIRMATION'
);

CREATE TYPE "StockExitStrategy" AS ENUM ('FIFO', 'LIFO', 'FEFO', 'RANDOM');


-- -----------------------------------------------------------------------------
-- 2. Colonnes ajoutees aux tables existantes
-- -----------------------------------------------------------------------------

ALTER TABLE "products"
  ADD COLUMN "confirmation_notes" TEXT;

ALTER TABLE "product_variants"
  ADD COLUMN "out_of_stock_behavior" "OutOfStockBehavior" NOT NULL DEFAULT 'INHERIT',
  ADD COLUMN "stock_exit_strategy"   "StockExitStrategy"  NOT NULL DEFAULT 'FIFO';

ALTER TABLE "orders"
  ADD COLUMN "exchange_amount_centimes" INTEGER NOT NULL DEFAULT 0;


-- -----------------------------------------------------------------------------
-- 3. Lots de stock
-- -----------------------------------------------------------------------------

CREATE TABLE "stock_batches" (
  "id"                 UUID           NOT NULL,
  "tenant_id"          UUID           NOT NULL,
  "variant_id"         UUID           NOT NULL,
  "reference"          TEXT,
  "quantity"           INTEGER        NOT NULL,
  "remaining_quantity" INTEGER        NOT NULL,
  "cost_centimes"      INTEGER        NOT NULL,
  "expires_at"         TIMESTAMPTZ(3),
  "received_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"               TEXT,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_batches_tenant_id_variant_id_received_at_idx"
  ON "stock_batches" ("tenant_id", "variant_id", "received_at");
CREATE INDEX "stock_batches_tenant_id_variant_id_expires_at_idx"
  ON "stock_batches" ("tenant_id", "variant_id", "expires_at");

-- Un lot epuise n'a plus a etre parcouru par la selection de sortie. L'index
-- partiel garde le balayage proportionnel au stock VIVANT, et non a
-- l'historique des receptions, qui lui ne cesse de croitre.
CREATE INDEX "stock_batches_open_idx"
  ON "stock_batches" ("tenant_id", "variant_id", "received_at")
  WHERE "remaining_quantity" > 0;

-- Coherence interne du lot : on ne sort pas plus que ce qui est entre, et une
-- reception vide n'existe pas.
ALTER TABLE "stock_batches"
  ADD CONSTRAINT "stock_batches_quantity_positive_check"
  CHECK ("quantity" > 0);

ALTER TABLE "stock_batches"
  ADD CONSTRAINT "stock_batches_remaining_within_quantity_check"
  CHECK ("remaining_quantity" >= 0 AND "remaining_quantity" <= "quantity");

ALTER TABLE "stock_batches"
  ADD CONSTRAINT "stock_batches_cost_non_negative_check"
  CHECK ("cost_centimes" >= 0);


-- -----------------------------------------------------------------------------
-- 4. Ventes complementaires
-- -----------------------------------------------------------------------------

CREATE TABLE "product_cross_sells" (
  "tenant_id"             UUID    NOT NULL,
  "product_id"            UUID    NOT NULL,
  "cross_sell_product_id" UUID    NOT NULL,
  "position"              INTEGER NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_cross_sells_pkey"
    PRIMARY KEY ("tenant_id", "product_id", "cross_sell_product_id")
);

CREATE INDEX "product_cross_sells_tenant_id_product_id_position_idx"
  ON "product_cross_sells" ("tenant_id", "product_id", "position");

-- Un produit ne se propose pas lui-meme en vente additionnelle.
ALTER TABLE "product_cross_sells"
  ADD CONSTRAINT "product_cross_sells_not_self_check"
  CHECK ("product_id" <> "cross_sell_product_id");


-- -----------------------------------------------------------------------------
-- 5. Grille de frais de livraison
--
-- `wilaya_code` : 1..58 pour une wilaya du decoupage de 2019, et 0 pour la
-- ligne « Toutes les wilayas », qui porte le tarif applique tant qu'aucune
-- ligne precise n'existe. Le CHECK garantit que ce sentinelle reste le seul
-- code hors referentiel accepte.
-- -----------------------------------------------------------------------------

CREATE TABLE "tenant_delivery_fees" (
  "tenant_id"                 UUID    NOT NULL,
  "wilaya_code"               INTEGER NOT NULL,
  "home_fee_centimes"         INTEGER NOT NULL,
  "pickup_point_fee_centimes" INTEGER NOT NULL,
  "return_fee_centimes"       INTEGER NOT NULL DEFAULT 0,
  "is_active"                 BOOLEAN NOT NULL DEFAULT true,
  "created_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "tenant_delivery_fees_pkey" PRIMARY KEY ("tenant_id", "wilaya_code")
);

ALTER TABLE "tenant_delivery_fees"
  ADD CONSTRAINT "tenant_delivery_fees_wilaya_range_check"
  CHECK ("wilaya_code" BETWEEN 0 AND 58);

ALTER TABLE "tenant_delivery_fees"
  ADD CONSTRAINT "tenant_delivery_fees_amounts_non_negative_check"
  CHECK (
    "home_fee_centimes" >= 0
    AND "pickup_point_fee_centimes" >= 0
    AND "return_fee_centimes" >= 0
  );

CREATE TABLE "product_delivery_fee_overrides" (
  "tenant_id"                 UUID    NOT NULL,
  "product_id"                UUID    NOT NULL,
  "wilaya_code"               INTEGER NOT NULL,
  "home_fee_centimes"         INTEGER,
  "pickup_point_fee_centimes" INTEGER,
  "created_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "product_delivery_fee_overrides_pkey"
    PRIMARY KEY ("tenant_id", "product_id", "wilaya_code")
);

ALTER TABLE "product_delivery_fee_overrides"
  ADD CONSTRAINT "product_delivery_fee_overrides_wilaya_range_check"
  CHECK ("wilaya_code" BETWEEN 0 AND 58);

ALTER TABLE "product_delivery_fee_overrides"
  ADD CONSTRAINT "product_delivery_fee_overrides_amounts_non_negative_check"
  CHECK (
    ("home_fee_centimes" IS NULL OR "home_fee_centimes" >= 0)
    AND ("pickup_point_fee_centimes" IS NULL OR "pickup_point_fee_centimes" >= 0)
  );

-- Une ligne de surcharge qui ne surcharge rien est du bruit : elle ferait
-- croire a un tarif particulier la ou la grille de boutique s'applique.
ALTER TABLE "product_delivery_fee_overrides"
  ADD CONSTRAINT "product_delivery_fee_overrides_not_empty_check"
  CHECK ("home_fee_centimes" IS NOT NULL OR "pickup_point_fee_centimes" IS NOT NULL);


-- -----------------------------------------------------------------------------
-- 6. Cles etrangeres — COMPOSITES la ou une jointure inter-tenant serait
--    physiquement possible (D-004, troisieme barriere).
--
--    Les cles candidates (tenant_id, id) exigees ici existent deja : elles ont
--    ete posees sur `products` et `product_variants` par la migration
--    20260829000100_integrity_constraints.
-- -----------------------------------------------------------------------------

ALTER TABLE "stock_batches"
  ADD CONSTRAINT "stock_batches_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_batches"
  ADD CONSTRAINT "stock_batches_tenant_variant_fkey"
  FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_cross_sells"
  ADD CONSTRAINT "product_cross_sells_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Les DEUX cotes du lien sont scopes : proposer en vente additionnelle un
-- produit d'une autre boutique doit etre impossible en base, pas seulement
-- improbable dans le service.
ALTER TABLE "product_cross_sells"
  ADD CONSTRAINT "product_cross_sells_tenant_product_fkey"
  FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_cross_sells"
  ADD CONSTRAINT "product_cross_sells_tenant_cross_sell_fkey"
  FOREIGN KEY ("tenant_id", "cross_sell_product_id") REFERENCES "products"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_delivery_fees"
  ADD CONSTRAINT "tenant_delivery_fees_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_delivery_fee_overrides"
  ADD CONSTRAINT "product_delivery_fee_overrides_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_delivery_fee_overrides"
  ADD CONSTRAINT "product_delivery_fee_overrides_tenant_product_fkey"
  FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- 7. Cle candidate (tenant_id, id) pour la seule nouvelle table a identifiant
--    propre, afin qu'une future relation puisse la referencer de facon
--    composite sans migration corrective.
-- -----------------------------------------------------------------------------

ALTER TABLE "stock_batches"
  ADD CONSTRAINT "stock_batches_tenant_id_id_key" UNIQUE ("tenant_id", "id");
