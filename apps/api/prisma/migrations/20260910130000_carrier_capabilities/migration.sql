-- =============================================================================
-- Transporteurs : ce que chaque connecteur sait faire, et ou il sait aller
--
-- LE PROBLEME
--   EcomFlow traitait tous les transporteurs comme s'ils savaient faire la
--   meme chose. Deux drapeaux seulement les distinguaient
--   (`supports_webhooks`, `supports_cancellation`), et l'interface proposait
--   partout les memes actions.
--
--   La consequence se paie a l'usage : un bouton qui echoue apres avoir ete
--   clique. « Annuler le colis » sur un transporteur qui ne sait pas annuler,
--   « Imprimer l'etiquette » sur un transporteur qui n'en produit pas. A
--   chaque fois, l'agent croit avoir agi, le client n'est pas prevenu, et
--   personne ne decouvre l'erreur avant que le colis arrive quand meme.
--
--   Trois autres manques, plus discrets :
--     - agent de livraison independant et societe de livraison etaient
--       indistinguables, ce qui rend tout reporting par canal impossible ;
--     - la reference envoyee au transporteur etait TOUJOURS celle d'EcomFlow,
--       jamais le numero de commande que le commercant a sous les yeux quand
--       il appelle le transporteur pour retrouver un colis ;
--     - rien ne disait qu'un transporteur detenait physiquement le stock de la
--       boutique, alors que cela change la logique de reservation.
--
-- CE QUE FAIT CETTE MIGRATION
--   Elle ajoute une matrice de capacites, une couverture par wilaya, et trois
--   reglages de compte. Rien n'est active par defaut au-dela de ce que le
--   produit faisait deja :
--
--     - `carrier_capabilities` est cree VIDE. Une ligne absente signifie
--       « capacites inconnues » : le seed la remplit a partir du catalogue de
--       connecteurs, qui est deja la source de verite de
--       `supports_webhooks` / `supports_cancellation`. La table est une
--       PROJECTION du code, jamais une saisie editoriale.
--     - `carrier_wilaya_coverage` est cree VIDE, et l'absence de ligne veut
--       dire « couverture inconnue », pas « non desservie ». Prendre le
--       silence pour un refus masquerait 58 wilayas d'un coup.
--     - `kind` vaut `DELIVERY_COMPANY` : c'est ce que sont les comptes
--       existants (Yalidine, ZR Express, Ecotrack).
--     - Les deux drapeaux de compte valent `false`, soit exactement le
--       comportement actuel.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------

CREATE TYPE "CarrierAccountKind" AS ENUM ('DELIVERY_AGENT', 'DELIVERY_COMPANY');


-- -----------------------------------------------------------------------------
-- 2. Reglages portes par le COMPTE d'une boutique
--
--    Ces trois-la vivent sur `carrier_accounts` et non sur `carriers` : ce sont
--    des arrangements entre UNE boutique et son transporteur, pas des
--    proprietes du reseau.
-- -----------------------------------------------------------------------------

ALTER TABLE "carrier_accounts"
  ADD COLUMN "kind" "CarrierAccountKind" NOT NULL DEFAULT 'DELIVERY_COMPANY',
  ADD COLUMN "send_order_number_instead_of_reference" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stock_held_by_courier" BOOLEAN NOT NULL DEFAULT false;


-- -----------------------------------------------------------------------------
-- 3. Matrice des capacites
--
--    Dix-sept colonnes booleennes explicites plutot qu'un JSON. Le detail du
--    raisonnement est dans le commentaire du modele Prisma et dans DECISIONS.md ;
--    en resume : ces booleens decrivent ce que le CODE sait faire, et un blob
--    editable a la main derive de l'implementation reelle — ce qui ramenerait
--    exactement le defaut que la matrice doit supprimer.
--
--    Les valeurs par defaut decrivent le plus petit denominateur commun d'un
--    transporteur algerien en paiement a la livraison : il cree des colis, on
--    peut interroger leur statut, il encaisse a la livraison. Tout le reste
--    doit etre prouve avant d'etre affiche.
-- -----------------------------------------------------------------------------

CREATE TABLE "carrier_capabilities" (
  "carrier_id"             UUID    NOT NULL,

  "create_shipment"        BOOLEAN NOT NULL DEFAULT true,
  "cancel_shipment"        BOOLEAN NOT NULL DEFAULT false,
  "update_shipment"        BOOLEAN NOT NULL DEFAULT false,

  "tracking_polling"       BOOLEAN NOT NULL DEFAULT true,
  "tracking_webhook"       BOOLEAN NOT NULL DEFAULT false,
  "proof_of_delivery"      BOOLEAN NOT NULL DEFAULT false,

  "printable_label"        BOOLEAN NOT NULL DEFAULT false,
  "pickup_manifest"        BOOLEAN NOT NULL DEFAULT false,

  "pickup_point_delivery"  BOOLEAN NOT NULL DEFAULT false,
  "pickup_point_directory" BOOLEAN NOT NULL DEFAULT false,

  "cash_on_delivery"       BOOLEAN NOT NULL DEFAULT true,
  "fee_quotation"          BOOLEAN NOT NULL DEFAULT false,

  "package_opening"        BOOLEAN NOT NULL DEFAULT false,
  "exchange_on_delivery"   BOOLEAN NOT NULL DEFAULT false,
  "secondary_phone"        BOOLEAN NOT NULL DEFAULT false,
  "declared_weight"        BOOLEAN NOT NULL DEFAULT false,
  "wilaya_coverage_query"  BOOLEAN NOT NULL DEFAULT false,

  "updated_at"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "carrier_capabilities_pkey" PRIMARY KEY ("carrier_id")
);

ALTER TABLE "carrier_capabilities"
  ADD CONSTRAINT "carrier_capabilities_carrier_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carriers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Un annuaire de points relais chez un transporteur qui ne livre pas au bureau
-- ne veut rien dire : la seconde capacite presuppose la premiere.
ALTER TABLE "carrier_capabilities"
  ADD CONSTRAINT "carrier_capabilities_directory_requires_pickup_check"
  CHECK ("pickup_point_directory" = false OR "pickup_point_delivery" = true);


-- -----------------------------------------------------------------------------
-- 4. Couverture par wilaya
--
--    Pas de sentinelle « toutes les wilayas » ici, contrairement a la grille
--    tarifaire de la boutique : une couverture s'etablit wilaya par wilaya, et
--    un « partout » global serait une affirmation que le reseau ne tient jamais
--    tout a fait.
-- -----------------------------------------------------------------------------

CREATE TABLE "carrier_wilaya_coverage" (
  "carrier_id"     UUID    NOT NULL,
  "wilaya_code"    INTEGER NOT NULL,
  "home_delivery"  BOOLEAN NOT NULL DEFAULT false,
  "pickup_point"   BOOLEAN NOT NULL DEFAULT false,
  "lead_time_days" INTEGER,
  "updated_at"     TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "carrier_wilaya_coverage_pkey" PRIMARY KEY ("carrier_id", "wilaya_code")
);

CREATE INDEX "carrier_wilaya_coverage_wilaya_code_idx"
  ON "carrier_wilaya_coverage" ("wilaya_code");

ALTER TABLE "carrier_wilaya_coverage"
  ADD CONSTRAINT "carrier_wilaya_coverage_carrier_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carriers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Le decoupage administratif de 2019, sans sentinelle : 1 a 58.
ALTER TABLE "carrier_wilaya_coverage"
  ADD CONSTRAINT "carrier_wilaya_coverage_wilaya_range_check"
  CHECK ("wilaya_code" BETWEEN 1 AND 58);

ALTER TABLE "carrier_wilaya_coverage"
  ADD CONSTRAINT "carrier_wilaya_coverage_lead_time_check"
  CHECK ("lead_time_days" IS NULL OR "lead_time_days" >= 0);

-- Une ligne qui ne couvre RIEN n'apporte aucune information que l'absence de
-- ligne ne dise deja, et brouille la distinction entre « non desservie » et
-- « couverture inconnue ».
ALTER TABLE "carrier_wilaya_coverage"
  ADD CONSTRAINT "carrier_wilaya_coverage_not_empty_check"
  CHECK ("home_delivery" = true OR "pickup_point" = true);
