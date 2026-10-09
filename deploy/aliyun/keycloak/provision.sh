#!/usr/bin/env bash
# Idempotent Keycloak provisioning for the Paperclip digital-workforce platform.
# Runs inside the Keycloak image (keycloak-config service) on every deploy.
#
# Owned by this script (re-applied on every run; manual console edits to these
# fields are reverted):
#   realm:  enabled, organizationsEnabled, registrationAllowed=false,
#           verifyEmail=true, loginWithEmailAllowed=true, duplicateEmailsAllowed=false
#   client: paperclip - confidential, standard flow only, PKCE S256, secret,
#           redirect URI, web origin, post-logout redirect
#   organization: alias, name, enabled, domain
# Never touched: users, organization members, other clients, any other setting.
set -euo pipefail

: "${KEYCLOAK_URL:?}" "${KC_BOOTSTRAP_ADMIN_USERNAME:?}" "${KC_BOOTSTRAP_ADMIN_PASSWORD:?}"
: "${KEYCLOAK_REALM:?}" "${KEYCLOAK_ORG_NAME:?}" "${KEYCLOAK_ORG_ALIAS:?}" "${KEYCLOAK_ORG_DOMAIN:?}"
: "${APP_DOMAIN:?}" "${PAPERCLIP_AUTH_OIDC_CLIENT_SECRET:?}"

KCADM_CONFIG="$(mktemp)"
trap 'rm -f "$KCADM_CONFIG"' EXIT
kc() { /opt/keycloak/bin/kcadm.sh "$@" --config "$KCADM_CONFIG"; }
realm="$KEYCLOAK_REALM"
app="https://$APP_DOMAIN"

for _ in $(seq 1 90); do
  if kc config credentials --server "$KEYCLOAK_URL" --realm master \
    --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
kc config credentials --server "$KEYCLOAK_URL" --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null

realm_fields=(
  -s enabled=true -s organizationsEnabled=true -s registrationAllowed=false
  -s verifyEmail=true -s loginWithEmailAllowed=true -s duplicateEmailsAllowed=false
)
if kc get "realms/$realm" --fields realm >/dev/null 2>&1; then
  kc update "realms/$realm" "${realm_fields[@]}"
  echo "realm $realm updated"
else
  kc create realms -s realm="$realm" "${realm_fields[@]}" >/dev/null 2>&1
  echo "realm $realm created"
fi

client_fields=(
  -s enabled=true -s name=Paperclip -s protocol=openid-connect -s publicClient=false
  -s clientAuthenticatorType=client-secret -s secret="$PAPERCLIP_AUTH_OIDC_CLIENT_SECRET"
  -s standardFlowEnabled=true -s implicitFlowEnabled=false
  -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false
  -s "redirectUris=[\"$app/api/auth/callback/keycloak\"]"
  -s "webOrigins=[\"$app\"]"
  -s 'attributes."pkce.code.challenge.method"=S256'
  -s "attributes.\"post.logout.redirect.uris\"=$app/*"
)
client_id="$(kc get clients -r "$realm" -q clientId=paperclip --fields id --format csv --noquotes)"
if [ -n "$client_id" ]; then
  kc update "clients/$client_id" -r "$realm" "${client_fields[@]}"
  echo "client paperclip updated"
else
  kc create clients -r "$realm" -s clientId=paperclip "${client_fields[@]}" >/dev/null 2>&1
  echo "client paperclip created"
fi
# The built-in "organization" client scope stays optional on the client:
# Paperclip requests it explicitly and its mapper adds the claim to the ID token.

org_fields=(
  -s name="$KEYCLOAK_ORG_NAME" -s alias="$KEYCLOAK_ORG_ALIAS" -s enabled=true
  -s "domains=[{\"name\":\"$KEYCLOAK_ORG_DOMAIN\"}]"
)
# The Keycloak image is minimal (no awk/grep), so parse with bash only.
org_id=""
while IFS=, read -r id alias; do
  if [ "$alias" = "$KEYCLOAK_ORG_ALIAS" ]; then org_id="$id"; fi
done < <(kc get organizations -r "$realm" --fields id,alias --format csv --noquotes)
if [ -n "$org_id" ]; then
  kc update "organizations/$org_id" -r "$realm" "${org_fields[@]}"
  echo "organization $KEYCLOAK_ORG_ALIAS updated"
else
  kc create organizations -r "$realm" "${org_fields[@]}" >/dev/null 2>&1
  echo "organization $KEYCLOAK_ORG_ALIAS created"
fi
