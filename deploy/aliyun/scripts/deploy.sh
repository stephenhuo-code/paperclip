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
compose pull --quiet || die "could not pull images for $TARGET_TAG"
compose up -d postgres keycloak || rollback
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
