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
    -e "KEYCLOAK_DISPLAY_NAME=Acme 数字员工平台" -e KEYCLOAK_DISPLAY_LOGO_URL=https://agents.example.cn/brand/logo.png \
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
check "confidential client paperclip exists" "$(KC get "clients/$CID" -r dw --fields publicClient,standardFlowEnabled,directAccessGrantsEnabled --format csv --noquotes)" "false,true,false"
check "client redirect URI points at the Paperclip callback" "$(KC get "clients/$CID" -r dw --fields redirectUris --format csv --noquotes)" "https://agents.example.cn/api/auth/callback/keycloak"
check "client uses the configured secret" "$(KC get "clients/$CID/client-secret" -r dw --fields value --format csv --noquotes)" "test-secret"
check "client enforces PKCE S256" "$(KC get "clients/$CID" -r dw --fields 'attributes(pkce.code.challenge.method)' --format csv --noquotes)" "S256"
check "organization scope is available to the client" \
  "$(KC get "clients/$CID/optional-client-scopes" -r dw --fields name --format csv --noquotes | grep -c '^organization$')" "1"

# specs/002-agent-governance: agent-creator role and the paperclip_roles ID-token claim.
mapper_id() {
  KC get "clients/$CID/protocol-mappers/models" -r dw --fields id,name --format csv --noquotes | while IFS=, read -r id name; do
    if [ "$name" = paperclip-roles ]; then echo "$id"; fi
  done
}
mapper_config() { KC get "clients/$CID/protocol-mappers/models/$(mapper_id)" -r dw --fields "config($1)" --format csv --noquotes; }
check "client role agent-creator exists" "$(KC get "clients/$CID/roles" -r dw --fields name --format csv --noquotes | grep -c '^agent-creator$')" "1"
check "paperclip_roles mapper exists" "$(mapper_id | wc -l | tr -d ' ')" "1"
check "mapper type is client role" "$(KC get "clients/$CID/protocol-mappers/models/$(mapper_id)" -r dw --fields protocolMapper --format csv --noquotes)" "oidc-usermodel-client-role-mapper"
check "mapper claim name" "$(mapper_config claim.name)" "paperclip_roles"
check "mapper reads paperclip client roles" "$(mapper_config usermodel.clientRoleMapping.clientId)" "paperclip"
check "mapper is multivalued" "$(mapper_config multivalued)" "true"
check "mapper adds the claim to the ID token" "$(mapper_config id.token.claim)" "true"
check "mapper keeps the claim out of the access token" "$(mapper_config access.token.claim)" "false"

# Sign-in page branding: realm display name (tab title) and header HTML with the logo.
check "realm display name is the brand" "$(KC get realms/dw --fields displayName --format csv --noquotes)" "Acme 数字员工平台"
check "realm header shows only the logo" "$(KC get realms/dw --fields displayNameHtml --format csv --noquotes)" \
  '<img src="https://agents.example.cn/brand/logo.png" alt="Acme 数字员工平台" style="height:64px">'

# Manual changes between deploys.
ORG=$(KC get organizations -r dw --fields id --format csv --noquotes)
KC create users -r dw -s username=manual-user -s email=manual@example.cn -s enabled=true >/dev/null
UID_MANUAL=$(KC get users -r dw -q username=manual-user --fields id --format csv --noquotes)
KC create "organizations/$ORG/members" -r dw -b "\"$UID_MANUAL\"" >/dev/null
KC update realms/dw -s registrationAllowed=true >/dev/null
KC update "clients/$CID" -r dw -s 'redirectUris=["https://evil.example/cb"]' >/dev/null
KC update realms/dw -s rememberMe=true >/dev/null
KC update realms/dw -s displayName="Changed by hand" >/dev/null
KC add-roles -r dw --uusername manual-user --cclientid paperclip --rolename agent-creator >/dev/null
KC update "clients/$CID/protocol-mappers/models/$(mapper_id)" -r dw -s 'config."id.token.claim"=false' >/dev/null

provision >/tmp/kc-provision-2.log 2>&1
check "second provisioning succeeds" "$?" "0"
login
check "still exactly one organization" "$(KC get organizations -r dw --fields id --format csv --noquotes | wc -l | tr -d ' ')" "1"
check "still exactly one paperclip client" "$(KC get clients -r dw -q clientId=paperclip --fields id --format csv --noquotes | wc -l | tr -d ' ')" "1"
check "manually created user is kept" "$(KC get users -r dw -q username=manual-user --fields username --format csv --noquotes)" "manual-user"
check "manual organization membership is kept" "$(KC get "organizations/$ORG/members" -r dw --fields username --format csv --noquotes)" "manual-user"
check "owned field registrationAllowed is restored" "$(KC get realms/dw --fields registrationAllowed --format csv --noquotes)" "false"
check "owned field redirectUris is restored" "$(KC get "clients/$CID" -r dw --fields redirectUris --format csv --noquotes)" "https://agents.example.cn/api/auth/callback/keycloak"
check "still exactly one agent-creator role" "$(KC get "clients/$CID/roles" -r dw --fields name --format csv --noquotes | grep -c '^agent-creator$')" "1"
check "still exactly one paperclip_roles mapper" "$(mapper_id | wc -l | tr -d ' ')" "1"
check "assigned agent-creator role is kept" "$(KC get-roles -r dw --uusername manual-user --cclientid paperclip --fields name --format csv --noquotes)" "agent-creator"
check "owned mapper setting id.token.claim is restored" "$(mapper_config id.token.claim)" "true"
check "unmanaged realm setting is left alone" "$(KC get realms/dw --fields rememberMe --format csv --noquotes)" "true"
check "owned field displayName is restored" "$(KC get realms/dw --fields displayName --format csv --noquotes)" "Acme 数字员工平台"

# specs/003-first-run-setup: first-run.sh hands passwords to kcadm on stdin only.
KC create users -r master -s username=stdin-admin -s enabled=true >/dev/null
SID=$(KC get users -r master -q username=stdin-admin -q exact=true --fields id --format csv --noquotes)
printf '{"type":"password","value":"Stdin#Password2026","temporary":false}' \
  | docker exec -i "$NAME" /opt/keycloak/bin/kcadm.sh update "users/$SID/reset-password" -r master -f -
# shellcheck disable=SC2016
check "kcadm sets a password read from stdin and logs in with a password read from stdin" \
  "$(printf 'Stdin#Password2026\n' | docker exec -i "$NAME" bash -c \
    'IFS= read -r password && /opt/keycloak/bin/kcadm.sh config credentials --config "$1" --server http://localhost:8080 --realm master --user stdin-admin --password "$password" >/dev/null && echo ok' \
    kcadm /tmp/stdin-test.config)" "ok"

exit "$FAILED"
