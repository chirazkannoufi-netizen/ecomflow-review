-- Extensions creees des l'initialisation du conteneur PostgreSQL de
-- developpement, afin que la migration `20260828235900_extensions` trouve
-- deja le terrain pret meme si le compte applicatif n'est pas superutilisateur.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Base dediee aux tests d'integration : isolee de la base de developpement
-- pour qu'un `TRUNCATE` de test n'efface jamais les donnees de travail.
SELECT 'CREATE DATABASE ecomflow_test OWNER ecomflow'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ecomflow_test')\gexec
