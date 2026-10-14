#!/usr/bin/env bash
# Provisions the local e2e Keycloak (container pc-sso-e2e-keycloak):
# realm dw, organization acme, confidential client paperclip, users A/B (in acme) and C (not).
set -euo pipefail

KC_CONTAINER="${KC_CONTAINER:-pc-sso-e2e-keycloak}"
KC="docker exec $KC_CONTAINER /opt/keycloak/bin/kcadm.sh"
APP_URL="${APP_URL:-http://localhost:3199}"
KC_REALM="${KC_REALM:-dw}"
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-admin}"
CLIENT_SECRET="${CLIENT_SECRET:-e2e-client-secret}"

for _ in $(seq 1 90); do
  if $KC config credentials --server http://localhost:8080 --realm master --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
$KC config credentials --server http://localhost:8080 --realm master --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD" >/dev/null

if ! $KC get "realms/$KC_REALM" >/dev/null 2>&1; then
  $KC create realms -s realm="$KC_REALM" -s enabled=true -s organizationsEnabled=true \
    -s registrationAllowed=false -s verifyEmail=false -s duplicateEmailsAllowed=false >/dev/null
fi

if [ -z "$($KC get clients -r "$KC_REALM" -q clientId=paperclip --fields id --format csv --noquotes)" ]; then
  $KC create clients -r "$KC_REALM" \
    -s clientId=paperclip -s enabled=true -s protocol=openid-connect \
    -s publicClient=false -s secret="$CLIENT_SECRET" \
    -s standardFlowEnabled=true -s directAccessGrantsEnabled=false \
    -s "redirectUris=[\"$APP_URL/api/auth/callback/keycloak\"]" \
    -s "webOrigins=[\"$APP_URL\"]" \
    -s 'attributes={"pkce.code.challenge.method":"S256"}' >/dev/null
fi
CLIENT_ID=$($KC get clients -r "$KC_REALM" -q clientId=paperclip --fields id --format csv --noquotes)
# The built-in "organization" scope is an optional client scope; Paperclip requests it explicitly.

if [ -z "$($KC get organizations -r "$KC_REALM" --fields id --format csv --noquotes 2>/dev/null)" ]; then
  $KC create organizations -r "$KC_REALM" -s name=Acme -s alias=acme -s enabled=true \
    -s 'domains=[{"name":"example.cn"}]' >/dev/null
fi
ORG_ID=$($KC get organizations -r "$KC_REALM" --fields id,alias --format csv --noquotes | awk -F, '$2=="acme"{print $1}')

create_user() {
  local username="$1" email="$2" first="$3" verified="${4:-true}"
  if [ -z "$($KC get users -r "$KC_REALM" -q username="$username" --fields id --format csv --noquotes)" ]; then
    $KC create users -r "$KC_REALM" -s username="$username" -s email="$email" -s emailVerified="$verified" \
      -s firstName="$first" -s lastName=Tester -s enabled=true >/dev/null
    $KC set-password -r "$KC_REALM" --username "$username" --new-password "Passw0rd!" >/dev/null
  fi
  $KC get users -r "$KC_REALM" -q username="$username" --fields id --format csv --noquotes
}

USER_A=$(create_user user-a a@example.cn Alice)
USER_B=$(create_user user-b b@example.cn Bob)
create_user user-c c@outside.cn Carol >/dev/null
# Same email as the break-glass admin (verified) and as a local-only account (unverified).
USER_ADMIN=$(create_user ops-admin admin@example.cn Ops true)
USER_LOCAL=$(create_user local-user local@example.cn Lou false)
USER_D=$(create_user user-d d@example.cn Dana true)

for member in "$USER_A" "$USER_B" "$USER_ADMIN" "$USER_LOCAL" "$USER_D"; do
  $KC create "organizations/$ORG_ID/members" -r "$KC_REALM" -b "\"$member\"" >/dev/null 2>&1 || true
done

# Agent governance (specs/002-agent-governance): agent-creator role, the
# paperclip_roles ID-token claim (same mapper as keycloak/provision.sh) and
# the role for user A only.
if ! $KC get "clients/$CLIENT_ID/roles/agent-creator" -r "$KC_REALM" >/dev/null 2>&1; then
  $KC create "clients/$CLIENT_ID/roles" -r "$KC_REALM" -s name=agent-creator >/dev/null
fi
if [ -z "$($KC get "clients/$CLIENT_ID/protocol-mappers/models" -r "$KC_REALM" --fields name --format csv --noquotes | grep '^paperclip-roles$' || true)" ]; then
  $KC create "clients/$CLIENT_ID/protocol-mappers/models" -r "$KC_REALM" \
    -s name=paperclip-roles -s protocol=openid-connect -s protocolMapper=oidc-usermodel-client-role-mapper \
    -s 'config."claim.name"=paperclip_roles' -s 'config."jsonType.label"=String' -s 'config.multivalued=true' \
    -s 'config."usermodel.clientRoleMapping.clientId"=paperclip' \
    -s 'config."id.token.claim"=true' -s 'config."access.token.claim"=false' -s 'config."userinfo.token.claim"=false' >/dev/null
fi
$KC add-roles -r "$KC_REALM" --uusername user-a --cclientid paperclip --rolename agent-creator >/dev/null

echo "client=$CLIENT_ID org=$ORG_ID userA=$USER_A userB=$USER_B"
