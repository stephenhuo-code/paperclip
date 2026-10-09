import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSandbox, DEPLOY_SRC } from "./helpers/sandbox.mjs";

// env.example: empty values are secrets bootstrap.sh generates (except the
// organization map, which the admin fills in after creating the first
// company); non-empty values are defaults copied as-is.
const EXAMPLE = Object.fromEntries(
  fs
    .readFileSync(path.join(DEPLOY_SRC, "env.example"), "utf8")
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const GENERATED_KEYS = Object.keys(EXAMPLE).filter(
  (key) => EXAMPLE[key] === "" && key !== "PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP",
);
const DEFAULT_KEYS = Object.keys(EXAMPLE).filter((key) => EXAMPLE[key] !== "");

function parseEnv(text) {
  return Object.fromEntries(
    text.split("\n").filter((line) => line.includes("=") && !line.startsWith("#")).map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
}

describe("bootstrap.sh secrets", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
  });
  afterEach(() => box.cleanup());

  it("generates every secret listed in env.example", () => {
    const result = box.run("bootstrap.sh", ["production"], { BOOTSTRAP_STEPS: "secrets" });
    assert.equal(result.status, 0, result.output);
    const env = parseEnv(box.readEnv());
    assert.ok(GENERATED_KEYS.length >= 8);
    for (const key of GENERATED_KEYS) assert.match(env[key] ?? "", /^generated-secret-\d+$/, key);
    assert.equal(env.PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP, "", "organization map is left for the admin");
  });

  it("copies non-secret defaults such as PAPERCLIP_AUTH_DISABLE_SIGN_UP=false", () => {
    box.run("bootstrap.sh", ["production"], { BOOTSTRAP_STEPS: "secrets" });
    const env = parseEnv(box.readEnv());
    assert.ok(DEFAULT_KEYS.includes("PAPERCLIP_AUTH_DISABLE_SIGN_UP"));
    for (const key of DEFAULT_KEYS) assert.equal(env[key], EXAMPLE[key], key);
  });

  it("never overwrites existing values", () => {
    box.writeEnv("BETTER_AUTH_SECRET=keep-me\nPAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={\"acme\":\"x\"}\n");
    const result = box.run("bootstrap.sh", ["production"], { BOOTSTRAP_STEPS: "secrets" });
    assert.equal(result.status, 0, result.output);
    const env = parseEnv(box.readEnv());
    assert.equal(env.BETTER_AUTH_SECRET, "keep-me");
    assert.equal(env.PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP, "{\"acme\":\"x\"}");
    assert.match(env.POSTGRES_PASSWORD, /^generated-secret-\d+$/);
  });

  it("is idempotent", () => {
    box.run("bootstrap.sh", ["production"], { BOOTSTRAP_STEPS: "secrets" });
    const first = box.readEnv();
    box.run("bootstrap.sh", ["production"], { BOOTSTRAP_STEPS: "secrets" });
    assert.equal(box.readEnv(), first);
  });

  it("restricts the file to its owner", () => {
    box.run("bootstrap.sh", ["production"], { BOOTSTRAP_STEPS: "secrets" });
    const mode = fs.statSync(path.join(box.root, ".env")).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("never prints generated secrets", () => {
    const result = box.run("bootstrap.sh", ["production"], { BOOTSTRAP_STEPS: "secrets" });
    assert.ok(!/generated-secret-\d+/.test(result.output), result.output);
  });
});
