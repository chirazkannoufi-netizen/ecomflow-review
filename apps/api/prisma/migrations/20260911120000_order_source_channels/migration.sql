-- =============================================================================
-- Provenance des commandes : nommer les canaux au lieu de les agreger
--
-- LE PROBLEME
--   `OrderSource` distinguait le MOYEN d'entree (saisie, feuille, API) mais
--   pas le CANAL. Shopify, WooCommerce, Youcan et Lightfunnels tombaient tous
--   dans `WEBSITE` ; Facebook et TikTok dans `SOCIAL`.
--
--   Un commercant qui tient deux boutiques en ligne et deux comptes
--   publicitaires ne demande pas « combien de commandes viennent du web ? »
--   mais « laquelle des deux convertit ? ». La question etait sans reponse,
--   alors que l'attribution par canal est le chiffre le plus regarde du
--   commerce en paiement a la livraison.
--
--   Et le panier abandonne n'avait AUCUN equivalent : ni valeur, ni
--   approximation. Or ce n'est pas une plateforme, c'est une NATURE de
--   commande — un panier non finalise, relance par la boutique. Elle change le
--   script d'appel (on ne parle pas a quelqu'un qui a commande comme a
--   quelqu'un qui a renonce) et ouvre un taux de recuperation qu'aucune autre
--   valeur ne permettait de calculer.
--
-- CE QUE FAIT CETTE MIGRATION
--   Sept valeurs ajoutees. Aucune commande existante n'est retouchee : une
--   commande deja enregistree en `WEBSITE` le reste, parce que rien ne permet
--   de deviner APRES COUP de quelle boutique elle venait. Reecrire l'historique
--   sur une supposition produirait des statistiques d'attribution fausses et
--   credibles, ce qui est pire que leur absence.
--
--   Les valeurs generiques SURVIVENT : `WEBSITE`, `SOCIAL`, `API` et
--   `CSV_IMPORT` couvrent ce qui n'est pas nomme. Les retirer obligerait a
--   inventer une plateforme pour chaque provenance inconnue, et casserait les
--   lignes deja ecrites.
--
-- NOTE SUR POSTGRESQL
--   `ALTER TYPE ... ADD VALUE` ne peut pas s'executer dans un bloc
--   transactionnel sur les versions anciennes. Prisma applique chaque
--   migration dans une transaction ; `IF NOT EXISTS` rend l'instruction
--   rejouable, et PostgreSQL 12+ (la cible du projet) accepte l'ajout en
--   transaction tant que la valeur n'est pas utilisee dans la meme transaction
--   — ce qui est le cas ici : on ajoute, on n'ecrit pas.
-- =============================================================================

ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'ABANDONED_CART';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'SHOPIFY';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'WOOCOMMERCE';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'YOUCAN';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'LIGHTFUNNELS';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'FACEBOOK';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'TIKTOK';
