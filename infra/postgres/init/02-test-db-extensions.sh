#!/bin/bash
# Active les memes extensions dans la base de test.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "ecomflow_test" <<-SQL
  CREATE EXTENSION IF NOT EXISTS "pg_trgm";
SQL
