import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSandbox, sampleEnv } from "./helpers/sandbox.mjs";

// specs/003-first-run-setup: first-run.sh guides the operator through the
// first Keycloak admin, the Paperclip admin and company, the admin's own
// enterprise account, and linking the company to the Keycloak organization.

const CURRENT = "2222222222222222222222222222222222222222";
const KC_PASSWORD = "Kc-Admin#2026x";
const EMERGENCY = "Emergency#2026x";
const ENTERPRISE = "Enterprise#2026x";
const HEALTHY = { FAKE_HEALTH_BODY: '{"status":"ok"}' };
const UNLINKED_ENV = sampleEnv()
  .replace(/^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=.*$/m, "PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=")
  .replace(/^PAPERCLIP_AUTH_DISABLE_SIGN_UP=.*$/m, "PAPERCLIP_AUTH_DISABLE_SIGN_UP=false");

const lines = (...answers) => `${answers.join("\n")}\n`;
const FRESH_INPUT = lines(
  "ops-admin", KC_PASSWORD, KC_PASSWORD,
  "Ops Lead", "ops@example.cn", EMERGENCY, EMERGENCY,
  "FiveGuys",
  ENTERPRISE, ENTERPRISE,
  "y",
);

describe("first-run.sh: fresh instance (US1)", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(UNLINKED_ENV);
    box.writeState("current", CURRENT);
  });
  afterEach(() => box.cleanup());

  const run = (input = FRESH_INPUT, env = {}) => box.run("first-run.sh", ["production"], { ...HEALTHY, ...env }, input);

  it("creates the Keycloak admin, Paperclip admin, company and enterprise account, then links and redeploys", () => {
    const result = run();
    assert.equal(result.status, 0, result.output);
    const log = box.calls().join("\n");

    assert.match(log, /kcadm\.sh create users -r master .*username=ops-admin/);
    assert.match(log, /kcadm\.sh add-roles -r master --uusername ops-admin --rolename admin/);

    const signup = box.calls().find((c) => c.includes("/api/auth/sign-up/email"));
    const accept = box.calls().find((c) => c.includes("/api/invites/pcp_bootstrap_abc123/accept"));
    const company = box.calls().find((c) => c.includes("/api/companies"));
    assert.ok(signup && accept && company, log);
    for (const call of [signup, accept, company]) {
      assert.match(call, /--resolve agents\.example\.cn:443:127\.0\.0\.1/);
      assert.match(call, /Origin: https:\/\/agents\.example\.cn/);
    }
    assert.ok(log.indexOf("sign-up/email") < log.indexOf("/accept"));
    assert.ok(log.indexOf("/accept") < log.indexOf("/api/companies"));

    assert.match(log, /kcadm\.sh create users -r digital-workforce .*username=ops@example\.cn.*email=ops@example\.cn.*emailVerified=true/);
    // Keycloak 26 requires both names; without lastName the first sign-in stops at "verify profile".
    assert.match(log, /kcadm\.sh create users -r digital-workforce .*firstName=Ops.*lastName=Lead/);
    assert.match(log, /kcadm\.sh create organizations\/org-1\/members -r digital-workforce/);
    assert.equal(box.stateFile("kc-members").trim(), "id-realm-ops@example.cn");

    const env = box.readEnv();
    assert.match(env, /^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=\{"acme":"company-new"\}$/m);
    assert.match(env, /^PAPERCLIP_AUTH_DISABLE_SIGN_UP=true$/m);
    assert.match(env, /^BETTER_AUTH_SECRET=value-better-auth$/m, "other lines are kept");
    assert.equal(fs.statSync(path.join(box.root, ".env")).mode & 0o777, 0o600);

    assert.match(log, new RegExp(`remote-deploy\\.sh production ${CURRENT}`));
  });

  it("never prints or logs the passwords", () => {
    const result = run();
    assert.equal(result.status, 0, result.output);
    const log = box.calls().join("\n");
    for (const secret of [KC_PASSWORD, EMERGENCY, ENTERPRISE, "value-kc-admin"]) {
      assert.ok(!result.output.includes(secret), `printed ${secret}`);
      assert.ok(!log.includes(secret), `logged ${secret}`);
    }
    const stored = box.stateFiles()
      .filter((f) => f.startsWith("kc-password-") || f.startsWith("curl-body-"))
      .map((f) => box.stateFile(f))
      .join("\n");
    for (const secret of [KC_PASSWORD, EMERGENCY, ENTERPRISE]) assert.ok(stored.includes(secret), `${secret} passed on stdin`);
  });

  it("refuses an enterprise password equal to the emergency password", () => {
    const input = lines(
      "ops-admin", KC_PASSWORD, KC_PASSWORD,
      "Ops Lead", "ops@example.cn", EMERGENCY, EMERGENCY,
      "FiveGuys",
      EMERGENCY, EMERGENCY,
      ENTERPRISE, ENTERPRISE,
      "y",
    );
    const result = run(input);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /must differ from the emergency password/);
    assert.equal(box.stateFile("kc-password-id-realm-ops@example.cn"), JSON.stringify({ type: "password", value: ENTERPRISE, temporary: false }));
  });

  it("changes nothing when the operator does not confirm", () => {
    const result = run(FRESH_INPUT.replace(/y\n$/, "n\n"));
    assert.equal(result.status, 0, result.output);
    const log = box.calls().join("\n");
    assert.doesNotMatch(log, /create users|add-roles|sign-up|\/api\/companies|remote-deploy/);
    assert.equal(box.readEnv(), UNLINKED_ENV);
  });

  for (const [label, env] of [
    ["Keycloak is not ready", { FAKE_KEYCLOAK_READY: "0" }],
    ["Paperclip is not healthy", { FAKE_HEALTH_BODY: '{"status":"starting"}' }],
  ]) {
    it(`stops before any change when ${label}`, () => {
      const result = run(FRESH_INPUT, env);
      assert.equal(result.status, 1, result.output);
      assert.doesNotMatch(box.calls().join("\n"), /create users|sign-up|remote-deploy/);
      assert.equal(box.readEnv(), UNLINKED_ENV);
    });
  }

  it("asks for another email when the admin email is taken", () => {
    const result = run(`${FRESH_INPUT}ops2@example.cn\n`, { FAKE_SIGNUP_EMAIL_TAKEN: "1" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /already registered/);
    assert.match(box.calls().join("\n"), /create users -r digital-workforce .*email=ops2@example\.cn/);
  });
});

describe("first-run.sh: reruns and existing data (US2)", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(UNLINKED_ENV);
    box.writeState("current", CURRENT);
  });
  afterEach(() => box.cleanup());

  const run = (input, env = {}) => box.run("first-run.sh", ["production"], { ...HEALTHY, ...env }, input);
  const EXISTING_ADMIN = { FAKE_PC_ADMIN: "ops@example.cn|Ops Lead" };

  it("uses an existing Paperclip admin and company", () => {
    const result = run(lines("ops-admin", KC_PASSWORD, KC_PASSWORD, ENTERPRISE, ENTERPRISE, "y"),
      { ...EXISTING_ADMIN, FAKE_PC_COMPANIES: "c-1|FiveGuys" });
    assert.equal(result.status, 0, result.output);
    const log = box.calls().join("\n");
    assert.doesNotMatch(log, /sign-up|\/accept|\/api\/companies|auth bootstrap-ceo/);
    assert.match(result.output, /ops@example\.cn: exists/);
    assert.match(result.output, /FiveGuys/);
    assert.match(log, /create users -r digital-workforce .*email=ops@example\.cn/);
    assert.match(box.readEnv(), /^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=\{"acme":"c-1"\}$/m);
  });

  it("lets the operator pick one of several companies", () => {
    const result = run(lines("ops-admin", KC_PASSWORD, KC_PASSWORD, "2", ENTERPRISE, ENTERPRISE, "y"),
      { ...EXISTING_ADMIN, FAKE_PC_COMPANIES: "c-1|FiveGuys\\nc-2|Second Co" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /1\) FiveGuys/);
    assert.match(result.output, /2\) Second Co/);
    assert.match(box.readEnv(), /^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=\{"acme":"c-2"\}$/m);
  });

  it("keeps existing Keycloak accounts and their passwords", () => {
    const result = run(lines("ops-admin", "y"), {
      ...EXISTING_ADMIN,
      FAKE_PC_COMPANIES: "c-1|FiveGuys",
      FAKE_KC_MASTER_ADMIN: "ops-admin",
      FAKE_KC_REALM_USER: "ops@example.cn",
    });
    assert.equal(result.status, 0, result.output);
    const log = box.calls().join("\n");
    assert.doesNotMatch(log, /create users|reset-password|add-roles/);
    assert.match(log, /create organizations\/org-1\/members -r digital-workforce/, "makes sure the admin is an organization member");
    assert.match(log, /remote-deploy\.sh/);
  });

  it("reports done without redeploying when everything is in place", () => {
    box.writeEnv(sampleEnv()
      .replace(/^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=.*$/m, 'PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={"acme":"c-1"}')
      .replace(/^PAPERCLIP_AUTH_DISABLE_SIGN_UP=.*$/m, "PAPERCLIP_AUTH_DISABLE_SIGN_UP=true"));
    const result = run(lines("ops-admin"), {
      ...EXISTING_ADMIN,
      FAKE_PC_COMPANIES: "c-1|FiveGuys",
      FAKE_KC_MASTER_ADMIN: "ops-admin",
      FAKE_KC_REALM_USER: "ops@example.cn",
      FAKE_KC_REALM_MEMBER: "id-realm-ops@example.cn",
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Nothing to do/);
    assert.doesNotMatch(box.calls().join("\n"), /remote-deploy|create /);
  });

  it("stops when email sign-up is off and there is no Paperclip admin yet", () => {
    box.writeEnv(UNLINKED_ENV.replace(/^PAPERCLIP_AUTH_DISABLE_SIGN_UP=.*$/m, "PAPERCLIP_AUTH_DISABLE_SIGN_UP=true"));
    const result = run(FRESH_INPUT);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /PAPERCLIP_AUTH_DISABLE_SIGN_UP/);
    assert.doesNotMatch(box.calls().join("\n"), /create users|sign-up|remote-deploy/);
  });

  it("continues after a failed run", () => {
    const first = run(FRESH_INPUT, { FAKE_COMPANY_CREATE_FAIL: "1" });
    assert.equal(first.status, 1, first.output);
    assert.match(first.output, /creating the company failed/);
    const before = box.calls().length;

    const second = run(lines("ops-admin", "FiveGuys", ENTERPRISE, ENTERPRISE, "y"));
    assert.equal(second.status, 0, second.output);
    const rerun = box.calls().slice(before).join("\n");
    assert.doesNotMatch(rerun, /create users -r master|sign-up|\/accept/);
    assert.match(rerun, /\/api\/companies/);
    assert.match(box.readEnv(), /^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=\{"acme":"company-new"\}$/m);
  });
});
