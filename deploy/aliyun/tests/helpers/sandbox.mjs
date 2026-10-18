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
    # Like the real CLI, \`docker exec -T\` forwards stdin into the container
    # and reads it to the end; only calls that expect stdin keep it.
    case "$args" in
      *"/reset-password "*|*" bash -c "*) ;;
      *" exec -T "*) if [ ! -t 0 ]; then cat >/dev/null; fi ;;
    esac
    case "$args" in
      *" exec -T keycloak /opt/keycloak/bin/kcadm.sh "*)
        # Fake kcadm.sh: users, passwords, roles and organization members are
        # kept in $FAKE_STATE so later calls (and reruns) see earlier writes.
        realm="" sets="" query="" body="" prev=""
        for a in "$@"; do
          case "$prev" in
            -r) realm="$a" ;;
            -s) sets="$sets $a" ;;
            -q) query="$query $a" ;;
            -b) body="$a" ;;
          esac
          prev="$a"
        done
        touch "$FAKE_STATE/kc-users" "$FAKE_STATE/kc-members"
        case "$args" in
          *" config credentials "*) exit "${'${FAKE_KC_LOGIN_EXIT:-0}'}" ;;
          *"/reset-password "*)
            id="${'${args#*users/}'}"; id="${'${id%%/reset-password*}'}"
            cat > "$FAKE_STATE/kc-password-$id" ;;
          *" get users "*)
            case "$query" in
              *" username="*)
                user="${'${query#* username=}'}"; user="${'${user%% *}'}"
                if [ "$realm" = master ] && { [ "${'${FAKE_KC_MASTER_ADMIN:-}'}" = "$user" ] || grep -qx "master:$user" "$FAKE_STATE/kc-users"; }; then
                  echo "id-master-$user"
                fi ;;
              *" email="*)
                mail="${'${query#* email=}'}"; mail="${'${mail%% *}'}"
                if [ "${'${FAKE_KC_REALM_USER:-}'}" = "$mail" ] || grep -qx "$realm:$mail" "$FAKE_STATE/kc-users"; then
                  echo "id-realm-$mail"
                fi ;;
            esac ;;
          *" create users "*)
            if [ "$realm" = master ]; then
              user="${'${sets#* username=}'}"; user="${'${user%% *}'}"
              echo "master:$user" >> "$FAKE_STATE/kc-users"; echo "id-master-$user"
            else
              mail="${'${sets#* email=}'}"; mail="${'${mail%% *}'}"
              echo "$realm:$mail" >> "$FAKE_STATE/kc-users"; echo "id-realm-$mail"
            fi ;;
          *" get organizations/"*"/members "*)
            if [ -n "${'${FAKE_KC_REALM_MEMBER:-}'}" ]; then echo "$FAKE_KC_REALM_MEMBER"; fi
            cat "$FAKE_STATE/kc-members" ;;
          *" get organizations "*) echo "org-1,acme" ;;
          *" create organizations/"*"/members "*)
            id="$(printf '%s' "$body" | tr -d '"')"; echo "$id" >> "$FAKE_STATE/kc-members" ;;
        esac
        exit 0 ;;
      *" exec -T postgres psql "*)
        touch "$FAKE_STATE/pc-admin" "$FAKE_STATE/pc-companies"
        case "$args" in
          *instance_user_roles*)
            if [ -n "${'${FAKE_PC_ADMIN:-}'}" ]; then echo "$FAKE_PC_ADMIN"; else cat "$FAKE_STATE/pc-admin"; fi ;;
          *companies*)
            if [ -n "${'${FAKE_PC_COMPANIES:-}'}" ]; then printf '%b\n' "$FAKE_PC_COMPANIES"; fi
            cat "$FAKE_STATE/pc-companies" ;;
        esac
        exit 0 ;;
      *" exec -T gateway-sync cat "*)
        printf '%s' "${'${FAKE_GATEWAY_SYNC_STATUS:-{\"status\":\"ok\"}}'}" ;;
      *" exec -T gateway-sync "*)
        if [ "${'${FAKE_GATEWAY_SYNC_READY:-1}'}" = "1" ]; then exit 0; else exit 1; fi ;;
      *" exec -T litellm "*)
        if [ "${'${FAKE_LITELLM_READY:-1}'}" = "1" ]; then echo "ok"; else exit 1; fi ;;
      *" exec -T postgres bash /docker-entrypoint-initdb.d/20-ensure-roles.sh"*)
        exit "${'${FAKE_ENSURE_ROLES_EXIT:-0}'}" ;;
      *" exec -T keycloak "*)
        if [ "${'${FAKE_KEYCLOAK_READY:-1}'}" = "1" ]; then echo "HTTP/1.1 200 OK"; else echo "HTTP/1.1 503"; fi ;;
      *" exec -T postgres pg_dump "*)
        for db in paperclip keycloak litellm; do case "$args" in *" $db "*) echo "DUMP:$db";; esac; done ;;
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
    esac
    # Fake Paperclip API: request bodies (which carry passwords) go to
    # $FAKE_STATE, never to the call log.
    out="" jar="" url="" data=0 prev=""
    for a in "$@"; do
      case "$prev" in -o) out="$a" ;; -c|--cookie-jar) jar="$a" ;; esac
      case "$a" in https://*) url="$a" ;; @-) data=1 ;; esac
      prev="$a"
    done
    request=""
    if [ "$data" = 1 ]; then request="$(cat)"; fi
    n=$(( $(cat "$FAKE_STATE/curl-n" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_STATE/curl-n"
    if [ -n "$request" ]; then printf '%s' "$request" > "$FAKE_STATE/curl-body-$n"; fi
    if [ -n "$jar" ]; then echo "fake-session" > "$jar"; fi
    status=200 response='{}'
    case "$url" in
      */api/auth/sign-up/email)
        if [ "${'${FAKE_SIGNUP_EMAIL_TAKEN:-0}'}" = 1 ] && [ ! -f "$FAKE_STATE/signup-taken-once" ]; then
          touch "$FAKE_STATE/signup-taken-once"
          status=422 response='{"code":"USER_ALREADY_EXISTS","message":"User already exists"}'
        else
          mail="$(printf '%s' "$request" | sed -n 's/.*"email":"\([^"]*\)".*/\1/p')"
          name="$(printf '%s' "$request" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
          echo "$mail|$name" > "$FAKE_STATE/pc-signup"
        fi ;;
      */api/invites/*/accept)
        cp "$FAKE_STATE/pc-signup" "$FAKE_STATE/pc-admin" 2>/dev/null || true ;;
      */api/companies)
        if [ "${'${FAKE_COMPANY_CREATE_FAIL:-0}'}" = 1 ]; then
          status=500 response='{"error":"Internal server error"}'
        else
          name="$(printf '%s' "$request" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
          echo "company-new|$name" >> "$FAKE_STATE/pc-companies"
          status=201 response="{\"id\":\"company-new\",\"name\":\"$name\"}"
        fi ;;
    esac
    if [ -n "$out" ]; then printf '%s' "$response" > "$out"; fi
    printf '%s' "$status"
    exit 0 ;;
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
        # Backups from before the model gateway (specs/006) have no litellm dump.
        if [ "${'${FAKE_BACKUP_HAS_LITELLM:-1}'}" = "1" ]; then echo "DUMP:litellm" > "$dest/litellm.dump"; fi
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
        # Drain stdin like the real tool; exiting early makes the s_client side
        # of the pipe die of SIGPIPE under load, which pipefail reports.
        cat >/dev/null
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
  // remote-deploy.sh is installed by bootstrap.sh; a stand-in records its calls.
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "remote-deploy.sh"),
    '#!/usr/bin/env bash\nprintf \'remote-deploy.sh %s\\n\' "$*" >> "$FAKE_LOG"\nexit "${FAKE_REDEPLOY_EXIT:-0}"\n',
    { mode: 0o755 });

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
    run(script, args = [], env = {}, input = "") {
      const result = spawnSync("bash", [path.join(root, "deploy", "scripts", script), ...args], {
        encoding: "utf8",
        input,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          // Scripts and tests must agree on "today" (backup folder names).
          ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
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
    stateFile(name) {
      const file = path.join(state, name);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
    stateFiles() {
      return fs.readdirSync(state);
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
    "LITELLM_MASTER_KEY=value-litellm-master",
    "LITELLM_SALT_KEY=value-litellm-salt",
    "LITELLM_DB_PASSWORD=value-litellm-db",
    "PAPERCLIP_READONLY_DB_PASSWORD=value-readonly-db",
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
  "value-litellm-master",
  "value-litellm-salt",
  "value-litellm-db",
  "value-readonly-db",
];
