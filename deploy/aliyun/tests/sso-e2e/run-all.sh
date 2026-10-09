#!/usr/bin/env bash
# One-shot SSO end-to-end run against a real Keycloak. Creates and removes its
# own containers and an isolated Paperclip home. Exit code is non-zero on any
# failed check. Keep containers with KEEP=1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.8.0}"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/paperclip-sso-e2e.XXXXXX")}"
SERVER_PID=""

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  local leftover
  leftover="$(lsof -nP -iTCP:3199 -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$leftover" ]; then echo "$leftover" | xargs kill 2>/dev/null || true; fi
  SERVER_PID=""
}

cleanup() {
  stop_server
  if [ "${KEEP:-0}" != "1" ]; then
    docker rm -f pc-sso-e2e-postgres pc-sso-e2e-keycloak >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

start_server() {
  stop_server
  "$HERE/start-paperclip.sh" "$@" &
  SERVER_PID=$!
  curl -s -o /dev/null --retry 120 --retry-connrefused --retry-delay 2 --retry-all-errors \
    http://localhost:3199/api/health
}

docker rm -f pc-sso-e2e-postgres pc-sso-e2e-keycloak >/dev/null 2>&1 || true
docker run -d --name pc-sso-e2e-postgres -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=paperclip \
  -p 127.0.0.1:55432:5432 postgres:17-alpine >/dev/null
docker run -d --name pc-sso-e2e-keycloak -p 127.0.0.1:18080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  "$KEYCLOAK_IMAGE" start-dev >/dev/null
"$HERE/keycloak-setup.sh"

echo "== phase 1: no organization map"
start_server
SETUP_OUT="$(node "$HERE/e2e.mjs" setup)"
echo "$SETUP_OUT"
COMPANY_ID="$(echo "$SETUP_OUT" | sed -n 's/^COMPANY_ID=//p')"
MAP="{\"acme\":\"$COMPANY_ID\"}"

echo "== phase 2: organization map configured"
start_server "$MAP"
node "$HERE/e2e.mjs" verify "$COMPANY_ID"

echo "== phase 3: email sign-up disabled"
PAPERCLIP_AUTH_DISABLE_SIGN_UP=true start_server "$MAP"
node "$HERE/e2e.mjs" signup-disabled
