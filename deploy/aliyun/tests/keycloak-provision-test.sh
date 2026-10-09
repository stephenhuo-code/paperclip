#!/usr/bin/env bash
# Integration test for deploy/aliyun/keycloak/provision.sh against a real Keycloak.
# Runs provisioning twice with manual changes in between and checks FR-025:
# no duplicates, owned fields restored, users and memberships kept.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROVISION="$HERE/../keycloak/provision.sh"
KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.8.0}"
NET=kc-provision-test
NAME=kc-provision-test
FAILED=0

check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected '$3', got '$2')"; FAILED=1; fi
}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin "$KEYCLOAK_IMAGE" start-dev >/dev/null

provision() {
  docker run --rm --network "$NET" --entrypoint /bin/bash \
    -e KEYCLOAK_URL="http://$NAME:8080" -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    -e KEYCLOAK_REALM=dw -e KEYCLOAK_ORG_NAME=Acme -e KEYCLOAK_ORG_ALIAS=acme -e KEYCLOAK_ORG_DOMAIN=example.cn \
    -e APP_DOMAIN=agents.example.cn -e PAPERCLIP_AUTH_OIDC_CLIENT_SECRET=test-secret \
    -v "$PROVISION:/provision.sh:ro" "$KEYCLOAK_IMAGE" /provision.sh
}

KC() { docker exec "$NAME" /opt/keycloak/bin/kcadm.sh "$@"; }
login() {
  for _ in $(seq 1 90); do
    KC config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

login || { echo "FAIL  Keycloak did not start"; exit 1; }

provision >/tmp/kc-provision-1.log 2>&1
check "first provisioning succeeds" "$?" "0"
check "provisioning output contains no client secret" "$(grep -c test-secret /tmp/kc-provision-1.log)" "0"

login
check "realm has organizations enabled and self-registration off" \
  "$(KC get realms/dw --fields organizationsEnabled,registrationAllowed,verifyEmail,duplicateEmailsAllowed --format csv --noquotes)" \
  "true,false,true,false"
check "organization acme exists" "$(KC get organizations -r dw --fields alias --format csv --noquotes)" "acme"
CID=$(KC get clients -r dw -q clientId=paperclip --fields id --format csv --noquotes)
check "confidential client paperclip exists" "$(KC get clients/$CID -r dw --fields publicClient,standardFlowEnabled,directAccessGrantsEnabled --format csv --noquotes)" "false,true,false"
check "client redirect URI points at the Paperclip callback" "$(KC get clients/$CID -r dw --fields redirectUris --format csv --noquotes)" "https://agents.example.cn/api/auth/callback/keycloak"
check "client uses the configured secret" "$(KC get clients/$CID/client-secret -r dw --fields value --format csv --noquotes)" "test-secret"
check "client enforces PKCE S256" "$(KC get clients/$CID -r dw --fields 'attributes(pkce.code.challenge.method)' --format csv --noquotes)" "S256"
check "organization scope is available to the client" \
  "$(KC get clients/$CID/optional-client-scopes -r dw --fields name --format csv --noquotes | grep -c '^organization$')" "1"

# Manual changes between deploys.
ORG=$(KC get organizations -r dw --fields id --format csv --noquotes)
KC create users -r dw -s username=manual-user -s email=manual@example.cn -s enabled=true >/dev/null
UID_MANUAL=$(KC get users -r dw -q username=manual-user --fields id --format csv --noquotes)
KC create "organizations/$ORG/members" -r dw -b "\"$UID_MANUAL\"" >/dev/null
KC update realms/dw -s registrationAllowed=true >/dev/null
KC update "clients/$CID" -r dw -s 'redirectUris=["https://evil.example/cb"]' >/dev/null
KC update realms/dw -s displayName="Acme Workforce" >/dev/null

provision >/tmp/kc-provision-2.log 2>&1
check "second provisioning succeeds" "$?" "0"
login
check "still exactly one organization" "$(KC get organizations -r dw --fields id --format csv --noquotes | wc -l | tr -d ' ')" "1"
check "still exactly one paperclip client" "$(KC get clients -r dw -q clientId=paperclip --fields id --format csv --noquotes | wc -l | tr -d ' ')" "1"
check "manually created user is kept" "$(KC get users -r dw -q username=manual-user --fields username --format csv --noquotes)" "manual-user"
check "manual organization membership is kept" "$(KC get organizations/$ORG/members -r dw --fields username --format csv --noquotes)" "manual-user"
check "owned field registrationAllowed is restored" "$(KC get realms/dw --fields registrationAllowed --format csv --noquotes)" "false"
check "owned field redirectUris is restored" "$(KC get clients/$CID -r dw --fields redirectUris --format csv --noquotes)" "https://agents.example.cn/api/auth/callback/keycloak"
check "unmanaged realm setting is left alone" "$(KC get realms/dw --fields displayName --format csv --noquotes)" "Acme Workforce"

exit "$FAILED"
