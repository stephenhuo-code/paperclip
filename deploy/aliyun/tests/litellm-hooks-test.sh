#!/usr/bin/env bash
# Integration test for the model gateway hooks (deploy/aliyun/litellm, specs/006):
# a real LiteLLM with the deployment's config and hooks, its own PostgreSQL, and
# a fake Anthropic upstream that records the headers it receives.
#   - priced models are billed at their prices; price changes apply to new calls
#   - models without prices are refused before reaching the upstream
#   - the caller's own User-Agent reaches the upstream, never an invented one
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$HERE/.."
IMAGE="${LITELLM_TEST_IMAGE:-ghcr.io/berriai/litellm@sha256:b7b9e2c306343721802253d0dd9436b9634a2eb4e14da7c7cf06c5c7b7530802}"
NET=litellm-hooks-test
MASTER=sk-litellm-hooks-test
PORT=4099
WORK="$(mktemp -d)"
FAILED=0

check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected '$3', got '$2')"; FAILED=1; fi
}
cleanup() {
  docker rm -f lht-litellm lht-db lht-upstream >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup >/dev/null 2>&1; WORK="$(mktemp -d)"
docker network create "$NET" >/dev/null
docker run -d --name lht-db --network "$NET" -e POSTGRES_USER=litellm -e POSTGRES_PASSWORD=litellm \
  -e POSTGRES_DB=litellm postgres:17-alpine >/dev/null
docker run -d --name lht-upstream --network "$NET" -v "$HERE/fixtures/fake-anthropic.mjs:/app/capture.mjs:ro" \
  -v "$WORK:/data" node:24-alpine node /app/capture.mjs >/dev/null
for _ in $(seq 1 60); do docker exec lht-db pg_isready -U litellm >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name lht-litellm --network "$NET" -p "127.0.0.1:$PORT:4000" \
  -e LITELLM_MASTER_KEY="$MASTER" -e LITELLM_SALT_KEY=test-salt -e STORE_MODEL_IN_DB=True \
  -e DATABASE_URL=postgresql://litellm:litellm@lht-db:5432/litellm \
  -v "$DEPLOY/litellm/config.yaml:/app/config.yaml:ro" -v "$DEPLOY/litellm/hooks.py:/app/hooks.py:ro" \
  "$IMAGE" --config /app/config.yaml --port 4000 >/dev/null
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/health/liveliness" >/dev/null && break; sleep 2; done

API() { curl -sS -H "Authorization: Bearer $1" -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" "${@:2}"; }
admin() { API "$MASTER" "$@"; }
add_model() { # name [pricing-json-fragment]
  admin -o /dev/null -X POST "http://127.0.0.1:$PORT/model/new" -d "{\"model_name\":\"$1\",\"model_info\":{\"id\":\"$1\"},
    \"litellm_params\":{\"model\":\"anthropic/capture\",\"api_base\":\"http://lht-upstream:8080\",\"api_key\":\"dummy\"${2:+,$2}}}"
}
PRICES='"input_cost_per_token":0.000001,"cache_read_input_token_cost":0.0000001,"cache_creation_input_token_cost":0.000002,"output_cost_per_token":0.000004'
add_model priced "$PRICES"
add_model unpriced
sleep 12 # the proxy reloads models from its database
KEY="$(admin -X POST "http://127.0.0.1:$PORT/key/generate" -d '{"models":["priced","unpriced"]}' | sed -E 's/.*"key":"([^"]+)".*/\1/')"
upstream_calls() { [ -f "$WORK/capture-headers.jsonl" ] && grep -c '/v1/messages' "$WORK/capture-headers.jsonl" || echo 0; }
last_ua() { tail -n 1 "$WORK/capture-headers.jsonl" | sed -E 's/.*"user-agent":"([^"]*)".*/\1/'; }
message() { # model [user-agent]
  local ua=()
  [ -n "${2:-}" ] && ua=(-H "User-Agent: $2")
  API "$KEY" "${ua[@]}" -o "$WORK/response" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/messages" \
    -d "{\"model\":\"$1\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
}

# 1. Priced model, caller User-Agent forwarded verbatim (US2, US4).
CLAUDE_UA="claude-cli/2.1.300 (external, sdk-cli)"
check "priced model call succeeds" "$(message priced "$CLAUDE_UA")" "200"
check "upstream receives the caller's User-Agent" "$(last_ua)" "$CLAUDE_UA"

# 2. Unpriced model refused before the upstream (US2, FR-004b).
before="$(upstream_calls)"
check "unpriced model is refused" "$(message unpriced "$CLAUDE_UA")" "400"
check "refusal names the model" "$(grep -c '模型未设单价：unpriced' "$WORK/response")" "1"
check "refused call never reaches the upstream" "$(upstream_calls)" "$before"

# 3. Price change applies to the next call (US2).
admin -o /dev/null -X POST "http://127.0.0.1:$PORT/model/update" -d '{"model_name":"priced","model_info":{"id":"priced"},"litellm_params":{"output_cost_per_token":0.000008}}'
sleep 12
check "call after the price change succeeds" "$(message priced "$CLAUDE_UA")" "200"

# 4. A caller without a User-Agent of its own: nothing is invented (US4).
curl -sS -o /dev/null -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" \
  -H "User-Agent:" -X POST "http://127.0.0.1:$PORT/v1/messages" -d '{"model":"priced","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
case "$(last_ua)" in claude-cli*) check "no invented User-Agent" "claude-cli" "not claude-cli" ;; *) check "no invented User-Agent" ok ok ;; esac

# Spend: 1000 in, 5000 cache read, 300 cache write, 200 out -> $0.0029 at the
# first prices and $0.0037 after output went from $4/M to $8/M.
sleep 15
# Refused calls leave a $0 failure row; only successful calls are billed.
SPEND="$(admin "http://127.0.0.1:$PORT/spend/logs?api_key=$KEY" \
  | jq -r '[.[] | select(.status != "failure" and .spend > 0)] | sort_by(.startTime) | map(.spend | tostring) | join(" ")')"
check "spend per call at the configured prices" "$(echo "$SPEND" | awk '{print $1" "$2}')" "0.0029 0.0037"

if [ "$FAILED" = 0 ]; then echo "litellm hooks test passed"; else echo "litellm hooks test FAILED"; exit 1; fi
