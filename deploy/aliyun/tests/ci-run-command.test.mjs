import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEPLOY_SRC } from "./helpers/sandbox.mjs";

const SHA = "3333333333333333333333333333333333333333";

// Fake aliyun CLI. Like the real one, it refuses to run without a client
// region (--region flag or ALIBABA_CLOUD_REGION_ID); the API's --RegionId
// parameter is not enough.
const FAKE_ALIYUN = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
args=" $* "
if [ -z "${'${ALIBABA_CLOUD_REGION_ID:-}'}" ]; then
  case "$args" in *" --region "*) ;; *) echo "ERROR: region can't be empty" >&2; exit 3 ;; esac
fi
case "$1 $2" in
  "ecs RunCommand") echo '{"InvokeId":"t-1"}' ;;
  "ecs DescribeInvocationResults")
    echo '{"Invocation":{"InvocationResults":{"InvocationResult":[{"InvocationStatus":"Success","ExitCode":0,"Output":"ZGVwbG95ZWQK"}]}}}' ;;
esac
`;

describe("ci-run-command.sh", () => {
  let dir;
  let log;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ci-run-"));
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "aliyun"), FAKE_ALIYUN, { mode: 0o755 });
    log = path.join(dir, "aliyun.log");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(env = {}) {
    return spawnSync("bash", [path.join(DEPLOY_SRC, "scripts", "ci-run-command.sh"), "production", SHA], {
      encoding: "utf8",
      env: {
        PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
        FAKE_LOG: log,
        ALIYUN_REGION: "cn-hangzhou",
        ECS_INSTANCE_ID: "i-test",
        POLL_SECONDS: "0",
        ...env,
      },
    });
  }

  it("gives the aliyun CLI its region and reports the remote result", () => {
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /remote deploy finished: Success \(exit 0\)/);
    assert.match(result.stdout, /deployed/);
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, new RegExp(`/opt/paperclip/bin/remote-deploy.sh production ${SHA}`));
  });
});
