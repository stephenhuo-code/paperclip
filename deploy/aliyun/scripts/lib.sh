# shellcheck shell=bash
# shellcheck disable=SC2034  # variables here are consumed by the scripts that source this file
# Shared helpers for the deploy scripts. Source it; do not run it.
# Never print values from the secrets file.

PAPERCLIP_ROOT="${PAPERCLIP_ROOT:-/opt/paperclip}"
DEPLOY_DIR="${DEPLOY_DIR:-$PAPERCLIP_ROOT/deploy}"
SECRETS_FILE="$PAPERCLIP_ROOT/.env"
STATE_DIR="$PAPERCLIP_ROOT/state"
DEPLOY_HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-600}"
DEPLOY_HEALTH_INTERVAL_SECONDS="${DEPLOY_HEALTH_INTERVAL_SECONDS:-5}"

die() {
  echo "error: $*" >&2
  exit 1
}

# Reads KEY from a compose-style env file without sourcing it (values such as
# ADMIN_ALLOWED_CIDRS may contain spaces, and the file is not shell syntax).
env_value() {
  local file="$1" key="$2" line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done < "$file"
  return 1
}

# Usage: load_environment <env>. Sets ENV_FILE and the non-secret settings
# the scripts need.
load_environment() {
  local env="$1"
  [ -n "$env" ] || die "environment name is required"
  ENV_FILE="$DEPLOY_DIR/environments/$env.env"
  [ -f "$ENV_FILE" ] || die "unknown environment '$env' (no $ENV_FILE)"
  [ -f "$SECRETS_FILE" ] || die "missing $SECRETS_FILE; run bootstrap.sh first"
  APP_DOMAIN="$(env_value "$ENV_FILE" APP_DOMAIN)" || die "APP_DOMAIN is not set in $ENV_FILE"
  SSO_DOMAIN="$(env_value "$ENV_FILE" SSO_DOMAIN)" || die "SSO_DOMAIN is not set in $ENV_FILE"
  OSS_BACKUP_BUCKET="$(env_value "$ENV_FILE" OSS_BACKUP_BUCKET || true)"
  OSS_ENDPOINT="$(env_value "$ENV_FILE" OSS_ENDPOINT || true)"
  OSS_RAM_ROLE="$(env_value "$ENV_FILE" OSS_RAM_ROLE || true)"
}

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" \
    --env-file "$ENV_FILE" --env-file "$SECRETS_FILE" "$@"
}

ossutil_args() {
  OSSUTIL_ARGS=(-e "$OSS_ENDPOINT")
  if [ -n "$OSS_RAM_ROLE" ]; then
    OSSUTIL_ARGS+=(--mode EcsRamRole --ecs-role-name "$OSS_RAM_ROLE")
  fi
}

keycloak_ready() {
  local status
  # The Keycloak image has no curl; talk HTTP to the management port directly.
  status="$(compose exec -T keycloak bash -c \
    'exec 3<>/dev/tcp/127.0.0.1/9000 && printf "GET /health/ready HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3 && head -n 1 <&3' \
    2>/dev/null || true)"
  [[ "$status" == *" 200"* ]]
}

paperclip_ready() {
  local expected_commit="$1" body
  local -a ca_args=()
  # Local smoke tests trust Caddy's internal CA; production uses public certificates.
  if [ -n "${DEPLOY_HEALTH_CA_FILE:-}" ]; then ca_args=(--cacert "$DEPLOY_HEALTH_CA_FILE"); fi
  # Resolve the public name to this host so the check goes through Caddy and
  # the real certificate without depending on hairpin NAT.
  body="$(curl -fsS --max-time 10 "${ca_args[@]}" --resolve "$APP_DOMAIN:443:127.0.0.1" \
    "https://$APP_DOMAIN/api/health" 2>/dev/null)" || return 1
  [[ "$body" == *'"status":"ok"'* && "$body" == *"\"commit\":\"$expected_commit\""* ]]
}

# Usage: wait_healthy <commit>. Waits until Paperclip reports the commit and
# Keycloak is ready, or DEPLOY_HEALTH_TIMEOUT_SECONDS passes.
wait_healthy() {
  local expected_commit="$1" deadline=$((SECONDS + DEPLOY_HEALTH_TIMEOUT_SECONDS))
  while true; do
    if paperclip_ready "$expected_commit" && keycloak_ready; then
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep "$DEPLOY_HEALTH_INTERVAL_SECONDS"
  done
}
