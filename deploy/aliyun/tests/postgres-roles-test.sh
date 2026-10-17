#!/usr/bin/env bash
# Integration test for deploy/aliyun/postgres/ensure-roles.sh against a real
# PostgreSQL (specs/006-litellm-gateway-billing): runs it twice on a database
# that already has the paperclip schema, and checks the gateway roles.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../postgres/ensure-roles.sh"
IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
NAME=pg-roles-test
FAILED=0

check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected '$3', got '$2')"; FAILED=1; fi
}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=pg -e LITELLM_DB_PASSWORD=litellm-pw \
  -e PAPERCLIP_READONLY_DB_PASSWORD=readonly-pw -v "$SCRIPT:/ensure-roles.sh:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2

PSQL() { docker exec -i "$NAME" psql -U postgres -tA "$@"; }
# An existing deployment: the paperclip database and owner with a table.
PSQL -c "CREATE ROLE paperclip LOGIN PASSWORD 'p'" >/dev/null
PSQL -c "CREATE DATABASE paperclip OWNER paperclip" >/dev/null
docker exec "$NAME" psql -U paperclip -d paperclip -c "CREATE TABLE agents (id int)" >/dev/null

first="$(docker exec "$NAME" bash /ensure-roles.sh 2>&1)"; check "first run succeeds" "$?" "0"
second="$(docker exec "$NAME" bash /ensure-roles.sh 2>&1)"; check "second run succeeds (idempotent)" "$?" "0"
check "no secrets in output" "$(printf '%s%s' "$first" "$second" | grep -c 'litellm-pw\|readonly-pw')" "0"

check "litellm database owned by litellm" "$(PSQL -c "select pg_get_userbyid(datdba) from pg_database where datname='litellm'")" "litellm"
check "litellm can log in with its password" \
  "$(docker exec -e PGPASSWORD=litellm-pw "$NAME" psql -h 127.0.0.1 -U litellm -d litellm -tA -c 'select 1' 2>&1)" "1"
check "readonly role reads existing tables" \
  "$(docker exec -e PGPASSWORD=readonly-pw "$NAME" psql -h 127.0.0.1 -U paperclip_readonly -d paperclip -tA -c 'select count(*) from agents' 2>&1)" "0"
# Tables created later by Paperclip migrations are readable too.
docker exec "$NAME" psql -U paperclip -d paperclip -c "CREATE TABLE heartbeat_runs (id int)" >/dev/null
check "readonly role reads tables created later" \
  "$(docker exec -e PGPASSWORD=readonly-pw "$NAME" psql -h 127.0.0.1 -U paperclip_readonly -d paperclip -tA -c 'select count(*) from heartbeat_runs' 2>&1)" "0"
check "readonly role cannot write" \
  "$(docker exec -e PGPASSWORD=readonly-pw "$NAME" psql -h 127.0.0.1 -U paperclip_readonly -d paperclip -tA -c 'insert into agents values (1)' 2>&1 | grep -c 'permission denied')" "1"

if [ "$FAILED" = 0 ]; then echo "postgres roles test passed"; else echo "postgres roles test FAILED"; exit 1; fi
