#!/usr/bin/env bash
# Model gateway roles (specs/006-litellm-gateway-billing). Idempotent: runs as
# an init script on a new data directory, and from deploy.sh on every deploy
# so existing servers get the roles too. Existing roles keep their passwords.
#   litellm             owns the litellm database (LiteLLM's models and spend)
#   paperclip_readonly  reads Paperclip's tables (gateway-sync maps runs)
set -euo pipefail

: "${LITELLM_DB_PASSWORD:?}" "${PAPERCLIP_READONLY_DB_PASSWORD:?}"
psql_admin() { psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" "$@"; }

psql_admin --dbname postgres -v litellm_password="$LITELLM_DB_PASSWORD" \
  -v readonly_password="$PAPERCLIP_READONLY_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE litellm LOGIN PASSWORD %L', :'litellm_password')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm') \gexec
SELECT 'CREATE DATABASE litellm OWNER litellm'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm') \gexec
SELECT format('CREATE ROLE paperclip_readonly LOGIN PASSWORD %L', :'readonly_password')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'paperclip_readonly') \gexec
SQL

# Read access to Paperclip, including tables its migrations create later.
if psql_admin --dbname postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'paperclip'" | grep -q 1; then
  psql_admin --dbname paperclip <<'SQL'
GRANT CONNECT ON DATABASE paperclip TO paperclip_readonly;
GRANT USAGE ON SCHEMA public TO paperclip_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO paperclip_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE paperclip IN SCHEMA public GRANT SELECT ON TABLES TO paperclip_readonly;
SQL
fi
echo "gateway database roles ready"
