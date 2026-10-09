// End-to-end SSO check against the local Keycloak (18080) and Paperclip (3199).
// Usage: node e2e.mjs setup   -> break-glass admin, claim, company, fail-closed check
//        node e2e.mjs verify <companyId>
//        node e2e.mjs signup-disabled   (server started with PAPERCLIP_AUTH_DISABLE_SIGN_UP=true)
import { execFileSync } from "node:child_process";

const APP = "http://localhost:3199";
const ORIGIN = { Origin: APP };
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function sql(query) {
  return execFileSync("docker", [
    "exec", "pc-sso-e2e-postgres", "psql", "-U", "postgres", "-d", "paperclip", "-tA", "-c", query,
  ]).toString().trim();
}

function kc(...args) {
  return execFileSync("docker", ["exec", "pc-sso-e2e-keycloak", "/opt/keycloak/bin/kcadm.sh", ...args]).toString().trim();
}

class Browser {
  constructor() {
    this.jar = new Map(); // host -> Map(name -> value)
  }
  cookieHeader(url) {
    const cookies = this.jar.get(new URL(url).host);
    return cookies ? [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") : "";
  }
  store(url, res) {
    const host = new URL(url).host;
    const cookies = this.jar.get(host) ?? new Map();
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || value === "";
      if (expired) cookies.delete(name);
      else cookies.set(name, value);
    }
    this.jar.set(host, cookies);
  }
  async request(url, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    const cookie = this.cookieHeader(url);
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    this.store(url, res);
    return res;
  }
  async json(path, method = "GET", body) {
    const res = await this.request(`${APP}${path}`, {
      method,
      headers: { ...ORIGIN, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
}

/** Runs the full browser-style OIDC login. Returns the final app redirect target. */
async function ssoLogin(browser, username, password = "Passw0rd!") {
  const started = Date.now();
  const start = await browser.json("/api/auth/sign-in/social", "POST", {
    provider: "keycloak",
    callbackURL: "/",
    errorCallbackURL: "/auth",
  });
  if (start.status !== 200 || !start.data?.url) throw new Error(`sign-in/social failed: ${start.status} ${JSON.stringify(start.data)}`);

  let res = await browser.request(start.data.url);
  while (res.status >= 300 && res.status < 400) res = await browser.request(new URL(res.headers.get("location"), start.data.url).toString());
  let html = await res.text();
  let location = null;
  for (let step = 0; step < 4 && !location; step += 1) {
    const action = html.match(/id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    if (!action) {
      const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`Keycloak login form not found: ${text}`);
    }
    // Organization-enabled realms use identity-first login: username page, then password page.
    const fields = { username, credentialId: "" };
    if (/name="password"/.test(html)) fields.password = password;
    res = await browser.request(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    location = res.headers.get("location");
    if (!location) html = await res.text();
  }
  if (!location) throw new Error("Keycloak did not redirect after login");

  // Follow back into Paperclip until we leave the auth callback.
  let target = location;
  for (let hops = 0; hops < 5 && target.startsWith(APP); hops += 1) {
    const step = await browser.request(target, { headers: ORIGIN });
    const next = step.headers.get("location");
    if (!next) break;
    target = new URL(next, APP).toString();
    if (!target.includes("/api/auth/")) break;
  }
  return { target, ms: Date.now() - started };
}

async function setup() {
  const admin = new Browser();
  const existingAdmin = sql("select count(*) from \"user\" where email='admin@example.cn'") !== "0";
  const adminAuth = existingAdmin
    ? await admin.json("/api/auth/sign-in/email", "POST", { email: "admin@example.cn", password: "BreakGlass#2026" })
    : await admin.json("/api/auth/sign-up/email", "POST", {
        name: "Break Glass Admin",
        email: "admin@example.cn",
        password: "BreakGlass#2026",
      });
  check("break-glass admin has an email and password session", adminAuth.status === 200, `status ${adminAuth.status}`);
  const claim = await admin.json("/api/bootstrap/claim", "POST", {});
  check("break-glass admin owns the instance", claim.status === 200 || (existingAdmin && claim.status === 409), `status ${claim.status}`);
  let companyId = sql("select id from companies where name='Acme Digital Workforce' limit 1");
  if (!companyId) {
    const company = await admin.json("/api/companies", "POST", { name: "Acme Digital Workforce" });
    check("admin creates the first company", company.status === 201, `status ${company.status}`);
    companyId = company.data?.id;
  }

  const early = new Browser();
  const login = await ssoLogin(early, "user-a");
  check(
    "with no organization map, every SSO login is rejected (fail closed)",
    login.target.includes("error=org_not_allowed"),
    login.target,
  );
  check("rejected login creates no user", sql("select count(*) from \"user\" where email='a@example.cn'") === "0");

  // Local-only account whose email Keycloak has not verified (used by verify for FR-010).
  if (sql("select count(*) from \"user\" where email='local@example.cn'") === "0") {
    const local = new Browser();
    const created = await local.json("/api/auth/sign-up/email", "POST", {
      name: "Local Only",
      email: "local@example.cn",
      password: "LocalOnly#2026",
    });
    check("a local-only account exists for the unverified-email linking check", created.status === 200, `status ${created.status}`);
  }

  console.log(`COMPANY_ID=${companyId}`);
}

async function verify(companyId) {
  const a = new Browser();
  const loginA = await ssoLogin(a, "user-a");
  check("user A completes SSO login", loginA.target === `${APP}/`, loginA.target);
  check("SSO login finishes within 30 seconds (SC-001)", loginA.ms < 30_000, `${loginA.ms} ms`);
  const sessionA = await a.json("/api/auth/get-session");
  check("user A has a session", sessionA.data?.user?.email === "a@example.cn");
  const userA = sessionA.data?.user?.id;

  const b = new Browser();
  const loginB = await ssoLogin(b, "user-b");
  check("user B completes SSO login", loginB.target === `${APP}/`, loginB.target);
  const userB = (await b.json("/api/auth/get-session")).data?.user?.id;

  const memberships = sql(
    `select principal_id || ':' || membership_role || ':' || status from company_memberships where company_id='${companyId}' and principal_id in ('${userA}','${userB}') order by principal_id`,
  ).split("\n").filter(Boolean);
  check("A and B joined the mapped company as active operators", memberships.length === 2 && memberships.every((m) => m.endsWith(":operator:active")), memberships.join(" | "));

  const grants = sql(`select count(*) from principal_permission_grants where company_id='${companyId}' and principal_id='${userA}'`);
  check("SSO join wrote the default operator grants", Number(grants) > 0, `${grants} grants`);

  const companiesA = await a.json("/api/companies");
  check("user A sees the company through the API", Array.isArray(companiesA.data) && companiesA.data.some((c) => c.id === companyId));

  const joinedLogs = sql(`select count(*) from activity_log where company_id='${companyId}' and action='company_membership.sso_joined'`);
  check("one sso_joined activity entry per new member", joinedLogs === "2", joinedLogs);

  const c = new Browser();
  const loginC = await ssoLogin(c, "user-c");
  check("user C (outside the organization) is rejected with org_not_allowed", loginC.target.includes("error=org_not_allowed"), loginC.target);
  check("rejected user C has no platform account", sql("select count(*) from \"user\" where email='c@outside.cn'") === "0");

  // FR-006: a role set in Paperclip survives the next SSO login.
  sql(`update company_memberships set membership_role='admin' where company_id='${companyId}' and principal_id='${userB}'`);
  const b2 = new Browser();
  await ssoLogin(b2, "user-b");
  const roleB = sql(`select membership_role from company_memberships where company_id='${companyId}' and principal_id='${userB}'`);
  check("B stays admin after logging in again (role not overwritten)", roleB === "admin", roleB);
  const logsAfter = sql(`select count(*) from activity_log where company_id='${companyId}' and action='company_membership.sso_joined'`);
  check("re-login writes no extra sso_joined entries", logsAfter === "2", logsAfter);

  // FR-005: profile changes in Keycloak sync on the next login.
  const kcUserA = kc("get", "users", "-r", "dw", "-q", "username=user-a", "--fields", "id", "--format", "csv", "--noquotes");
  kc("update", `users/${kcUserA}`, "-r", "dw", "-s", "firstName=Alicia");
  const a2 = new Browser();
  await ssoLogin(a2, "user-a");
  const nameA = sql(`select name from "user" where id='${userA}'`);
  check("Keycloak name change syncs on next login (FR-005)", nameA.startsWith("Alicia"), nameA);

  // FR-007: sign-out succeeds and ends the session.
  const signOut = await a.json("/api/auth/sign-out", "POST", {});
  check("sign-out returns success", signOut.status === 200, `status ${signOut.status}`);
  const afterSignOut = await a.json("/api/auth/get-session");
  check("session is gone after sign-out", !afterSignOut.data?.user);

  // FR-008: removing A from the organization blocks the next login.
  const orgId = kc("get", "organizations", "-r", "dw", "--fields", "id", "--format", "csv", "--noquotes");
  kc("delete", `organizations/${orgId}/members/${kcUserA}`, "-r", "dw");
  const a3 = new Browser();
  const loginA3 = await ssoLogin(a3, "user-a");
  check("A is rejected after removal from the organization (FR-008)", loginA3.target.includes("error=org_not_allowed"), loginA3.target);
  kc("create", `organizations/${orgId}/members`, "-r", "dw", "-b", `"${kcUserA}"`);

  // SC-004: sessions last 24 hours.
  const ttl = Number(sql(`select extract(epoch from expires_at - created_at)::int from session where user_id='${userB}' order by created_at desc limit 1`));
  check("session lifetime is 24 hours (SC-004)", Math.abs(ttl - 86400) <= 60, `${ttl} s`);

  // FR-010: a verified Keycloak email links to the existing local account.
  const adminId = sql("select id from \"user\" where email='admin@example.cn'");
  const ops = new Browser();
  const opsLogin = await ssoLogin(ops, "ops-admin");
  const opsUser = (await ops.json("/api/auth/get-session")).data?.user?.id;
  check("verified Keycloak email links to the break-glass admin's account (FR-010)", opsLogin.target === `${APP}/` && opsUser === adminId, `${opsLogin.target} user=${opsUser}`);
  check("break-glass admin still has exactly one user row", sql("select count(*) from \"user\" where email='admin@example.cn'") === "1");

  // FR-010: an unverified Keycloak email does not take over a local account.
  const localId = sql("select id from \"user\" where email='local@example.cn'");
  const lou = new Browser();
  const louLogin = await ssoLogin(lou, "local-user");
  check("unverified Keycloak email is not linked to the local account", louLogin.target.includes("error=") && !louLogin.target.endsWith(`${APP}/`), louLogin.target);
  check("local account has no Keycloak link", sql(`select count(*) from account where user_id='${localId}' and provider_id='keycloak'`) === "0");

  // FR-009: break-glass admin still signs in with a password.
  const admin = new Browser();
  const adminLogin = await admin.json("/api/auth/sign-in/email", "POST", { email: "admin@example.cn", password: "BreakGlass#2026" });
  check("break-glass admin still signs in with a password", adminLogin.status === 200, `status ${adminLogin.status}`);
}

/** Run with PAPERCLIP_AUTH_DISABLE_SIGN_UP=true on the server. */
async function signupDisabled() {
  const stranger = new Browser();
  const signUp = await stranger.json("/api/auth/sign-up/email", "POST", {
    name: "Stranger",
    email: "stranger@example.cn",
    password: "Stranger#2026",
  });
  check("email sign-up is refused once sign-up is disabled", signUp.status >= 400, `status ${signUp.status}`);
  const d = new Browser();
  const loginD = await ssoLogin(d, "user-d");
  check("a new organization member can still join through SSO", loginD.target === `${APP}/`, loginD.target);
  const admin = new Browser();
  const adminLogin = await admin.json("/api/auth/sign-in/email", "POST", { email: "admin@example.cn", password: "BreakGlass#2026" });
  check("break-glass admin password sign-in still works", adminLogin.status === 200, `status ${adminLogin.status}`);
}

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === "setup") await setup();
  else if (mode === "verify") await verify(arg);
  else if (mode === "signup-disabled") await signupDisabled();
  else throw new Error("usage: node e2e.mjs setup | verify <companyId>");
} catch (error) {
  check("e2e script ran without errors", false, error instanceof Error ? error.message : String(error));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
