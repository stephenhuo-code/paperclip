#!/usr/bin/env bash
# Starts an isolated Paperclip server (authenticated mode) for the SSO e2e run.
# Usage: start-paperclip.sh [org-company-map-json]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"

export PAPERCLIP_HOME="${PAPERCLIP_HOME:-${TMPDIR:-/tmp}/paperclip-sso-e2e}"
export PAPERCLIP_INSTANCE_ID=sso-e2e
export DATABASE_URL=postgres://postgres:e2e@127.0.0.1:55432/paperclip
export HOST=127.0.0.1
export PORT=3199
export SERVE_UI=false
export PAPERCLIP_DEPLOYMENT_MODE=authenticated
export PAPERCLIP_DEPLOYMENT_EXPOSURE=private
export PAPERCLIP_PUBLIC_URL=http://localhost:3199
export BETTER_AUTH_SECRET=e2e-better-auth-secret-0123456789abcdef
export PAPERCLIP_AGENT_JWT_SECRET=e2e-agent-jwt-secret-0123456789abcdef
export PAPERCLIP_MIGRATION_AUTO_APPLY=true
export PAPERCLIP_ANNOUNCEMENTS_ENABLED=false
export PAPERCLIP_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1
export PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false  # e2e logs in many times in a row
export PAPERCLIP_AUTH_OIDC_ISSUER=http://localhost:18080/realms/dw
export PAPERCLIP_AUTH_OIDC_CLIENT_ID=paperclip
export PAPERCLIP_AUTH_OIDC_CLIENT_SECRET=e2e-client-secret
export PAPERCLIP_AUTH_OIDC_LABEL="使用企业账号登录"
export PAPERCLIP_AUTH_SESSION_TTL_SECONDS=86400
if [ -n "${1:-}" ]; then
  export PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP="$1"
fi

mkdir -p "$PAPERCLIP_HOME"
cd "$REPO/server"
exec npx tsx src/index.ts >"$PAPERCLIP_HOME/server.log" 2>&1
