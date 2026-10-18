import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

  it("pulls images by default and skips pulling when DEPLOY_SKIP_PULL=1 (local smoke tests)", () => {
    box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.ok(box.calls().some((call) => call.includes(" pull")));
    box = (box.cleanup(), createSandbox());
    box.writeEnv(sampleEnv());
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW), DEPLOY_SKIP_PULL: "1" });
    assert.equal(result.status, 0, result.output);
    assert.ok(!box.calls().some((call) => call.includes(" pull")));
  });

  it("passes DEPLOY_HEALTH_CA_FILE to the health check only when set", () => {
    box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.ok(!box.calls().some((call) => call.startsWith("curl") && call.includes("--cacert")));
    box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW), DEPLOY_HEALTH_CA_FILE: "/tmp/root.crt" });
    assert.ok(box.calls().some((call) => call.startsWith("curl") && call.includes("--cacert /tmp/root.crt")));
  });

  // specs/006-litellm-gateway-billing
  const GATEWAY_SECRETS = ["LITELLM_MASTER_KEY", "LITELLM_SALT_KEY", "LITELLM_DB_PASSWORD", "PAPERCLIP_READONLY_DB_PASSWORD"];
  const withoutGatewaySecrets = () => sampleEnv().split("\n").filter((l) => !GATEWAY_SECRETS.some((k) => l.startsWith(`${k}=`))).join("\n");

  it("creates the gateway database roles after postgres starts and before the stack starts", () => {
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.equal(result.status, 0, result.output);
    const calls = box.calls();
    const ensure = calls.findIndex((c) => c.includes("exec -T postgres bash /docker-entrypoint-initdb.d/20-ensure-roles.sh"));
    const postgresUp = calls.findIndex((c) => c.includes(" up -d postgres"));
    const stackUp = calls.findIndex((c) => c.includes(" up -d --remove-orphans"));
    assert.ok(ensure > postgresUp && ensure < stackUp, `order: postgres ${postgresUp}, roles ${ensure}, stack ${stackUp}`);
  });

  it("rolls back when creating the gateway roles fails", () => {
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW), FAKE_ENSURE_ROLES_EXIT: "1" });
    assert.equal(result.status, 2, result.output);
    assert.equal(box.readState("current"), OLD);
  });

  it("generates missing gateway secrets once and never changes existing ones", () => {
    box.writeEnv(withoutGatewaySecrets());
    const first = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.equal(first.status, 0, first.output);
    const env = box.readEnv();
    for (const key of GATEWAY_SECRETS) assert.match(env, new RegExp(`^${key}=generated-secret-\\d+$`, "m"), key);
    assert.match(env, /^BETTER_AUTH_SECRET=value-better-auth$/m, "keeps the other lines");
    assert.equal(fs.statSync(`${box.root}/.env`).mode & 0o777, 0o600);
    assert.ok(!first.output.includes("generated-secret-"), "never prints generated values");
    box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.equal(box.readEnv(), env, "a second deploy changes nothing (the salt key must never change)");
  });

  it("rolls back when the model gateway is not ready", () => {
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW), FAKE_LITELLM_READY: "0" });
    assert.equal(result.status, 2, result.output);
    assert.equal(box.readState("current"), OLD);
  });

  it("rolls back when gateway-sync is not running its loop", () => {
    const result = box.run("deploy.sh", ["production", NEW], { FAKE_HEALTH_BODY: healthy(NEW), FAKE_GATEWAY_SYNC_READY: "0" });
    assert.equal(result.status, 2, result.output);
    assert.equal(box.readState("current"), OLD);
  });

  // plan-auto-setup: a write-back problem is visible in the deploy log, without failing the deploy.
  for (const [status, hint] of [
    ["account-missing", /PAPERCLIP_SYNC_EMAIL/],
    ["login-failed", /PAPERCLIP_SYNC_PASSWORD/],
    ["gateway-url-missing", /PAPERCLIP_GATEWAY_URL/],
  ]) {
    it(`warns in the deploy log when gateway-sync reports ${status}, and still deploys`, () => {
      const result = box.run("deploy.sh", ["production", NEW], {
        FAKE_HEALTH_BODY: healthy(NEW), FAKE_GATEWAY_SYNC_STATUS: JSON.stringify({ status, at: "2026-10-19T08:00:00Z" }),
      });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /warning: gateway-sync/i);
      assert.match(result.output, hint);
      assert.equal(box.readState("current"), NEW);
    });
  }

  it("prints no gateway-sync warning when write-back is ok", () => {
    const result = box.run("deploy.sh", ["production", NEW], {
      FAKE_HEALTH_BODY: healthy(NEW), FAKE_GATEWAY_SYNC_STATUS: JSON.stringify({ status: "ok", at: "2026-10-19T08:00:00Z", posted: 2 }),
    });
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /warning: gateway-sync/i);
  });

  it("rejects an unknown environment", () => {
    const result = box.run("deploy.sh", ["staging-does-not-exist", NEW], { FAKE_HEALTH_BODY: healthy(NEW) });
    assert.equal(result.status, 1);
  });
});
