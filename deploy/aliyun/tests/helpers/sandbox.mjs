// Test sandbox for the deploy scripts: a temporary /opt/paperclip, a copy of
// deploy/aliyun as its deploy dir, and fake external commands on PATH that
// log every call and answer from environment variables.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOY_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PRODUCTION_ENV_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/production.env");

const FAKE = String.raw`#!/usr/bin/env bash
# Fake external command. Logs the call, then answers from FAKE_* variables.
name="$(basename "$0")"
printf '%s %s%s\n' "$name" "$*" "${'${PAPERCLIP_IMAGE_TAG:+ [PAPERCLIP_IMAGE_TAG=$PAPERCLIP_IMAGE_TAG]}'}" >> "$FAKE_LOG"
args=" $* "
case "$name" in
  docker)
    case "$args" in
      *" exec -T keycloak "*)
        if [ "${'${FAKE_KEYCLOAK_READY:-1}'}" = "1" ]; then echo "HTTP/1.1 200 OK"; else echo "HTTP/1.1 503"; fi ;;
      *" exec -T postgres pg_dump "*)
        for db in paperclip keycloak; do case "$args" in *" $db "*) echo "DUMP:$db";; esac; done ;;
      *" exec -T paperclip tar "*) echo "TAR-ARCHIVE" ;;
      *" exec -T --user node paperclip "*)
        if [ "${'${FAKE_INVITE_FAILS:-0}'}" = "1" ]; then
          echo "■  No config found"
        else
          printf '│\n◆  Created bootstrap CEO invite.\n│  Invite URL: \033[36mhttps://agents.example.cn/invite/pcp_bootstrap_abc123\033[39m\n'
        fi ;;
      *" compose "*" up "*) exit "${'${FAKE_COMPOSE_UP_EXIT:-0}'}" ;;
    esac ;;
  curl)
    case "$args" in
      *"/api/health"*)
        printf '%s' "${'${FAKE_HEALTH_BODY:-}'}"
        exit "${'${FAKE_CURL_EXIT:-0}'}" ;;
    esac ;;
  ossutil)
    if [ "${'${FAKE_OSSUTIL_EXIT:-0}'}" != "0" ]; then exit "$FAKE_OSSUTIL_EXIT"; fi
    # "ossutil cp -r oss://bucket/date/ <dest>" materializes a backup set.
    if [ "$1" = "cp" ]; then
      dest="${'${@: -1}'}"
      src="${'${@: -2:1}'}"
      case "$src" in oss://*)
        mkdir -p "$dest"
        echo "DUMP:paperclip" > "$dest/paperclip.dump"
        echo "DUMP:keycloak" > "$dest/keycloak.dump"
        echo "TAR-ARCHIVE" > "$dest/paperclip-data.tgz" ;;
      esac
    fi ;;
  openssl)
    case "$1" in
      rand)
        n=$(( $(cat "$FAKE_STATE/rand" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$FAKE_STATE/rand"
        echo "generated-secret-$n" ;;
      s_client) echo "-----BEGIN CERTIFICATE-----" ;;
      x509)
        case "$args" in *" -checkend "*) exit "${'${FAKE_CERT_EXPIRING:-0}'}" ;; esac ;;
    esac ;;
esac
exit 0
`;

export const FAKE_COMMANDS = ["docker", "curl", "ossutil", "openssl", "systemctl", "apt-get", "dnf"];

export function createSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-deploy-test-"));
  const root = path.join(dir, "opt-paperclip");
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "fake-state");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.cpSync(DEPLOY_SRC, path.join(root, "deploy"), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}tests${path.sep}`) && !src.endsWith(`${path.sep}tests`),
  });
  // Tests run against fixed example settings, not the live production values.
  fs.copyFileSync(PRODUCTION_ENV_FIXTURE, path.join(root, "deploy", "environments", "production.env"));
  for (const name of FAKE_COMMANDS) {
    fs.writeFileSync(path.join(bin, name), FAKE, { mode: 0o755 });
  }
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");

  return {
    dir,
    root,
    log,
    writeEnv(content) {
      fs.writeFileSync(path.join(root, ".env"), content, { mode: 0o600 });
    },
    readEnv() {
      return fs.readFileSync(path.join(root, ".env"), "utf8");
    },
    writeState(name, value) {
      fs.mkdirSync(path.join(root, "state"), { recursive: true });
      fs.writeFileSync(path.join(root, "state", name), `${value}\n`);
    },
    readState(name) {
      const file = path.join(root, "state", name);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
    },
    calls() {
      return fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    },
    run(script, args = [], env = {}) {
      const result = spawnSync("bash", [path.join(root, "deploy", "scripts", script), ...args], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: dir,
          PAPERCLIP_ROOT: root,
          FAKE_LOG: log,
          FAKE_STATE: state,
          DEPLOY_HEALTH_TIMEOUT_SECONDS: "2",
          DEPLOY_HEALTH_INTERVAL_SECONDS: "0",
          ...env,
        },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A complete server .env with recognizable secret values. */
export function sampleEnv(extra = "") {
  return [
    "BETTER_AUTH_SECRET=value-better-auth",
    "PAPERCLIP_AGENT_JWT_SECRET=value-agent-jwt",
    "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=value-tool-signing",
    "POSTGRES_PASSWORD=value-postgres",
    "PAPERCLIP_DB_PASSWORD=value-paperclip-db",
    "KEYCLOAK_DB_PASSWORD=value-keycloak-db",
    "KC_BOOTSTRAP_ADMIN_PASSWORD=value-kc-admin",
    "PAPERCLIP_AUTH_OIDC_CLIENT_SECRET=value-oidc-secret",
    'PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={"acme":"5facf42d-f31f-4698-9bc9-e38f876b1579"}',
    "PAPERCLIP_AUTH_DISABLE_SIGN_UP=false",
    extra,
  ].join("\n");
}

export const SECRET_VALUES = [
  "value-better-auth",
  "value-agent-jwt",
  "value-tool-signing",
  "value-postgres",
  "value-paperclip-db",
  "value-keycloak-db",
  "value-kc-admin",
  "value-oidc-secret",
];
