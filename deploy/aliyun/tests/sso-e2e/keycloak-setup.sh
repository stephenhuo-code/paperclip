#!/usr/bin/env bash
# Provisions the local e2e Keycloak (container pc-sso-e2e-keycloak):
# realm dw, organization acme, confidential client paperclip, users A/B (in acme) and C (not).
set -euo pipefail

KC="docker exec pc-sso-e2e-keycloak /opt/keycloak/bin/kcadm.sh"
APP_URL="${APP_URL:-http://localhost:3199}"
CLIENT_SECRET="${CLIENT_SECRET:-e2e-client-secret}"

for _ in $(seq 1 90); do
  if $KC config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
$KC config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null

if ! $KC get realms/dw >/dev/null 2>&1; then
  $KC create realms -s realm=dw -s enabled=true -s organizationsEnabled=true \
    -s registrationAllowed=false -s verifyEmail=false -s duplicateEmailsAllowed=false >/dev/null
fi

if [ -z "$($KC get clients -r dw -q clientId=paperclip --fields id --format csv --noquotes)" ]; then
  $KC create clients -r dw \
    -s clientId=paperclip -s enabled=true -s protocol=openid-connect \
    -s publicClient=false -s secret="$CLIENT_SECRET" \
    -s standardFlowEnabled=true -s directAccessGrantsEnabled=false \
    -s "redirectUris=[\"$APP_URL/api/auth/callback/keycloak\"]" \
    -s "webOrigins=[\"$APP_URL\"]" \
    -s 'attributes={"pkce.code.challenge.method":"S256"}' >/dev/null
fi
CLIENT_ID=$($KC get clients -r dw -q clientId=paperclip --fields id --format csv --noquotes)
# The built-in "organization" scope is an optional client scope; Paperclip requests it explicitly.

if [ -z "$($KC get organizations -r dw --fields id --format csv --noquotes 2>/dev/null)" ]; then
  $KC create organizations -r dw -s name=Acme -s alias=acme -s enabled=true \
    -s 'domains=[{"name":"example.cn"}]' >/dev/null
fi
ORG_ID=$($KC get organizations -r dw --fields id,alias --format csv --noquotes | awk -F, '$2=="acme"{print $1}')

create_user() {
  local username="$1" email="$2" first="$3"
  if [ -z "$($KC get users -r dw -q username="$username" --fields id --format csv --noquotes)" ]; then
    $KC create users -r dw -s username="$username" -s email="$email" -s emailVerified=true \
      -s firstName="$first" -s lastName=Tester -s enabled=true >/dev/null
    $KC set-password -r dw --username "$username" --new-password "Passw0rd!" >/dev/null
  fi
  $KC get users -r dw -q username="$username" --fields id --format csv --noquotes
}

USER_A=$(create_user user-a a@example.cn Alice)
USER_B=$(create_user user-b b@example.cn Bob)
create_user user-c c@outside.cn Carol >/dev/null

for member in "$USER_A" "$USER_B"; do
  $KC create "organizations/$ORG_ID/members" -r dw -b "\"$member\"" >/dev/null 2>&1 || true
done

echo "client=$CLIENT_ID org=$ORG_ID userA=$USER_A userB=$USER_B"
