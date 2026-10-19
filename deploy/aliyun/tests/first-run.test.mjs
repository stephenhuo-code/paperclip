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
    assert.match(env, /^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=\{"acme":"company-new-1"\}$/m);
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
    assert.match(box.readEnv(), /^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=\{"acme":"company-new-1"\}$/m);
  });
});

// specs/004-first-run-add-org: `first-run.sh <env> --add-org` adds another
// Keycloak organization and its Paperclip company to the mapping.

const SYNC_PASSWORD = "value-sync-password";
const ADDED_ENV = sampleEnv([
  "PAPERCLIP_SYNC_EMAIL=ops@example.cn",
  `PAPERCLIP_SYNC_PASSWORD=${SYNC_PASSWORD}`,
].join("\n"))
  .replace(/^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=.*$/m, 'PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={"acme":"c-1"}')
  .replace(/^PAPERCLIP_AUTH_DISABLE_SIGN_UP=.*$/m, "PAPERCLIP_AUTH_DISABLE_SIGN_UP=true")
  .concat("\n");
const INITIALIZED = {
  ...HEALTHY,
  FAKE_PC_ADMIN: "ops@example.cn|Ops Lead",
  FAKE_PC_COMPANIES: "c-1|FiveGuys",
};
// Alias, organization name, email domain, company name, confirmation.
const ADD_INPUT = lines("beta", "Beta Inc", "beta.example.cn", "Beta", "y");
const mapOf = (env) => env.match(/^PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP=(.*)$/m)?.[1];

describe("first-run.sh --add-org: new organization and company (US1)", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(ADDED_ENV);
    box.writeState("current", CURRENT);
  });
  afterEach(() => box.cleanup());

  const run = (input = ADD_INPUT, env = {}) => box.run("first-run.sh", ["production", "--add-org"], { ...INITIALIZED, ...env }, input);
  const changes = /create organizations|sign-in|\/api\/companies|remote-deploy/;

  it("creates the organization and company, adds the mapping and redeploys", () => {
    const result = run();
    assert.equal(result.status, 0, result.output);
    const log = box.calls().join("\n");

    assert.match(log, /kcadm\.sh create organizations -r digital-workforce -s name=Beta Inc -s alias=beta -s enabled=true -s domains=\[\{"name":"beta\.example\.cn"\}\]/);
    const signIn = box.calls().find((c) => c.includes("/api/auth/sign-in/email"));
    const company = box.calls().find((c) => c.includes("/api/companies"));
    assert.ok(signIn && company, log);
    assert.ok(log.indexOf("sign-in/email") < log.indexOf("/api/companies"));
    assert.equal(box.stateFile("pc-companies").trim(), "company-new-1|Beta");
    const bodies = box.stateFiles().filter((f) => f.startsWith("curl-body-")).map((f) => box.stateFile(f));
    assert.ok(bodies.includes(JSON.stringify({ email: "ops@example.cn", password: SYNC_PASSWORD })), bodies.join("\n"));
    assert.doesNotMatch(result.output, /password:/i, "does not ask for a password");

    const env = box.readEnv();
    assert.equal(mapOf(env), '{"acme":"c-1","beta":"company-new-1"}');
    assert.equal(env, ADDED_ENV.replace(mapOf(ADDED_ENV), '{"acme":"c-1","beta":"company-new-1"}'), "other lines are kept");
    assert.equal(fs.statSync(path.join(box.root, ".env")).mode & 0o777, 0o600);
    assert.match(log, new RegExp(`remote-deploy\\.sh production ${CURRENT}`));

    assert.match(result.output, /organization 'beta'/);
    assert.match(result.output, /Settings → Members/);
    assert.match(result.output, /Connectors → Browse → Messages API → Connect, Provider URL https:\/\/llm\.example\.cn/);
    assert.match(result.output, /https:\/\/llm\.example\.cn/);
  });

  it("never prints or logs the write-back password", () => {
    const result = run();
    assert.equal(result.status, 0, result.output);
    assert.ok(!result.output.includes(SYNC_PASSWORD));
    assert.ok(!box.calls().join("\n").includes(SYNC_PASSWORD));
  });

  it("changes nothing when the operator does not confirm", () => {
    const result = run(ADD_INPUT.replace(/y\n$/, "n\n"));
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(box.calls().join("\n"), changes);
    assert.equal(box.readEnv(), ADDED_ENV);
  });

  it("asks again for an invalid alias and refuses the first organization's alias", () => {
    const result = run(lines("Beta_1", "", "acme", "beta", "Beta Inc", "beta.example.cn", "Beta", "y"));
    assert.equal(result.status, 0, result.output);
    assert.equal((result.output.match(/lowercase letters, digits and -/g) ?? []).length, 2, result.output);
    assert.match(result.output, /'acme' is the first organization/);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"company-new-1"}');
  });

  it("warns when the alias already maps to another company and replaces it", () => {
    box.writeEnv(ADDED_ENV.replace(mapOf(ADDED_ENV), '{"acme":"c-1","beta":"c-9"}'));
    const result = run();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /'beta' is linked to another company \(c-9\); it will be replaced/);
    assert.match(result.output, /This will:[\s\S]*replace/);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"company-new-1"}');
  });

  it("asks for the emergency password when the .env has no write-back account", () => {
    const env = ADDED_ENV.replace(/^PAPERCLIP_SYNC_(EMAIL|PASSWORD)=.*\n?/gm, "");
    box.writeEnv(env);
    const result = run(`${ADD_INPUT}${EMERGENCY}\n`, { FAKE_SIGNIN_PASSWORD: EMERGENCY });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Emergency password for ops@example\.cn/);
    assert.ok(!result.output.includes(EMERGENCY) && !box.calls().join("\n").includes(EMERGENCY));
    const bodies = box.stateFiles().filter((f) => f.startsWith("curl-body-")).map((f) => box.stateFile(f));
    assert.ok(bodies.includes(JSON.stringify({ email: "ops@example.cn", password: EMERGENCY })));
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"company-new-1"}');
  });

  it("falls back to the emergency password when the write-back account cannot sign in", () => {
    const result = run(`${ADD_INPUT}${EMERGENCY}\n`, { FAKE_SIGNIN_PASSWORD: EMERGENCY });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /write-back account .*could not sign in/);
    assert.match(result.output, /Emergency password for ops@example\.cn/);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"company-new-1"}');
  });

  it("stops after three wrong emergency passwords without changing anything", () => {
    const result = run(`${ADD_INPUT}wrong-1\nwrong-2\nwrong-3\n`, { FAKE_SIGNIN_FAIL: "1" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /sign-in failed 3 times/i);
    const log = box.calls().join("\n");
    assert.doesNotMatch(log, /create organizations|\/api\/companies|remote-deploy/);
    assert.equal(box.readEnv(), ADDED_ENV);
    for (const pw of ["wrong-1", "wrong-2", "wrong-3"]) assert.ok(!result.output.includes(pw) && !log.includes(pw));
  });

  for (const [label, env, setup, message] of [
    ["Keycloak is not ready", { FAKE_KEYCLOAK_READY: "0" }, null, /Keycloak is not ready/],
    ["Paperclip is not healthy", { FAKE_HEALTH_BODY: '{"status":"starting"}' }, null, /not healthy/],
    ["there is no Paperclip admin", { FAKE_PC_ADMIN: "" }, null, /run first-run\.sh production first/],
    ["the first organization is not linked", {}, (e) => e.replace(mapOf(e), '{"other":"c-2"}'), /run first-run\.sh production first/],
    ["the mapping cannot be parsed", {}, (e) => e.replace(mapOf(e), '{"acme":}'), /cannot be parsed/],
  ]) {
    it(`stops before any change when ${label}`, () => {
      const before = setup ? setup(ADDED_ENV) : ADDED_ENV;
      box.writeEnv(before);
      const result = run(ADD_INPUT, env);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, message);
      assert.doesNotMatch(box.calls().join("\n"), changes);
      assert.equal(box.readEnv(), before);
    });
  }

  it("rejects unknown arguments", () => {
    const result = box.run("first-run.sh", ["production", "--bogus"], INITIALIZED, "");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /usage: first-run\.sh <env> \[--add-org\]/);
  });
});

describe("first-run.sh --add-org: reruns and existing data (US2)", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeEnv(ADDED_ENV);
    box.writeState("current", CURRENT);
  });
  afterEach(() => box.cleanup());

  const run = (input, env = {}) => box.run("first-run.sh", ["production", "--add-org"], { ...INITIALIZED, ...env }, input);
  const BETA_ORG = { FAKE_KC_ORGS: "org-1,acme\\norg-2,beta" };
  const BETA_COMPANY = { FAKE_PC_COMPANIES: "c-1|FiveGuys\\nc-2|Beta" };

  it("uses an existing Keycloak organization without asking for its name or domain", () => {
    const result = run(lines("beta", "Beta", "y"), BETA_ORG);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Organization 'beta': exists/);
    assert.doesNotMatch(result.output, /Organization name|Email domain/);
    assert.doesNotMatch(box.calls().join("\n"), /create organizations/);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"company-new-1"}');
  });

  it("lets the operator use an existing company with the same name", () => {
    const result = run(lines("beta", "Beta", "1", "y"), { ...BETA_ORG, ...BETA_COMPANY });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /1\) use the existing company 'Beta' \(c-2\)/);
    assert.match(result.output, /2\) create a new company 'Beta'/);
    const log = box.calls().join("\n");
    assert.doesNotMatch(log, /sign-in|\/api\/companies/);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"c-2"}');
    assert.match(log, /remote-deploy\.sh/);
  });

  it("creates a new company when the operator asks for one despite the same name", () => {
    const result = run(lines("beta", "Beta", "2", "y"), { ...BETA_ORG, ...BETA_COMPANY });
    assert.equal(result.status, 0, result.output);
    assert.match(box.calls().join("\n"), /\/api\/companies/);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"company-new-1"}');
  });

  it("reports done without redeploying when the alias already maps to the chosen company", () => {
    box.writeEnv(ADDED_ENV.replace(mapOf(ADDED_ENV), '{"acme":"c-1","beta":"c-2"}'));
    const result = run(lines("beta", "Beta", "1"), { ...BETA_ORG, ...BETA_COMPANY });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Nothing to do/);
    assert.doesNotMatch(box.calls().join("\n"), /create organizations|sign-in|\/api\/companies|remote-deploy/);
  });

  it("keeps the new organization when the company cannot be created, and continues on the next run", () => {
    const first = run(lines("beta", "Beta Inc", "beta.example.cn", "Beta", "y"), { FAKE_COMPANY_CREATE_FAIL: "1" });
    assert.equal(first.status, 1, first.output);
    assert.match(first.output, /creating the company failed/);
    assert.equal(box.readEnv(), ADDED_ENV);
    const before = box.calls().length;

    const second = run(lines("beta", "Beta", "y"));
    assert.equal(second.status, 0, second.output);
    const rerun = box.calls().slice(before).join("\n");
    assert.doesNotMatch(rerun, /create organizations/);
    assert.match(rerun, /\/api\/companies/);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"company-new-1"}');
  });

  it("stops when the email domain belongs to another organization", () => {
    const result = run(lines("beta", "Beta Inc", "example.cn", "Beta", "y"), { FAKE_KC_ORG_DOMAIN_TAKEN: "1" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /domain example\.cn is already used by another organization/);
    assert.doesNotMatch(box.calls().join("\n"), /\/api\/companies|remote-deploy/);
    assert.equal(box.readEnv(), ADDED_ENV);
  });
});

describe("first-run.sh: keeps the other organizations' links (US3, spec 004)", () => {
  let box;
  beforeEach(() => {
    box = createSandbox();
    box.writeState("current", CURRENT);
  });
  afterEach(() => box.cleanup());

  const ALL_IN_PLACE = {
    ...HEALTHY,
    FAKE_PC_ADMIN: "ops@example.cn|Ops Lead",
    FAKE_PC_COMPANIES: "c-1|FiveGuys\\nc-2|Beta",
    FAKE_KC_MASTER_ADMIN: "ops-admin",
    FAKE_KC_REALM_USER: "ops@example.cn",
    FAKE_KC_REALM_MEMBER: "id-realm-ops@example.cn",
  };
  const withMap = (map) => ADDED_ENV.replace(mapOf(ADDED_ENV), map);

  it("updates only the first organization's link", () => {
    box.writeEnv(withMap('{"acme":"c-9","beta":"c-2"}'));
    const result = box.run("first-run.sh", ["production"], ALL_IN_PLACE, lines("ops-admin", "1", "y"));
    assert.equal(result.status, 0, result.output);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"c-2"}');
    assert.match(box.calls().join("\n"), /remote-deploy\.sh/);
  });

  it("reports done when the first organization is linked, whatever else is mapped", () => {
    box.writeEnv(withMap('{"acme":"c-1","beta":"c-2"}'));
    const result = box.run("first-run.sh", ["production"], ALL_IN_PLACE, lines("ops-admin", "1"));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Nothing to do/);
    assert.doesNotMatch(box.calls().join("\n"), /remote-deploy|create /);
    assert.equal(mapOf(box.readEnv()), '{"acme":"c-1","beta":"c-2"}');
  });
});
