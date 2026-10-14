#!/usr/bin/env bash
# Usage: ci-run-command.sh <env> <commit-sha>
# Runs from CI: asks Cloud Assistant to execute remote-deploy.sh on the ECS
# instance, waits for it, prints its output and exits with its exit code.
# Needs the aliyun CLI and jq, ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET in the
# environment, and ALIYUN_REGION + ECS_INSTANCE_ID (from the environment file).
# The command sent contains only the environment name and the commit.
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: ci-run-command.sh <env> <commit-sha>" >&2; exit 1; }
ENV_NAME="$1"
TAG="$2"
: "${ALIYUN_REGION:?}" "${ECS_INSTANCE_ID:?}"
[[ "$ENV_NAME" =~ ^[a-z0-9-]+$ ]] || { echo "invalid environment name" >&2; exit 1; }
[[ "$TAG" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit sha" >&2; exit 1; }
# The CLI needs a client region of its own; --RegionId only fills the API call.
export ALIBABA_CLOUD_REGION_ID="$ALIYUN_REGION"
POLL_SECONDS="${POLL_SECONDS:-10}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1800}"

invoke_id="$(aliyun ecs RunCommand \
  --RegionId "$ALIYUN_REGION" \
  --InstanceId.1 "$ECS_INSTANCE_ID" \
  --Type RunShellScript \
  --Name "paperclip-deploy-$TAG" \
  --CommandContent "/opt/paperclip/bin/remote-deploy.sh $ENV_NAME $TAG" \
  --Timeout "$TIMEOUT_SECONDS" | jq -r '.InvokeId')"
[ -n "$invoke_id" ] && [ "$invoke_id" != "null" ] || { echo "RunCommand did not return an invocation id" >&2; exit 1; }
echo "Cloud Assistant invocation $invoke_id"

deadline=$((SECONDS + TIMEOUT_SECONDS + 120))
while true; do
  result="$(aliyun ecs DescribeInvocationResults --RegionId "$ALIYUN_REGION" --InvokeId "$invoke_id" \
    | jq -c '.Invocation.InvocationResults.InvocationResult[0] // {}')"
  status="$(jq -r '.InvocationStatus // "Pending"' <<<"$result")"
  case "$status" in
    Success|Failed|Timeout|Cancelled|Terminated|Error|Aborted)
      jq -r '.Output // ""' <<<"$result" | base64 -d 2>/dev/null || true
      exit_code="$(jq -r '.ExitCode // 1' <<<"$result")"
      echo "remote deploy finished: $status (exit $exit_code)"
      exit "$exit_code"
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timed out waiting for invocation $invoke_id" >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
done
