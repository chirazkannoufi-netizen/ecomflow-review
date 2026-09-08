-- =============================================================================
-- EcomFlow — Extensions PostgreSQL requises
--
-- Cette migration est isolee et executee EN PREMIER car elle peut necessiter
-- des droits superutilisateur selon l'hebergeur. Si le compte applicatif ne
-- dispose pas de ces droits, un DBA doit executer ce fichier une seule fois,
-- puis marquer la migration comme appliquee :
--   prisma migrate resolve --applied 20260828235900_extensions
--
-- pg_trgm : recherche floue par trigrammes sur les noms de clients et de
--           produits (recherche globale, V2 §22). Sans elle, la recherche
--           « contient » degenere en Seq Scan des le premier millier de lignes.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pg_trgm";
