import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEPLOY_SRC, PRODUCTION_ENV_FIXTURE, sampleEnv } from "./helpers/sandbox.mjs";

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
const LONG_RUNNING = ["caddy", "paperclip", "keycloak", "postgres", "litellm", "gateway-sync"];

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
        "--env-file", PRODUCTION_ENV_FIXTURE,
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

  it("defines the long-running services and the one-shot Keycloak provisioning job", () => {
    assert.deepEqual(Object.keys(config.services).sort(), ["caddy", "gateway-sync", "keycloak", "keycloak-config", "litellm", "paperclip", "postgres"]);
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
    assert.ok(aliases.includes("llm.example.cn"), "Paperclip reaches the model gateway over HTTPS through caddy");
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

  it("brands the Paperclip and Keycloak sign-in pages", () => {
    const paperclip = config.services.paperclip.environment;
    assert.equal(paperclip.PAPERCLIP_BRAND_NAME, "Acme 数字员工平台");
    assert.equal(paperclip.PAPERCLIP_BRAND_LOGO_URL, "https://agents.example.cn/brand/logo.png");
    const provision = config.services["keycloak-config"].environment;
    assert.equal(provision.KEYCLOAK_DISPLAY_NAME, "Acme 数字员工平台");
    assert.equal(provision.KEYCLOAK_DISPLAY_LOGO_URL, "https://agents.example.cn/brand/logo.png");
    const brandMount = config.services.caddy.volumes.find((v) => v.target === "/srv/brand");
    assert.ok(brandMount, "caddy serves the branding directory");
    assert.equal(brandMount.read_only, true);
    assert.match(brandMount.source, /branding$/);
  });

  it("serves /brand/ from the branding directory before proxying to Paperclip", () => {
    const caddyfile = fs.readFileSync(path.join(DEPLOY_SRC, "Caddyfile"), "utf8");
    const app = caddyfile.slice(caddyfile.indexOf("{$APP_DOMAIN} {"), caddyfile.indexOf("{$SSO_DOMAIN} {"));
    assert.match(app, /handle_path \/brand\/\* \{[^}]*root \* \/srv\/brand[^}]*file_server[^}]*\}/s);
    assert.match(app, /handle \{[^}]*reverse_proxy paperclip:3100[^}]*\}/s);
  });

  it("keeps the paperclip pid limit from the upstream compose file", () => {
    assert.equal(config.services.paperclip.pids_limit, 2048);
  });

  // specs/006-litellm-gateway-billing
  describe("model gateway (LiteLLM)", () => {
    it("runs the mirrored LiteLLM image with its config and hooks, models kept in its own database", () => {
      const litellm = config.services.litellm;
      assert.match(litellm.image, /\/litellm:1\.105\.1$/);
      assert.deepEqual(litellm.command, ["--config", "/app/config.yaml", "--port", "4000"]);
      const mounts = Object.fromEntries((litellm.volumes ?? []).map((v) => [v.target, v]));
      for (const [target, file] of [["/app/config.yaml", "litellm/config.yaml"], ["/app/hooks.py", "litellm/hooks.py"]]) {
        assert.ok(mounts[target], `mounts ${target}`);
        assert.equal(mounts[target].read_only, true);
        assert.ok(mounts[target].source.endsWith(file), mounts[target].source);
      }
      const env = litellm.environment;
      // LiteLLM requires the master key to start with "sk-".
      assert.equal(env.LITELLM_MASTER_KEY, "sk-value-litellm-master");
      assert.equal(env.LITELLM_SALT_KEY, "value-litellm-salt");
      assert.equal(env.DATABASE_URL, "postgresql://litellm:value-litellm-db@postgres:5432/litellm");
      assert.equal(env.STORE_MODEL_IN_DB, "True");
      assert.equal(litellm.depends_on.postgres.condition, "service_healthy");
    });

    it("keeps upstream model keys out of Paperclip (they live only in the gateway)", () => {
      const keys = envKeys(config.services.paperclip);
      assert.deepEqual(keys.filter((k) => /^(DEEPSEEK|KIMI|MOONSHOT|MINIMAX|OPENAI|LITELLM)_/.test(k)), []);
    });

    it("runs gateway-sync from this commit's image with read-only database access", () => {
      const sync = config.services["gateway-sync"];
      assert.match(sync.image, /\/paperclip-gateway-sync:2222222222222222222222222222222222222222$/);
      const env = sync.environment;
      assert.equal(env.LITELLM_DATABASE_URL, "postgresql://litellm:value-litellm-db@postgres:5432/litellm");
      assert.equal(env.PAPERCLIP_DATABASE_URL, "postgresql://paperclip_readonly:value-readonly-db@postgres:5432/paperclip");
      // Straight to Paperclip on the internal network; Origin is the public URL.
      assert.equal(env.PAPERCLIP_URL, "http://paperclip:3100");
      assert.equal(env.PAPERCLIP_ORIGIN, "https://agents.example.cn");
      // The gateway is recognized by this address, not by a connection name.
      assert.equal(env.PAPERCLIP_GATEWAY_URL, "https://llm.example.cn");
      assert.ok(!("PAPERCLIP_GATEWAY_CONNECTION_NAME" in env));
      assert.equal(env.ACP_LAUNCHER, "/usr/local/bin/claude-agent-acp-tagged");
      assert.ok("PAPERCLIP_SYNC_EMAIL" in env && "PAPERCLIP_SYNC_PASSWORD" in env);
      assert.ok(!Object.keys(env).some((k) => k === "DATABASE_URL"), "never gets Paperclip's read-write database URL");
      assert.ok(sync.healthcheck, "has a liveness healthcheck");
    });

    it("mounts the tagging launcher into Paperclip read-only", () => {
      const mount = config.services.paperclip.volumes.find((v) => v.target === "/usr/local/bin/claude-agent-acp-tagged");
      assert.ok(mount && mount.read_only, "launcher mounted read-only");
      assert.ok(mount.source.endsWith("litellm/claude-agent-acp-tagged.sh"));
    });

    it("lets postgres create the gateway roles on every deploy", () => {
      const postgres = config.services.postgres;
      assert.equal(postgres.environment.LITELLM_DB_PASSWORD, "value-litellm-db");
      assert.equal(postgres.environment.PAPERCLIP_READONLY_DB_PASSWORD, "value-readonly-db");
      const ensure = postgres.volumes.find((v) => v.target === "/docker-entrypoint-initdb.d/20-ensure-roles.sh");
      assert.ok(ensure && ensure.read_only, "mounts the idempotent role script");
      assert.ok(ensure.source.endsWith("postgres/ensure-roles.sh"));
    });

    it("serves the gateway domain only to the admin networks and the containers", () => {
      assert.equal(config.services.caddy.environment.LLM_DOMAIN, "llm.example.cn");
      const caddyfile = fs.readFileSync(path.join(DEPLOY_SRC, "Caddyfile"), "utf8");
      const start = caddyfile.indexOf("{$LLM_DOMAIN} {");
      assert.ok(start >= 0, "has a {$LLM_DOMAIN} site");
      const site = caddyfile.slice(start);
      assert.match(site, /@outside_allowlist \{[^}]*not remote_ip \{\$ADMIN_ALLOWED_CIDRS\} private_ranges[^}]*\}/s);
      assert.match(site, /respond @outside_allowlist 403/);
      assert.match(site, /reverse_proxy litellm:4000/);
    });
  });
});
