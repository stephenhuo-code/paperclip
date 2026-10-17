// gateway-sync main loop (specs/006-litellm-gateway-billing). Every
// SYNC_INTERVAL_MS: fill in the tagging launcher on agents that use the
// gateway, then write the last two hours of LiteLLM spend back to Paperclip
// per run. Paperclip deduplicates by idempotency key, so rescans are safe.
// Logs one JSON object per line. Never logs credentials.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createPaperclipClient, runOnce } from "./lib.mjs";

const env = process.env;
const INTERVAL_MS = Number(env.SYNC_INTERVAL_MS ?? 30_000);
export const HEARTBEAT_FILE = "/tmp/gateway-sync-heartbeat";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

/** Runs SQL through psql, password via PGPASSWORD (never on the command line); returns parsed JSON. */
function queryJson(databaseUrl, sql, vars = {}) {
  const url = new URL(databaseUrl);
  const args = ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", "-"];
  return new Promise((resolve, reject) => {
    const child = spawn("psql", args, {
      env: { PATH: env.PATH, PGHOST: url.hostname, PGPORT: url.port || "5432", PGDATABASE: url.pathname.slice(1),
        PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim() || "[]")) : reject(new Error(err.trim() || `psql exited ${code}`))));
    child.stdin.end(sql);
  });
}

const db = {
  spendRows: (sinceIso) => queryJson(env.LITELLM_DATABASE_URL, `
    SELECT coalesce(json_agg(t), '[]') FROM (
      SELECT request_id, "startTime", spend, status, prompt_tokens, completion_tokens, model_group,
             request_tags, metadata->'usage_object' AS usage
      FROM "LiteLLM_SpendLogs" WHERE "startTime" >= (:'since')::timestamptz AT TIME ZONE 'UTC'
    ) t;`, { since: sinceIso }),
  runs: (ids) => {
    const valid = ids.filter((id) => UUID.test(id));
    if (!valid.length) return Promise.resolve([]);
    return queryJson(env.PAPERCLIP_DATABASE_URL, `
      SELECT coalesce(json_agg(t), '[]') FROM (
        SELECT r.id, r.agent_id AS "agentId", r.company_id AS "companyId", r.issue_id AS "issueId",
               coalesce(r.usage_json->'ledgerScope'->>'projectId', i.project_id::text) AS "projectId"
        FROM heartbeat_runs r LEFT JOIN issues i ON i.id = r.issue_id
        WHERE r.id = ANY ((:'ids')::uuid[])
      ) t;`, { ids: `{${valid.join(",")}}` });
  },
};

const config = {
  launcher: env.ACP_LAUNCHER ?? "/usr/local/bin/claude-agent-acp-tagged",
  gatewayConnectionName: env.PAPERCLIP_GATEWAY_CONNECTION_NAME ?? "模型网关",
  windowMs: 2 * 3600_000,
  reportEveryMs: 3600_000,
};
const state = {};
const paperclip = env.PAPERCLIP_SYNC_EMAIL && env.PAPERCLIP_SYNC_PASSWORD
  ? createPaperclipClient({ baseUrl: env.PAPERCLIP_URL, origin: env.PAPERCLIP_ORIGIN, email: env.PAPERCLIP_SYNC_EMAIL, password: env.PAPERCLIP_SYNC_PASSWORD })
  : null;

async function round() {
  // The heartbeat proves the loop is alive; failures are logged, not fatal.
  fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  if (!paperclip) {
    if (!state.warnedNoAccount) log("sync-account-missing", { hint: "set PAPERCLIP_SYNC_EMAIL and PAPERCLIP_SYNC_PASSWORD in /opt/paperclip/.env" });
    state.warnedNoAccount = true;
    return;
  }
  try {
    const stats = await runOnce({ db, paperclip, config, now: () => new Date(), state, log });
    if (stats.patched || stats.posted || stats.failed) log("round", stats);
  } catch (error) {
    log("round-failed", { error: error.message });
  }
}

log("started", { intervalMs: INTERVAL_MS, gatewayConnectionName: config.gatewayConnectionName });
await round();
setInterval(round, INTERVAL_MS);
