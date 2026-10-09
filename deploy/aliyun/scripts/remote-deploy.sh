#!/usr/bin/env bash
# Usage: remote-deploy.sh <env> <commit-sha>
# Entry point for Cloud Assistant (installed as /opt/paperclip/bin/remote-deploy.sh).
# Fetches the deploy assets built for the commit (paperclip-deploy:<sha> in ACR),
# installs them into /opt/paperclip/deploy, then runs deploy.sh from them.
set -euo pipefail

PAPERCLIP_ROOT="${PAPERCLIP_ROOT:-/opt/paperclip}"
DEPLOY_DIR="${DEPLOY_DIR:-$PAPERCLIP_ROOT/deploy}"
[ "$#" -eq 2 ] || { echo "usage: remote-deploy.sh <env> <commit-sha>" >&2; exit 1; }
ENV_NAME="$1"
TAG="$2"

current_env="$DEPLOY_DIR/environments/$ENV_NAME.env"
[ -f "$current_env" ] || { echo "unknown environment '$ENV_NAME'" >&2; exit 1; }
read_setting() { sed -n "s/^$1=//p" "$current_env" | head -n 1; }
registry="$(read_setting ACR_REGISTRY_VPC)"
namespace="$(read_setting ACR_NAMESPACE)"
image="$registry/$namespace/paperclip-deploy:$TAG"

docker pull --quiet "$image" >/dev/null
container="$(docker create "$image")"
staging="$(mktemp -d)"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$staging"' EXIT
docker cp "$container:/deploy/." "$staging/"

rm -rf "$DEPLOY_DIR.next"
mv "$staging" "$DEPLOY_DIR.next"
rm -rf "$DEPLOY_DIR.prev"
mv "$DEPLOY_DIR" "$DEPLOY_DIR.prev"
mv "$DEPLOY_DIR.next" "$DEPLOY_DIR"
install -m 0755 "$DEPLOY_DIR/scripts/remote-deploy.sh" "$PAPERCLIP_ROOT/bin/remote-deploy.sh"

exec "$DEPLOY_DIR/scripts/deploy.sh" "$ENV_NAME" "$TAG"
