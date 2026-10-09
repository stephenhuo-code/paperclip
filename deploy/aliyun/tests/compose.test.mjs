import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEPLOY_SRC, sampleEnv } from "./helpers/sandbox.mjs";

// Contract: specs/001-keycloak-sso-aliyun/contracts/deployment.md §3 and §5.
const REQUIRED_PAPERCLIP_ENV = [
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_PUBLIC_URL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_AUTH_OIDC_ISSUER",
  "PAPERCLIP_AUTH_OIDC_CLIENT_ID",
  "PAPERCLIP_AUTH_OIDC_CLIENT_SECRET",
  "PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP",
  "PAPERCLIP_AUTH_OIDC_LABEL",
  "PAPERCLIP_AUTH_SESSION_TTL_SECONDS",
  "PAPERCLIP_AUTH_DISABLE_SIGN_UP",
  "PAPERCLIP_ANNOUNCEMENTS_ENABLED",
  "PAPERCLIP_TELEMETRY_DISABLED",
  "NPM_CONFIG_REGISTRY",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];
const LONG_RUNNING = ["caddy", "paperclip", "keycloak", "postgres"];

function envKeys(service) {
  return Object.keys(service.environment ?? {});
}

describe("docker-compose.yml", () => {
  let config;

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-compose-test-"));
    const secrets = path.join(dir, ".env");
    fs.writeFileSync(secrets, sampleEnv());
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--project-directory", DEPLOY_SRC,
        "-f", path.join(DEPLOY_SRC, "docker-compose.yml"),
        "--env-file", path.join(DEPLOY_SRC, "environments", "production.env"),
        "--env-file", secrets,
        "--profile", "provision",
        "config", "--format", "json",
      ],
      { encoding: "utf8", env: { ...process.env, PAPERCLIP_IMAGE_TAG: "2222222222222222222222222222222222222222" } },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(result.status, 0, `docker compose config failed:\n${result.stderr}`);
    config = JSON.parse(result.stdout);
  });

  it("defines the four long-running services and the one-shot Keycloak provisioning job", () => {
    assert.deepEqual(Object.keys(config.services).sort(), ["caddy", "keycloak", "keycloak-config", "paperclip", "postgres"]);
  });

  it("publishes ports only on caddy (80 and 443)", () => {
    for (const [name, service] of Object.entries(config.services)) {
      const published = (service.ports ?? []).map((port) => String(port.published));
      if (name === "caddy") assert.deepEqual(published.sort(), ["443", "80"]);
      else assert.deepEqual(published, [], `${name} must not publish ports`);
    }
  });

  it("restarts long-running services and runs keycloak-config once, only on demand", () => {
    for (const name of LONG_RUNNING) assert.equal(config.services[name].restart, "unless-stopped", name);
    assert.equal(config.services["keycloak-config"].restart, "no");
    assert.deepEqual(config.services["keycloak-config"].profiles, ["provision"]);
  });

  it("pulls every image from the ACR VPC endpoint", () => {
    for (const [name, service] of Object.entries(config.services)) {
      assert.match(service.image, /^registry-vpc\.cn-hangzhou\.aliyuncs\.com\/digital-workforce\//, name);
    }
    assert.match(config.services.paperclip.image, /paperclip:2222222222222222222222222222222222222222$/);
    assert.equal(config.services["keycloak-config"].image, config.services.keycloak.image);
  });

  it("gives paperclip every variable from the deployment contract", () => {
    const keys = envKeys(config.services.paperclip);
    for (const key of REQUIRED_PAPERCLIP_ENV) assert.ok(keys.includes(key), `missing ${key}`);
    const env = config.services.paperclip.environment;
    assert.equal(env.PAPERCLIP_DEPLOYMENT_MODE, "authenticated");
    assert.equal(env.PAPERCLIP_DEPLOYMENT_EXPOSURE, "public");
    assert.equal(env.PAPERCLIP_PUBLIC_URL, "https://agents.example.cn");
    assert.equal(env.PAPERCLIP_AUTH_OIDC_ISSUER, "https://sso.example.cn/realms/digital-workforce");
    assert.equal(env.PAPERCLIP_AUTH_SESSION_TTL_SECONDS, "86400");
    assert.equal(env.PAPERCLIP_ANNOUNCEMENTS_ENABLED, "false");
  });

  it("keeps better-auth rate limiting on in production", () => {
    // Empty means "use the default", which is enabled in authenticated mode.
    assert.equal(config.services.paperclip.environment.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED, "");
  });

  it("never passes ANTHROPIC_* variables to any service", () => {
    for (const [name, service] of Object.entries(config.services)) {
      assert.deepEqual(envKeys(service).filter((key) => key.startsWith("ANTHROPIC_")), [], name);
    }
    const example = fs.readFileSync(path.join(DEPLOY_SRC, "env.example"), "utf8");
    assert.ok(!/^\s*ANTHROPIC_/m.test(example), "env.example must not define ANTHROPIC_* keys");
  });

  it("does not expose the Keycloak management port", () => {
    assert.deepEqual(config.services.keycloak.ports ?? [], []);
    assert.equal(config.services.keycloak.environment.KC_HEALTH_ENABLED, "true");
    assert.equal(config.services.keycloak.environment.KC_PROXY_HEADERS, "xforwarded");
    assert.equal(config.services.keycloak.environment.KC_HOSTNAME, "https://sso.example.cn");
  });

  it("lets containers reach both public domains through caddy", () => {
    const aliases = Object.values(config.services.caddy.networks ?? {}).flatMap((network) => network?.aliases ?? []);
    assert.ok(aliases.includes("agents.example.cn"));
    assert.ok(aliases.includes("sso.example.cn"));
  });

  it("persists data in named volumes", () => {
    const targets = (service) => (service.volumes ?? []).filter((v) => v.type === "volume").map((v) => `${v.source}:${v.target}`);
    assert.ok(targets(config.services.paperclip).includes("paperclip-data:/paperclip"));
    assert.ok(targets(config.services.postgres).some((t) => t.startsWith("pgdata:")));
    assert.ok(targets(config.services.caddy).some((t) => t.startsWith("caddy-data:")));
  });

  it("never mounts Caddy's data (TLS private keys) into another service", () => {
    for (const [name, service] of Object.entries(config.services)) {
      if (name === "caddy") continue;
      const sources = (service.volumes ?? []).map((v) => v.source);
      assert.ok(!sources.includes("caddy-data") && !sources.includes("caddy-config"), name);
    }
  });

  it("keeps the paperclip pid limit from the upstream compose file", () => {
    assert.equal(config.services.paperclip.pids_limit, 2048);
  });
});
