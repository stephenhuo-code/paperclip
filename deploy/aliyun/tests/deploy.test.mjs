import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSandbox, sampleEnv, SECRET_VALUES } from "./helpers/sandbox.mjs";

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const healthy = (commit) => JSON.stringify({ status: "ok", commit });

describe("deploy.sh", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(sampleEnv());
    box.writeState("current", OLD);
  });
  afterEach(() => box.cleanup());

  it("refuses to deploy when the server .env defines ANTHROPIC_* variables", () => {
    box.writeEnv(sampleEnv("ANTHROPIC_BASE_URL=https://example.invalid"));
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.equal(result.status, 1);
    assert.match(result.output, /ANTHROPIC_/);
    assert.ok(!box.calls().some((call) => call.includes(" up ")), "must not start containers");
  });

  it("records the new version after a healthy rollout", () => {
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.equal(result.status, 0, result.output);
    assert.equal(box.readState("previous"), OLD);
    assert.equal(box.readState("current"), NEW);
    const calls = box.calls();
    assert.ok(calls.some((call) => call.startsWith("docker compose") && call.includes(" pull")), "pulls images");
    assert.ok(calls.some((call) => call.includes(" run --rm keycloak-config")), "provisions Keycloak");
    assert.ok(calls.some((call) => call.includes(" up -d")), "starts the stack");
  });

  it("rolls back and exits 2 when the server reports a different commit", () => {
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(OLD) });
    assert.equal(result.status, 2, result.output);
    assert.equal(box.readState("current"), OLD);
    const rollback = box.calls().filter((call) => call.includes(" up -d")).at(-1);
    assert.ok(rollback, "starts the previous version again");
  });

  it("rolls back and exits 2 when the health check never succeeds", () => {
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: "", FAKE_CURL_EXIT: "7" });
    assert.equal(result.status, 2, result.output);
    assert.equal(box.readState("current"), OLD);
  });

  it("rolls back when Keycloak is not ready", () => {
    const result = box.run("deploy.sh", ["production", NEW], {
      FAKE_HEALTH_BODY: healthy(NEW),
      FAKE_KEYCLOAK_READY: "0",
    });
    assert.equal(result.status, 2, result.output);
    assert.equal(box.readState("current"), OLD);
  });

  it("starts the previous image tag during rollback", () => {
    box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(OLD) });
    const log = box.calls().join("\n");
    assert.match(log, new RegExp(`PAPERCLIP_IMAGE_TAG=${OLD}`), "rollback uses the previous tag");
  });

  it("never prints secret values from .env", () => {
    for (const env of [{ FAKE_HEALTH_BODY: healthy(NEW) }, { FAKE_HEALTH_BODY: healthy(OLD) }]) {
      const result = box.run("deploy.sh", ["production", NEW], env);
      for (const secret of SECRET_VALUES) assert.ok(!result.output.includes(secret), `leaked ${secret}`);
    }
  });

  it("rejects an unknown environment", () => {
    const result = box.run("deploy.sh", ["staging-does-not-exist", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.equal(result.status, 1);
  });
});
