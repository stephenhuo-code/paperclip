#!/usr/bin/env bash
# Local full-stack smoke test (tasks.md T043): the real docker-compose.yml,
# deploy.sh, keycloak/provision.sh and Caddy (internal TLS) on this machine,
# then the SSO end-to-end checks through https.
#
# Usage: stack-smoke.sh <paperclip-image-tag>
#   The image must exist locally as local/dw/paperclip:<tag>, built with
#   PAPERCLIP_BUILD_COMMIT=<tag> (the health check compares the commit).
# Needs ports 80 and 443 free. KEEP=1 leaves the stack running.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: stack-smoke.sh <paperclip-image-tag>" >&2; exit 1; }
TAG="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_SRC="$(cd "$HERE/../.." && pwd)"
E2E="$HERE/../sso-e2e"
ENV_NAME=local
APP_DOMAIN="$(sed -n 's/^APP_DOMAIN=//p' "$HERE/local.env")"
SSO_DOMAIN="$(sed -n 's/^SSO_DOMAIN=//p' "$HERE/local.env")"
FAILED=0

check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected '$3', got '$2')"; FAILED=1; fi
}

docker image inspect "local/dw/paperclip:$TAG" >/dev/null 2>&1 \
  || { echo "image local/dw/paperclip:$TAG not found; build it first" >&2; exit 1; }

# Base images under the names the compose file expects.
for pair in "quay.io/keycloak/keycloak:26.8.0=keycloak:26.8.0" \
  "postgres:17-alpine=postgres:17-alpine" "caddy:2.10-alpine=caddy:2.10-alpine"; do
  source_image="${pair%%=*}"
  docker image inspect "$source_image" >/dev/null 2>&1 || docker pull --quiet "$source_image" >/dev/null
  docker tag "$source_image" "local/dw/${pair#*=}"
done

export PAPERCLIP_ROOT
PAPERCLIP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-stack-smoke.XXXXXX")"
mkdir -p "$PAPERCLIP_ROOT/deploy"
(cd "$DEPLOY_SRC" && tar cf - --exclude ./tests .) | (cd "$PAPERCLIP_ROOT/deploy" && tar xf -)
cp "$HERE/local.env" "$PAPERCLIP_ROOT/deploy/environments/local.env"
CA_FILE="$PAPERCLIP_ROOT/caddy-root.crt"
SCRIPTS="$PAPERCLIP_ROOT/deploy/scripts"
compose() {
  docker compose --project-directory "$PAPERCLIP_ROOT/deploy" -f "$PAPERCLIP_ROOT/deploy/docker-compose.yml" \
    --env-file "$PAPERCLIP_ROOT/deploy/environments/local.env" --env-file "$PAPERCLIP_ROOT/.env" "$@"
}

COPIER_PID=""
# shellcheck disable=SC2329  # invoked through the EXIT trap
cleanup() {
  [ -n "$COPIER_PID" ] && kill "$COPIER_PID" 2>/dev/null || true
  if [ "${KEEP:-0}" != "1" ]; then
    PAPERCLIP_IMAGE_TAG="$TAG" compose --profile provision down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$PAPERCLIP_ROOT"
  else
    echo "stack kept; PAPERCLIP_ROOT=$PAPERCLIP_ROOT"
  fi
}
trap cleanup EXIT

# Caddy creates its internal CA on first start; copy the root out for curl and Node.
copy_ca_when_ready() {
  while [ ! -s "$CA_FILE" ]; do
    PAPERCLIP_IMAGE_TAG="$TAG" compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$CA_FILE" >/dev/null 2>&1 || true
    sleep 2
  done
}

echo "== bootstrap secrets"
BOOTSTRAP_STEPS=secrets "$SCRIPTS/bootstrap.sh" "$ENV_NAME"

echo "== first deploy"
copy_ca_when_ready &
COPIER_PID=$!
set +e
DEPLOY_SKIP_PULL=1 DEPLOY_HEALTH_CA_FILE="$CA_FILE" "$SCRIPTS/deploy.sh" "$ENV_NAME" "$TAG"
first_deploy=$?
set -e
check "first deploy succeeds" "$first_deploy" "0"
wait "$COPIER_PID" 2>/dev/null || true
COPIER_PID=""
# Give Paperclip only the public root certificate (readable by the node user),
# then restart so Node trusts it for OIDC discovery.
PAPERCLIP_IMAGE_TAG="$TAG" compose cp "$CA_FILE" paperclip:/paperclip/caddy-root.crt >/dev/null
PAPERCLIP_IMAGE_TAG="$TAG" compose exec -T paperclip chmod 644 /paperclip/caddy-root.crt
PAPERCLIP_IMAGE_TAG="$TAG" compose restart paperclip >/dev/null
curl -s -o /dev/null --cacert "$CA_FILE" --retry 60 --retry-connrefused --retry-all-errors --retry-delay 2 \
  "https://$APP_DOMAIN/api/health"

echo "== edge checks"
check "Paperclip is served over https with OIDC enabled" \
  "$(curl -s --cacert "$CA_FILE" "https://$APP_DOMAIN/api/health" | grep -o '"oidc":{"enabled":true' || true)" '"oidc":{"enabled":true'
check "Keycloak realm discovery is public" \
  "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA_FILE" "https://$SSO_DOMAIN/realms/digital-workforce/.well-known/openid-configuration")" "200"
check "Keycloak admin console is refused outside ADMIN_ALLOWED_CIDRS" \
  "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA_FILE" "https://$SSO_DOMAIN/admin/master/console/")" "403"
check "Keycloak management port is not published" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:9000/health/ready" || true)" "000"

echo "== Keycloak test users"
KC_ADMIN_PASSWORD="$(sed -n 's/^KC_BOOTSTRAP_ADMIN_PASSWORD=//p' "$PAPERCLIP_ROOT/.env")"
KC_CONTAINER=paperclip-keycloak-1 KC_REALM=digital-workforce KC_ADMIN_USER=provisioner \
  KC_ADMIN_PASSWORD="$KC_ADMIN_PASSWORD" APP_URL="https://$APP_DOMAIN" "$E2E/keycloak-setup.sh" >/dev/null

echo "== bootstrap invite (public exposure: no browser claim)"
INVITE_URL="$(PAPERCLIP_ROOT="$PAPERCLIP_ROOT" "$SCRIPTS/bootstrap-invite.sh" "$ENV_NAME" || true)"
check "bootstrap-ceo prints a one-time invite URL" "$([ -n "$INVITE_URL" ] && echo yes || echo no)" "yes"
[ -n "$INVITE_URL" ] || exit 1

export NODE_EXTRA_CA_CERTS="$CA_FILE"
export E2E_APP_URL="https://$APP_DOMAIN" E2E_PG_CONTAINER=paperclip-postgres-1
export E2E_KC_CONTAINER=paperclip-keycloak-1 E2E_KC_REALM=digital-workforce

echo "== e2e setup (no organization map)"
setup_output="$(E2E_BOOTSTRAP_INVITE_URL="$INVITE_URL" node "$E2E/e2e.mjs" setup)" || FAILED=1
echo "$setup_output"
COMPANY_ID="$(sed -n 's/^COMPANY_ID=//p' <<<"$setup_output")"
[ -n "$COMPANY_ID" ] || { echo "no company id" >&2; exit 1; }

echo "== redeploy with the organization map (same version)"
map="{\"acme\":\"$COMPANY_ID\"}"
grep -v '^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=' "$PAPERCLIP_ROOT/.env" > "$PAPERCLIP_ROOT/.env.next"
printf 'PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=%s\n' "$map" >> "$PAPERCLIP_ROOT/.env.next"
mv "$PAPERCLIP_ROOT/.env.next" "$PAPERCLIP_ROOT/.env"
chmod 600 "$PAPERCLIP_ROOT/.env"
set +e
DEPLOY_SKIP_PULL=1 DEPLOY_HEALTH_CA_FILE="$CA_FILE" "$SCRIPTS/deploy.sh" "$ENV_NAME" "$TAG"
second_deploy=$?
set -e
check "redeploy succeeds" "$second_deploy" "0"

echo "== e2e verify"
node "$E2E/e2e.mjs" verify "$COMPANY_ID" || FAILED=1

echo "== restart keeps permissions revoked by SSO (specs/002-agent-governance)"
PAPERCLIP_IMAGE_TAG="$TAG" compose restart paperclip >/dev/null
curl -sf -o /dev/null --cacert "$CA_FILE" --retry 60 --retry-connrefused --retry-all-errors --retry-delay 2 \
  "https://$APP_DOMAIN/api/health"
node "$E2E/e2e.mjs" after-restart || FAILED=1

echo "== failed rollout rolls back"
set +e
DEPLOY_SKIP_PULL=1 DEPLOY_HEALTH_CA_FILE="$CA_FILE" DEPLOY_HEALTH_TIMEOUT_SECONDS=60 \
  "$SCRIPTS/deploy.sh" "$ENV_NAME" 0000000000000000000000000000000000000000
bad_deploy=$?
set -e
check "deploying a missing image exits 2 (rolled back)" "$bad_deploy" "2"
check "the recorded version is unchanged" "$(cat "$PAPERCLIP_ROOT/state/current")" "$TAG"
curl -s -o /dev/null --cacert "$CA_FILE" --retry 60 --retry-connrefused --retry-all-errors --retry-delay 2 \
  "https://$APP_DOMAIN/api/health"
check "the previous version still serves traffic" \
  "$(curl -s --cacert "$CA_FILE" "https://$APP_DOMAIN/api/health" | grep -o "\"commit\":\"$TAG\"" || true)" "\"commit\":\"$TAG\""

echo
if [ "$FAILED" = "0" ]; then echo "stack smoke passed"; else echo "stack smoke FAILED"; fi
exit "$FAILED"
