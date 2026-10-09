#!/usr/bin/env bash
# First-start initialization (docker-entrypoint-initdb.d): one database and one
# login role per application. Runs only when the data directory is empty.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v paperclip_password="$PAPERCLIP_DB_PASSWORD" \
  -v keycloak_password="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE paperclip LOGIN PASSWORD :'paperclip_password';
CREATE DATABASE paperclip OWNER paperclip;
CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_password';
CREATE DATABASE keycloak OWNER keycloak;
SQL
