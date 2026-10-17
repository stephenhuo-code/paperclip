#!/usr/bin/env bash
# Usage: deploy.sh <env> <image-tag>
# Pulls and starts the given Paperclip image, provisions Keycloak, and waits
# for both to be healthy. On failure it starts the previous version again.
# Exit codes: 0 deployed, 2 unhealthy and rolled back, 1 any other error.
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

[ "$#" -eq 2 ] || die "usage: deploy.sh <env> <image-tag>"
TARGET_TAG="$2"
load_environment "$1"

if grep -qE '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_' "$SECRETS_FILE"; then
  die "$SECRETS_FILE must not define ANTHROPIC_* variables; configure model endpoints and keys on each agent"
fi

# Secrets added after the first bootstrap (specs/006 model gateway): generate
# them once on servers that predate them. Existing values are never changed;
# LITELLM_SALT_KEY in particular must stay the same for good.
for key in LITELLM_MASTER_KEY LITELLM_SALT_KEY LITELLM_DB_PASSWORD PAPERCLIP_READONLY_DB_PASSWORD; do
  if ! grep -q "^$key=" "$SECRETS_FILE"; then
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> "$SECRETS_FILE"
    echo "generated missing secret $key"
  fi
done
chmod 600 "$SECRETS_FILE"

mkdir -p "$STATE_DIR"
PREVIOUS_TAG="$(cat "$STATE_DIR/current" 2>/dev/null || true)"

rollback() {
  echo "deploy of $TARGET_TAG is unhealthy" >&2
  if [ -n "$PREVIOUS_TAG" ] && [ "$PREVIOUS_TAG" != "$TARGET_TAG" ]; then
    echo "rolling back to $PREVIOUS_TAG" >&2
    PAPERCLIP_IMAGE_TAG="$PREVIOUS_TAG" compose up -d --remove-orphans || true
  fi
  exit 2
}

export PAPERCLIP_IMAGE_TAG="$TARGET_TAG"
echo "deploying $TARGET_TAG (previous: ${PREVIOUS_TAG:-none})"
if [ "${DEPLOY_SKIP_PULL:-0}" != "1" ]; then
  compose pull --quiet || die "could not pull images for $TARGET_TAG"
fi
compose up -d postgres keycloak || rollback
# Gateway roles for servers whose database predates them (idempotent).
compose exec -T postgres bash /docker-entrypoint-initdb.d/20-ensure-roles.sh </dev/null || rollback
compose --profile provision run --rm keycloak-config || rollback
compose up -d --remove-orphans || rollback

if ! wait_healthy "$TARGET_TAG"; then
  rollback
fi

if [ -n "$PREVIOUS_TAG" ]; then
  printf '%s\n' "$PREVIOUS_TAG" > "$STATE_DIR/previous"
fi
printf '%s\n' "$TARGET_TAG" > "$STATE_DIR/current"
echo "deployed $TARGET_TAG"
