import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSandbox, sampleEnv, SECRET_VALUES } from "./helpers/sandbox.mjs";

// backup.sh names the folder with `date +%F`, which uses the local time zone.
const now = new Date();
const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
  .join("-");
const indexOf = (calls, pattern) => calls.findIndex((call) => pattern.test(call));

describe("backup.sh", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(sampleEnv());
  });
  afterEach(() => box.cleanup());

  it("dumps both databases and the data volume, then uploads them for today", () => {
    const result = box.run("backup.sh", ["production"]);
    assert.equal(result.status, 0, result.output);
    const calls = box.calls();
    assert.ok(calls.some((c) => / exec -T postgres pg_dump .*-Fc.* paperclip/.test(c)), "dumps paperclip");
    assert.ok(calls.some((c) => / exec -T postgres pg_dump .*-Fc.* keycloak/.test(c)), "dumps keycloak");
    assert.ok(calls.some((c) => / exec -T paperclip tar /.test(c) && c.includes("data/storage") && c.includes("secrets")),
      "archives attachments and the secrets master key");
    const upload = calls.find((c) => c.startsWith("ossutil cp"));
    assert.ok(upload, "uploads to OSS");
    assert.match(upload, new RegExp(`oss://acme-paperclip-backup/${today}/`));
  });

  it("fails when the certificate expires within 7 days", () => {
    const result = box.run("backup.sh", ["production"], { FAKE_CERT_EXPIRING: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /certificate/i);
  });

  it("checks certificates for both public domains with a 7-day window", () => {
    box.run("backup.sh", ["production"]);
    const calls = box.calls();
    assert.ok(calls.some((c) => c.includes("s_client") && c.includes("agents.example.cn")));
    assert.ok(calls.some((c) => c.includes("s_client") && c.includes("sso.example.cn")));
    assert.ok(calls.some((c) => c.includes("-checkend 604800")));
  });

  it("fails when the upload fails", () => {
    const result = box.run("backup.sh", ["production"], { FAKE_OSSUTIL_EXIT: "1" });
    assert.notEqual(result.status, 0);
  });

  it("never prints secret values", () => {
    const result = box.run("backup.sh", ["production"]);
    for (const secret of SECRET_VALUES) assert.ok(!result.output.includes(secret), `leaked ${secret}`);
  });
});

describe("restore.sh", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(sampleEnv());
    box.writeState("current", "2222222222222222222222222222222222222222");
  });
  afterEach(() => box.cleanup());

  it("downloads first, then stops, restores both databases and the volume, starts and checks health", () => {
    const result = box.run("restore.sh", ["production", "2026-10-01"], {
      FAKE_HEALTH_BODY: JSON.stringify({ status: "ok", commit: "2222222222222222222222222222222222222222" }),
    });
    assert.equal(result.status, 0, result.output);
    const calls = box.calls();
    const download = indexOf(calls, /^ossutil cp .*oss:\/\/acme-paperclip-backup\/2026-10-01\//);
    const stop = indexOf(calls, / compose .* stop paperclip keycloak/);
    const restoreApp = indexOf(calls, /pg_restore .*-d paperclip/);
    const restoreKc = indexOf(calls, /pg_restore .*-d keycloak/);
    const restoreVolume = indexOf(calls, / run --rm .*paperclip .*tar /);
    const start = calls.findLastIndex((c) => / up -d/.test(c));
    const health = calls.findLastIndex((c) => c.startsWith("curl") && c.includes("/api/health"));
    for (const [name, index] of Object.entries({ download, stop, restoreApp, restoreKc, restoreVolume, start, health })) {
      assert.ok(index >= 0, `missing step ${name}`);
    }
    assert.ok(download < stop && stop < restoreApp && restoreApp < restoreVolume && restoreVolume < start && start < health,
      calls.join("\n"));
    assert.ok(restoreKc > stop && restoreKc < start);
  });

  it("stops before touching anything when the download fails", () => {
    const result = box.run("restore.sh", ["production", "2026-10-01"], { FAKE_OSSUTIL_EXIT: "1" });
    assert.notEqual(result.status, 0);
    const calls = box.calls();
    assert.ok(!calls.some((c) => / stop /.test(c) || /pg_restore/.test(c)), calls.join("\n"));
  });

  it("requires a backup date", () => {
    const result = box.run("restore.sh", ["production"]);
    assert.notEqual(result.status, 0);
  });
});
