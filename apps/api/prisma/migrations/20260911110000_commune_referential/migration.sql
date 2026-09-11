-- =============================================================================
-- Referentiel des communes algeriennes
--
-- CE QUI EXISTAIT, ET CE QUI MANQUAIT
--   Les 58 wilayas sont embarquees dans `@ecomflow/shared` depuis l'origine, et
--   font autorite (D-018) : elles resolvent « Algiers », « BBA » ou « Bejaia »
--   en un code, a chaque ligne d'import. Les COMMUNES, elles, n'existaient
--   nulle part — ni table, ni liste, ni validation. Le champ `commune` des
--   commandes est un texte libre, saisi ou importe tel quel.
--
--   La consequence se voit au formulaire : pour choisir une commune, il faut
--   la connaitre et l'ecrire, sans aide et sans garde-fou sur l'orthographe.
--
-- CE QUE CETTE TABLE N'EST PAS
--   Elle n'est PAS un validateur. D-018 refuse de rejeter une commande parce
--   que sa commune ne figure pas dans une liste : les transliterations varient
--   trop d'un transporteur a l'autre pour qu'une absence signifie une erreur.
--   Ce referentiel ASSISTE la saisie — il remplit une liste deroulante filtree
--   par wilaya — et sert au rapprochement d'un libelle approximatif. Les
--   imports continuent d'accepter une commune inconnue.
--
--   C'est la raison pour laquelle aucune cle etrangere ne relie `orders` a
--   cette table, et pourquoi `orders.commune_snapshot` reste du texte.
--
-- POURQUOI EN BASE PLUTOT QU'EN CODE, CONTRAIREMENT AUX WILAYAS
--   Les wilayas sont lues a chaque ligne d'import : le travail doit etre
--   synchrone et local. Les communes servent a choisir dans une liste. Or le
--   paquet partage est compile en CommonJS, donc mal elague par le bundler :
--   1541 entrees s'y retrouveraient dans le bundle de CHAQUE page, y compris
--   celles sans champ adresse.
--
-- ALIMENTATION
--   Par le seed (`prisma/data/communes.ts`), genere depuis le classeur de
--   reference du metier. Le rattachement a ete verifie contre `WILAYAS` : les
--   58 libelles correspondent exactement, au meme rang, et aucune des 1541
--   communes ne pointe vers une wilaya inconnue.
-- =============================================================================

CREATE TABLE "communes" (
  "id"          UUID    NOT NULL,
  "wilaya_code" INTEGER NOT NULL,
  "name"        TEXT    NOT NULL,
  "search_name" TEXT    NOT NULL,
  "is_active"   BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "communes_pkey" PRIMARY KEY ("id")
);

-- Le meme libelle normalise ne peut pas exister deux fois DANS une wilaya.
-- Le meme nom dans deux wilayas differentes, en revanche, est frequent et
-- parfaitement legitime : la contrainte porte donc sur le couple.
CREATE UNIQUE INDEX "communes_wilaya_code_search_name_key"
  ON "communes" ("wilaya_code", "search_name");

CREATE INDEX "communes_wilaya_code_name_idx"
  ON "communes" ("wilaya_code", "name");

-- Meme borne que partout ailleurs dans le schema : le decoupage de 2019.
-- Pas de sentinelle « toutes » ici : une commune appartient a une wilaya.
ALTER TABLE "communes"
  ADD CONSTRAINT "communes_wilaya_range_check"
  CHECK ("wilaya_code" BETWEEN 1 AND 58);
