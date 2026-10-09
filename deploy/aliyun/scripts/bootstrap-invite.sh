#!/usr/bin/env bash
# Usage: bootstrap-invite.sh <env>
# Prints a one-time bootstrap invite URL for the first instance admin
# (public deployments disable the browser claim). The container is configured
# by environment variables only, so the CLI gets a throwaway minimal config
# file in /tmp; the server's own configuration is not touched. The CLI runs
# with node directly: pnpm would download itself through Corepack.
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

[ "$#" -eq 1 ] || die "usage: bootstrap-invite.sh <env>"
load_environment "$1"
PAPERCLIP_IMAGE_TAG="$(cat "$STATE_DIR/current" 2>/dev/null || true)"
[ -n "$PAPERCLIP_IMAGE_TAG" ] || die "no deployed version recorded in $STATE_DIR/current; deploy first"
export PAPERCLIP_IMAGE_TAG

# Runs inside the container; $DATABASE_URL and $PAPERCLIP_PUBLIC_URL are the container's own.
# shellcheck disable=SC2016
inner='set -eu
cfg="$(mktemp /tmp/paperclip-cli-XXXXXX.json)"
trap "rm -f \"$cfg\"" EXIT
cat > "$cfg" <<JSON
{
  "\$meta": { "version": 1, "updatedAt": "1970-01-01T00:00:00.000Z", "source": "configure" },
  "database": { "mode": "postgres", "connectionString": "$DATABASE_URL" },
  "logging": { "mode": "file" },
  "server": { "deploymentMode": "authenticated", "exposure": "public" },
  "telemetry": { "enabled": false },
  "auth": { "baseUrlMode": "explicit", "publicBaseUrl": "$PAPERCLIP_PUBLIC_URL" }
}
JSON
cd /app
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth bootstrap-ceo \
  --config "$cfg" --base-url "$PAPERCLIP_PUBLIC_URL"'

output="$(compose exec -T --user node paperclip sh -c "$inner" 2>&1 || true)"
# Strip colour codes, then pick the invite link.
url="$(printf '%s\n' "$output" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE "https://$APP_DOMAIN/invite/[A-Za-z0-9_-]+" | head -n 1 || true)"
if [ -z "$url" ]; then
  echo "error: bootstrap-ceo did not print an invite URL:" >&2
  printf '%s\n' "$output" | sed 's/\x1b\[[0-9;]*m//g' | grep -vE 'postgres://' >&2 || true
  exit 1
fi
printf '%s\n' "$url"
