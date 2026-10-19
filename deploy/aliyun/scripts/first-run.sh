#!/usr/bin/env bash
# Usage: first-run.sh <env> [--add-org]
# First-run setup on the ECS instance (specs/003-first-run-setup). Asks for
# names and passwords, then creates the operator's Keycloak admin, the
# Paperclip admin (break-glass, email and password), the company, and the
# admin's own enterprise account in the Keycloak organization; finally links
# the company to the organization, turns email sign-up off and redeploys.
# Passwords are read without echo and passed on stdin, never as arguments.
# Employee management stays in the Keycloak admin console.
#
# --add-org (specs/004-first-run-add-org): on an initialized instance, create
# another Keycloak organization and its Paperclip company (owned by the
# instance admin), add it to the organization → company map and redeploy.
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

USAGE="usage: first-run.sh <env> [--add-org]"
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "$USAGE"
ENV_NAME="$1"
ADD_ORG=0
if [ "$#" -eq 2 ]; then
  [ "$2" = --add-org ] || die "$USAGE"
  ADD_ORG=1
fi
load_environment "$ENV_NAME"
REALM="$(env_value "$ENV_FILE" KEYCLOAK_REALM)" || die "KEYCLOAK_REALM is not set in $ENV_FILE"
ORG_ALIAS="$(env_value "$ENV_FILE" KEYCLOAK_ORG_ALIAS)" || die "KEYCLOAK_ORG_ALIAS is not set in $ENV_FILE"
CURRENT="$(cat "$STATE_DIR/current" 2>/dev/null || true)"
[ -n "$CURRENT" ] || die "no deployed version recorded in $STATE_DIR/current; deploy first"
# compose resolves the image tag even for `exec`.
export PAPERCLIP_IMAGE_TAG="$CURRENT"

MIN_PASSWORD_LENGTH=12
KC_CONFIG=/tmp/first-run-kcadm.config
WORK="$(mktemp -d)"
JAR="$WORK/cookies"
cleanup() {
  rm -rf "$WORK"
  compose exec -T keycloak rm -f "$KC_CONFIG" </dev/null >/dev/null 2>&1 || true
}
trap cleanup EXIT

CA_ARGS=()
# Local test stacks trust Caddy's internal CA; production uses public certificates.
if [ -n "${DEPLOY_HEALTH_CA_FILE:-}" ]; then CA_ARGS=(--cacert "$DEPLOY_HEALTH_CA_FILE"); fi

# ---- helpers -----------------------------------------------------------------

say() { printf '%s\n' "$*" >&2; }

# ask <prompt>: one line from stdin.
ask() {
  local answer
  printf '%s' "$1" >&2
  IFS= read -r answer || die "input ended"
  printf '%s' "$answer"
}

# ask_secret <prompt>: a password, typed twice, not echoed.
ask_secret() {
  local first second
  while true; do
    printf '%s' "$1" >&2
    IFS= read -rs first || die "input ended"
    printf '\n' >&2
    printf 'Repeat: ' >&2
    IFS= read -rs second || die "input ended"
    printf '\n' >&2
    if [ "$first" != "$second" ]; then
      say "The two entries differ; try again."
    elif [ "${#first}" -lt "$MIN_PASSWORD_LENGTH" ]; then
      say "Use at least $MIN_PASSWORD_LENGTH characters."
    else
      printf '%s' "$first"
      return 0
    fi
  done
}

# json_str <text>: a JSON string literal.
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

# `docker compose exec -T` forwards stdin into the container and reads it to
# the end, which would swallow the operator's answers. Every call that does
# not expect input therefore reads from /dev/null.
kc() { compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@" --config "$KC_CONFIG" </dev/null; }
# kc_stdin: like kc, but passes this function's stdin through (passwords).
kc_stdin() { compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@" --config "$KC_CONFIG"; }

kc_login() {
  local password
  password="$(env_value "$SECRETS_FILE" KC_BOOTSTRAP_ADMIN_PASSWORD)" || die "KC_BOOTSTRAP_ADMIN_PASSWORD is missing from $SECRETS_FILE"
  # The password goes in on stdin so it is not on the host's `docker` command line.
  # shellcheck disable=SC2016
  printf '%s\n' "$password" | compose exec -T keycloak bash -c \
    'IFS= read -r password && exec /opt/keycloak/bin/kcadm.sh config credentials --config "$1" \
      --server http://localhost:8080 --realm master --user provisioner --password "$password"' \
    kcadm "$KC_CONFIG" >/dev/null || die "cannot log in to Keycloak as provisioner"
}

# kc_set_password <realm> <user-id> <password>: the password goes on stdin.
kc_set_password() {
  printf '{"type":"password","value":%s,"temporary":false}' "$(json_str "$3")" \
    | kc_stdin update "users/$2/reset-password" -r "$1" -f - >/dev/null
}

# api <path> <json>: POST the JSON through the local Caddy as a browser would.
# The body reaches curl on stdin (printf is a builtin, so it never shows in ps).
# Sets API_STATUS; the response body is in $WORK/response.
api() {
  API_STATUS="$(printf '%s' "$2" | curl -sS --max-time 30 "${CA_ARGS[@]}" --resolve "$APP_DOMAIN:443:127.0.0.1" \
    -H "Origin: https://$APP_DOMAIN" -H "Content-Type: application/json" \
    -c "$JAR" -b "$JAR" -o "$WORK/response" -w '%{http_code}' \
    --data @- "https://$APP_DOMAIN$1" 2>/dev/null)" || API_STATUS=000
  return 0
}

# pg <sql>: one query against the paperclip database, unaligned, no headers.
pg() { compose exec -T postgres psql -U postgres -d paperclip -tA -c "$1" </dev/null; }

# kc_user_id <realm> <query...>: id of the first user matching an exact query.
kc_user_id() {
  local realm="$1"; shift
  kc get users -r "$realm" "$@" -q exact=true --fields id --format csv --noquotes | head -n 1
}

paperclip_healthy() {
  local body
  body="$(curl -fsS --max-time 10 "${CA_ARGS[@]}" --resolve "$APP_DOMAIN:443:127.0.0.1" \
    "https://$APP_DOMAIN/api/health" 2>/dev/null)" || return 1
  [[ "$body" == *'"status":"ok"'* ]]
}

# set_secret <key> <value>: replace one line of the server .env, keeping mode 600.
set_secret() {
  local key="$1" value="$2" line found=0 tmp
  tmp="$(mktemp "$PAPERCLIP_ROOT/.env.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) printf '%s=%s\n' "$key" "$value"; found=1 ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$SECRETS_FILE" > "$tmp"
  if [ "$found" = 0 ]; then printf '%s=%s\n' "$key" "$value" >> "$tmp"; fi
  chmod 600 "$tmp"
  mv "$tmp" "$SECRETS_FILE"
}

# The organization → company map is a flat JSON object {"alias":"id",...};
# ECS hosts do not necessarily have jq, so it is parsed and rebuilt here.
MAP_KEY=PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP
MAP_OBJECT_RE='^[[:space:]]*\{(.*)\}[[:space:]]*$'
MAP_ENTRY_RE='^[[:space:]]*"([A-Za-z0-9._-]+)"[[:space:]]*:[[:space:]]*"([A-Za-z0-9-]+)"[[:space:]]*$'

# map_entries <json>: one "alias id" line per entry; fails on anything else.
map_entries() {
  local body="$1" entry parts
  [[ "$body" =~ ^[[:space:]]*$ ]] && return 0
  [[ "$body" =~ $MAP_OBJECT_RE ]] || return 1
  body="${BASH_REMATCH[1]}"
  [[ "$body" =~ ^[[:space:]]*$ ]] && return 0
  [[ "$body" =~ ,[[:space:]]*$ ]] && return 1
  IFS=, read -ra parts <<<"$body"
  for entry in "${parts[@]}"; do
    [[ "$entry" =~ $MAP_ENTRY_RE ]] || return 1
    printf '%s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  done
}

# map_get <json> <alias>: the company id for alias, or nothing.
map_get() { map_entries "$1" | awk -v alias="$2" '$1 == alias { print $2; exit }'; }

# map_set <json> <alias> <id>: the map with alias set to id, other entries kept in order.
map_set() {
  local entries key value out="" found=0
  entries="$(map_entries "$1")" || return 1
  while read -r key value; do
    [ -n "$key" ] || continue
    if [ "$key" = "$2" ]; then value="$3"; found=1; fi
    out="$out${out:+,}\"$key\":\"$value\""
  done <<<"$entries"
  [ "$found" = 1 ] || out="$out${out:+,}\"$2\":\"$3\""
  printf '{%s}' "$out"
}

redeploy() {
  local status
  set +e
  "$PAPERCLIP_ROOT/bin/remote-deploy.sh" "$ENV_NAME" "$CURRENT" </dev/null
  status=$?
  set -e
  [ "$status" = 0 ] || exit "$status"
}

# api_sign_in <email> <password>: start a Paperclip session in $JAR.
api_sign_in() {
  api /api/auth/sign-in/email "$(printf '{"email":%s,"password":%s}' "$(json_str "$1")" "$(json_str "$2")")"
  [[ "$API_STATUS" == 2?? ]]
}

# paperclip_sign_in <admin-email>: sign in as the instance admin. Uses the
# gateway write-back account from the .env (specs/006, the same break-glass
# admin) and asks for the emergency password only when that does not work.
paperclip_sign_in() {
  local email password try
  email="$(env_value "$SECRETS_FILE" PAPERCLIP_SYNC_EMAIL || true)"
  password="$(env_value "$SECRETS_FILE" PAPERCLIP_SYNC_PASSWORD || true)"
  if [ -n "$email" ] && [ -n "$password" ]; then
    api_sign_in "$email" "$password" && return 0
    say "The write-back account $email (PAPERCLIP_SYNC_EMAIL) could not sign in (HTTP $API_STATUS)."
  fi
  for try in 1 2 3; do
    printf 'Emergency password for %s: ' "$1" >&2
    IFS= read -rs password || die "input ended"
    printf '\n' >&2
    api_sign_in "$1" "$password" && return 0
    say "Sign-in failed (HTTP $API_STATUS); attempt $try of 3."
  done
  die "sign-in failed 3 times; nothing was changed"
}

# ---- --add-org ---------------------------------------------------------------

add_org() {
  local admin_email="${admin_row%%|*}" orgs alias org_id org_name="" domain="" company_name company_id="" old_id new_map gateway
  local same n id choice
  [ -n "$admin_row" ] || die "there is no Paperclip admin yet; run first-run.sh $ENV_NAME first"
  [ -n "$(map_get "$MAP" "$ORG_ALIAS")" ] || die "organization '$ORG_ALIAS' is not linked to a company yet; run first-run.sh $ENV_NAME first"
  orgs="$(kc get organizations -r "$REALM" --fields id,alias --format csv --noquotes)"

  say "== New organization (Keycloak)"
  while true; do
    alias="$(ask 'Organization alias: ')"
    if ! [[ "$alias" =~ ^[a-z0-9-]+$ ]]; then
      say "The alias may contain only lowercase letters, digits and -."
    elif [ "$alias" = "$ORG_ALIAS" ]; then
      say "'$ORG_ALIAS' is the first organization; run first-run.sh $ENV_NAME to change its company."
    else
      break
    fi
  done
  org_id="$(awk -F, -v alias="$alias" '$2 == alias { print $1 }' <<<"$orgs" | head -n 1)"
  if [ -n "$org_id" ]; then
    say "Organization '$alias': exists, will be used as is"
  else
    org_name="$(ask 'Organization name: ')"
    [ -n "$org_name" ] || die "organization name is required"
    while true; do
      domain="$(ask 'Email domain (e.g. example.com): ' | tr '[:upper:]' '[:lower:]')"
      [[ "$domain" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] && break
      say "Enter a domain such as example.com."
    done
  fi

  say "== Company (Paperclip)"
  company_name="$(ask 'Company name: ')"
  [ -n "$company_name" ] || die "company name is required"
  same="$(awk -F'|' -v name="$company_name" '$2 == name { print $1 }' <<<"$companies")"
  if [ -n "$same" ]; then
    n=0
    while IFS= read -r id; do
      n=$((n + 1))
      say "  $n) use the existing company '$company_name' ($id)"
    done <<<"$same"
    say "  $((n + 1))) create a new company '$company_name'"
    choice="$(ask "Which one? [1-$((n + 1))] ")"
    [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le $((n + 1)) ] || die "invalid choice"
    [ "$choice" -gt "$n" ] || company_id="$(sed -n "${choice}p" <<<"$same")"
  fi

  old_id="$(map_get "$MAP" "$alias")"
  if [ -n "$org_id" ] && [ -n "$company_id" ] && [ "$old_id" = "$company_id" ]; then
    say ""
    say "Nothing to do; '$alias' is already linked to company '$company_name'."
    return 0
  fi
  if [ -n "$old_id" ] && [ "$old_id" != "$company_id" ]; then
    say "'$alias' is linked to another company ($old_id); it will be replaced."
  fi

  say ""
  say "This will:"
  [ -z "$org_id" ] && say "  - create Keycloak organization '$org_name' (alias $alias, domain $domain)"
  [ -z "$company_id" ] && say "  - create company '$company_name', owned by $admin_email"
  if [ -n "$old_id" ] && [ "$old_id" != "$company_id" ]; then
    say "  - replace the link '$alias' → $old_id with company '$company_name' and redeploy $CURRENT"
  else
    say "  - link '$alias' to company '$company_name' and redeploy $CURRENT"
  fi
  answer="$(ask 'Proceed? [y/N] ')"
  case "$answer" in
    y|Y|yes|YES) ;;
    *) say "Cancelled; nothing was changed."; exit 0 ;;
  esac

  # Sign in before changing anything, so a wrong password changes nothing.
  [ -n "$company_id" ] || paperclip_sign_in "$admin_email"

  if [ -z "$org_id" ]; then
    if ! org_id="$(kc create organizations -r "$REALM" -s "name=$org_name" -s "alias=$alias" -s enabled=true \
      -s "domains=[{\"name\":\"$domain\"}]" -i 2>&1)"; then
      say "$org_id"
      case "$org_id" in
        *[Dd]omain*) die "creating organization '$alias' failed: the domain $domain is already used by another organization" ;;
      esac
      die "creating organization '$alias' failed"
    fi
    say "Organization '$alias': created"
  fi

  if [ -z "$company_id" ]; then
    api /api/companies "$(printf '{"name":%s}' "$(json_str "$company_name")")"
    [[ "$API_STATUS" == 2?? ]] || die "creating the company failed (HTTP $API_STATUS); run this again to continue"
    company_id="$(grep -o '"id":"[^"]*"' "$WORK/response" | head -n 1 | cut -d'"' -f4)"
    [ -n "$company_id" ] || die "creating the company returned no id"
    say "Company '$company_name': created ($company_id)"
  fi

  new_map="$(map_set "$MAP" "$alias" "$company_id")"
  if [ "$new_map" != "$MAP" ]; then
    set_secret "$MAP_KEY" "$new_map"
    say "Linked '$alias' to $company_id; redeploying $CURRENT"
    redeploy
  fi

  gateway="$(env_value "$ENV_FILE" PAPERCLIP_GATEWAY_URL || true)"
  say ""
  say "Done. Next steps:"
  say "  1. In Keycloak (https://$SSO_DOMAIN/admin/), add the employees to organization '$alias'."
  say "  2. After the lead's first enterprise sign-in, make them an admin in Paperclip:"
  say "     company '$company_name' → Settings → Members."
  say "  3. In company '$company_name', add the model gateway connection:"
  say "     Connectors → Browse → Messages API → Connect, Provider URL ${gateway:-of the model gateway}."
}

# ---- 0. checks ---------------------------------------------------------------

touch "$JAR"
keycloak_ready </dev/null || die "Keycloak is not ready; check 'docker compose ps' and try again"
paperclip_healthy || die "Paperclip is not healthy at https://$APP_DOMAIN; check the deployment and try again"
MAP="$(env_value "$SECRETS_FILE" "$MAP_KEY" || true)"
map_entries "$MAP" >/dev/null \
  || die "$MAP_KEY in $SECRETS_FILE cannot be parsed; fix it by hand (expected {\"alias\":\"company-id\",...})"
kc_login

# ---- current state -----------------------------------------------------------

admin_row="$(pg "select u.email || '|' || u.name from instance_user_roles r join \"user\" u on u.id = r.user_id where r.role = 'instance_admin' limit 1" | head -n 1)"
companies="$(pg "select id || '|' || name from companies order by created_at")"
if [ "$ADD_ORG" = 1 ]; then
  add_org
  exit 0
fi
org_id="$(kc get organizations -r "$REALM" --fields id,alias --format csv --noquotes \
  | awk -F, -v alias="$ORG_ALIAS" '$2 == alias { print $1 }' | head -n 1)"
[ -n "$org_id" ] || die "Keycloak organization '$ORG_ALIAS' not found in realm '$REALM'"
if [ -z "$admin_row" ] && [ "$(env_value "$SECRETS_FILE" PAPERCLIP_AUTH_DISABLE_SIGN_UP || true)" = true ]; then
  die "there is no Paperclip admin yet and email sign-up is off; set PAPERCLIP_AUTH_DISABLE_SIGN_UP=false in $SECRETS_FILE, redeploy, then run this again"
fi

# ---- collect answers ---------------------------------------------------------

say "== Keycloak admin (for the Keycloak admin console)"
KC_ADMIN="$(ask 'Username: ')"
[[ "$KC_ADMIN" =~ ^[A-Za-z0-9._@-]+$ ]] || die "invalid username"
create_kc_admin=0
if [ -n "$(kc_user_id master -q "username=$KC_ADMIN")" ]; then
  say "Keycloak admin '$KC_ADMIN': exists, skipped"
else
  create_kc_admin=1
  KC_ADMIN_PASSWORD="$(ask_secret 'Password: ')"
fi

say "== Paperclip admin (emergency sign-in with email and password)"
create_admin=0
EMERGENCY_PASSWORD=""
if [ -n "$admin_row" ]; then
  ADMIN_EMAIL="${admin_row%%|*}"
  ADMIN_NAME="${admin_row#*|}"
  say "Paperclip admin $ADMIN_EMAIL: exists, skipped"
else
  create_admin=1
  ADMIN_NAME="$(ask 'Name: ')"
  ADMIN_EMAIL="$(ask 'Email: ')"
  [[ "$ADMIN_EMAIL" == *@*.* ]] || die "invalid email"
  EMERGENCY_PASSWORD="$(ask_secret 'Emergency password: ')"
fi

say "== Company"
create_company=0
COMPANY_ID=""
company_count="$(printf '%s' "$companies" | grep -c . || true)"
if [ "$company_count" = 0 ]; then
  create_company=1
  COMPANY_NAME="$(ask 'Company name: ')"
  [ -n "$COMPANY_NAME" ] || die "company name is required"
elif [ "$company_count" = 1 ]; then
  COMPANY_ID="${companies%%|*}"
  COMPANY_NAME="${companies#*|}"
  say "Company '$COMPANY_NAME': exists, will be linked"
else
  n=0
  while IFS="|" read -r _ name; do
    n=$((n + 1))
    say "  $n) $name"
  done <<<"$companies"
  choice="$(ask "Which company should '$ORG_ALIAS' use? [1-$n] ")"
  [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ] || die "invalid choice"
  row="$(sed -n "${choice}p" <<<"$companies")"
  COMPANY_ID="${row%%|*}"
  COMPANY_NAME="${row#*|}"
fi

say "== The admin's enterprise account (Keycloak, same email)"
enterprise_id="$(kc_user_id "$REALM" -q "email=$ADMIN_EMAIL")"
create_enterprise=0
add_member=0
if [ -n "$enterprise_id" ]; then
  say "Enterprise account $ADMIN_EMAIL: exists, skipped"
  if ! kc get "organizations/$org_id/members" -r "$REALM" --fields id --format csv --noquotes | grep -qx "$enterprise_id"; then
    add_member=1
  fi
else
  create_enterprise=1
  add_member=1
  while true; do
    ENTERPRISE_PASSWORD="$(ask_secret 'Enterprise password: ')"
    if [ -n "$EMERGENCY_PASSWORD" ] && [ "$ENTERPRISE_PASSWORD" = "$EMERGENCY_PASSWORD" ]; then
      say "The enterprise password must differ from the emergency password."
    else
      break
    fi
  done
fi

link=1
if [ "$create_company" = 0 ] \
  && [ "$(map_get "$MAP" "$ORG_ALIAS")" = "$COMPANY_ID" ] \
  && [ "$(env_value "$SECRETS_FILE" PAPERCLIP_AUTH_DISABLE_SIGN_UP || true)" = true ]; then
  link=0
fi

if [ "$create_kc_admin$create_admin$create_company$create_enterprise$add_member$link" = 000000 ]; then
  say ""
  say "Nothing to do; first-run setup is complete."
  exit 0
fi

say ""
say "This will:"
[ "$create_kc_admin" = 1 ] && say "  - create Keycloak admin '$KC_ADMIN'"
[ "$create_admin" = 1 ] && say "  - create Paperclip admin $ADMIN_EMAIL"
[ "$create_company" = 1 ] && say "  - create company '$COMPANY_NAME'"
[ "$create_enterprise" = 1 ] && say "  - create enterprise account $ADMIN_EMAIL"
[ "$add_member" = 1 ] && say "  - add $ADMIN_EMAIL to organization '$ORG_ALIAS'"
[ "$link" = 1 ] && say "  - link '$ORG_ALIAS' to company '$COMPANY_NAME', turn email sign-up off and redeploy $CURRENT"
answer="$(ask 'Proceed? [y/N] ')"
case "$answer" in
  y|Y|yes|YES) ;;
  *) say "Cancelled; nothing was changed."; exit 0 ;;
esac

# ---- 1. Keycloak admin -------------------------------------------------------

if [ "$create_kc_admin" = 1 ]; then
  kc_admin_id="$(kc create users -r master -s "username=$KC_ADMIN" -s enabled=true -i)"
  kc_set_password master "$kc_admin_id" "$KC_ADMIN_PASSWORD"
  kc add-roles -r master --uusername "$KC_ADMIN" --rolename admin >/dev/null
  say "Keycloak admin '$KC_ADMIN': created"
fi

# ---- 2. Paperclip admin ------------------------------------------------------

if [ "$create_admin" = 1 ]; then
  while true; do
    api /api/auth/sign-up/email "$(printf '{"name":%s,"email":%s,"password":%s}' \
      "$(json_str "$ADMIN_NAME")" "$(json_str "$ADMIN_EMAIL")" "$(json_str "$EMERGENCY_PASSWORD")")"
    case "$API_STATUS" in
      2??) break ;;
      422)
        if grep -q USER_ALREADY_EXISTS "$WORK/response"; then
          say "$ADMIN_EMAIL is already registered."
          ADMIN_EMAIL="$(ask 'Use another email: ')"
          [[ "$ADMIN_EMAIL" == *@*.* ]] || die "invalid email"
          continue
        fi ;;
    esac
    die "Paperclip sign-up failed (HTTP $API_STATUS)"
  done
  invite_url="$("$(dirname "$0")/bootstrap-invite.sh" "$ENV_NAME" </dev/null)" || die "could not create the bootstrap invite"
  api "/api/invites/${invite_url##*/invite/}/accept" '{"requestType":"human"}'
  [[ "$API_STATUS" == 2?? ]] || die "accepting the bootstrap invite failed (HTTP $API_STATUS)"
  say "Paperclip admin $ADMIN_EMAIL: created"
  # The email may have changed; look the enterprise account up again.
  if [ "$create_enterprise" = 1 ] && [ -n "$(kc_user_id "$REALM" -q "email=$ADMIN_EMAIL")" ]; then
    die "a Keycloak user with $ADMIN_EMAIL already exists; run this again to link it"
  fi
fi

# ---- 3. company --------------------------------------------------------------

if [ "$create_company" = 1 ]; then
  api /api/companies "$(printf '{"name":%s}' "$(json_str "$COMPANY_NAME")")"
  [[ "$API_STATUS" == 2?? ]] || die "creating the company failed (HTTP $API_STATUS); run this again to continue"
  COMPANY_ID="$(grep -o '"id":"[^"]*"' "$WORK/response" | head -n 1 | cut -d'"' -f4)"
  [ -n "$COMPANY_ID" ] || die "creating the company returned no id"
  say "Company '$COMPANY_NAME': created ($COMPANY_ID)"
fi

# ---- 4. enterprise account ---------------------------------------------------

if [ "$create_enterprise" = 1 ]; then
  # Keycloak 26 requires both names, or the first sign-in stops at "verify profile".
  first_name="${ADMIN_NAME%% *}"
  last_name="${ADMIN_NAME#* }"
  [ "$last_name" != "$ADMIN_NAME" ] || last_name="$first_name"
  enterprise_id="$(kc create users -r "$REALM" -s "username=$ADMIN_EMAIL" -s "email=$ADMIN_EMAIL" \
    -s emailVerified=true -s enabled=true -s "firstName=$first_name" -s "lastName=$last_name" -i)"
  kc_set_password "$REALM" "$enterprise_id" "$ENTERPRISE_PASSWORD"
  say "Enterprise account $ADMIN_EMAIL: created"
fi
if [ "$add_member" = 1 ]; then
  kc create "organizations/$org_id/members" -r "$REALM" -b "\"$enterprise_id\"" >/dev/null 2>&1 \
    || die "adding $ADMIN_EMAIL to organization '$ORG_ALIAS' failed"
  say "Enterprise account $ADMIN_EMAIL: added to '$ORG_ALIAS'"
fi

# ---- 5. link and redeploy ----------------------------------------------------

if [ "$link" = 1 ]; then
  # Other organizations' links (added with --add-org) are kept.
  set_secret "$MAP_KEY" "$(map_set "$MAP" "$ORG_ALIAS" "$COMPANY_ID")"
  set_secret PAPERCLIP_AUTH_DISABLE_SIGN_UP true
  say "Linked '$ORG_ALIAS' to $COMPANY_ID and turned email sign-up off; redeploying $CURRENT"
  redeploy
fi

say ""
say "Done."
say "  Paperclip:       https://$APP_DOMAIN"
say "  Keycloak admin:  https://$SSO_DOMAIN/admin/"
say "  Add employees in Keycloak and put them in organization '$ORG_ALIAS'."
