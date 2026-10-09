import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSandbox, sampleEnv, SECRET_VALUES } from "./helpers/sandbox.mjs";

describe("bootstrap-invite.sh", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(sampleEnv());
    box.writeState("current", "2222222222222222222222222222222222222222");
  });
  afterEach(() => box.cleanup());

  it("prints only the one-time invite URL", () => {
    const result = box.run("bootstrap-invite.sh", ["production"]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stdout.trim(), "https://agents.example.cn/invite/pcp_bootstrap_abc123");
  });

  it("runs the CLI inside the paperclip container as the node user, without pnpm", () => {
    box.run("bootstrap-invite.sh", ["production"]);
    // The inner script spans several lines, so check the whole call log.
    const log = box.calls().join("\n");
    const start = log.indexOf(" exec -T --user node paperclip ");
    assert.ok(start >= 0, log);
    const call = log.slice(start);
    assert.ok(call.includes("auth bootstrap-ceo"));
    assert.ok(!/\bpnpm\b/.test(call), "pnpm would download itself through Corepack at runtime");
    assert.match(call, /\[PAPERCLIP_IMAGE_TAG=2222222222222222222222222222222222222222\]/);
  });

  it("fails when the CLI prints no invite URL", () => {
    const result = box.run("bootstrap-invite.sh", ["production"], { FAKE_INVITE_FAILS: "1" });
    assert.notEqual(result.status, 0);
  });

  it("never prints secret values", () => {
    const result = box.run("bootstrap-invite.sh", ["production"]);
    for (const secret of SECRET_VALUES) assert.ok(!result.output.includes(secret), `leaked ${secret}`);
  });
});
