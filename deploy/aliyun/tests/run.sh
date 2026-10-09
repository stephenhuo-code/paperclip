#!/usr/bin/env bash
# Deploy asset checks: shellcheck, actionlint and the node:test suites.
# Needs Docker (for the linters and `docker compose config`) and Node 20+.
# Real-Keycloak integration tests are separate: keycloak-provision-test.sh, sso-e2e/run-all.sh.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
FAILED=0

step() { echo; echo "== $1"; }

step "shellcheck"
mapfile -t SCRIPTS < <(cd "$REPO" && find deploy/aliyun -name '*.sh' -not -path '*/node_modules/*' | sort)
docker run --rm -v "$REPO:/repo:ro" -w /repo koalaman/shellcheck:stable -x "${SCRIPTS[@]}" || FAILED=1

step "actionlint"
docker run --rm -v "$REPO:/repo:ro" -w /repo rhysd/actionlint:latest -color .github/workflows/deploy-aliyun.yml || FAILED=1

step "node:test"
node --test "$HERE"/*.test.mjs || FAILED=1

echo
if [ "$FAILED" = "0" ]; then echo "deploy checks passed"; else echo "deploy checks FAILED"; fi
exit "$FAILED"
