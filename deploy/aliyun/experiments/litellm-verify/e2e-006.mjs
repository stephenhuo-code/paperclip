#!/usr/bin/env node
// End-to-end check of spec 006 on the local stack (~/paperclip-local), done the
// way an operator would through the UIs, via the same APIs:
//   setup  models + prices in LiteLLM, the shared "模型网关" connection in Paperclip,
//          a project with a $0.05 budget, three agents on the gateway (two default,
//          one with a custom ACP command), then two concurrent tasks per default agent
//   check  launcher filled in only where empty, spend written back per run/project,
//          budget enforced, rescans do not duplicate, custom agent reported
//   down   gateway stopped: a run fails with a clear reason; gateway started again
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const LOCAL = path.join(HOME, "paperclip-local");
const CA = path.join(LOCAL, "caddy-root.crt");
const STATE = path.join(LOCAL, "litellm", "e2e-006-state.json");
const LLM = "https://llm.127.0.0.1.nip.io";
const APP = "https://agents.127.0.0.1.nip.io";
const LAUNCHER = "/usr/local/bin/claude-agent-acp-tagged";
const PRICES = { input_cost_per_token: 0.000001, cache_read_input_token_cost: 0.0000001, cache_creation_input_token_cost: 0.000002, output_cost_per_token: 0.000004 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const envFile = (file) => Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const secrets = envFile(path.join(LOCAL, ".env"));
const upstream = envFile(path.join(LOCAL, "litellm", "keys.env"));
const MASTER = `sk-${secrets.LITELLM_MASTER_KEY}`;

function curl(base, method, route, body, extra = []) {
  const jar = path.join(os.tmpdir(), "e2e-006-cookies");
  const args = ["-sS", "--cacert", CA, "-c", jar, "-b", jar, "-X", method, "-H", "Content-Type: application/json", ...extra, "-w", "\n%{http_code}", `${base}${route}`];
  if (body) args.push("--data", "@-");
  const r = spawnSync("curl", args, { input: body ? JSON.stringify(body) : undefined, encoding: "utf8" });
  const out = r.stdout.trimEnd();
  const status = Number(out.slice(out.lastIndexOf("\n") + 1));
  const text = out.slice(0, out.lastIndexOf("\n"));
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status, json, text };
}
const litellm = (method, route, body) => curl(LLM, method, route, body, ["-H", `Authorization: Bearer ${MASTER}`]);
function paperclip(method, route, body) {
  const r = curl(APP, method, route, body, ["-H", `Origin: ${APP}`]);
  if (r.status >= 400) throw new Error(`${method} ${route} -> ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}
function psql(sql) {
  const r = spawnSync("docker", ["exec", "paperclip-postgres-1", "psql", "-U", "postgres", "-d", "paperclip", "-tA", "-F", "\t", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
}
function signIn() {
  fs.rmSync(path.join(os.tmpdir(), "e2e-006-cookies"), { force: true });
  paperclip("POST", "/api/auth/sign-in/email", { email: secrets.PAPERCLIP_SYNC_EMAIL, password: secrets.PAPERCLIP_SYNC_PASSWORD });
}

async function setup() {
  // 1. Models and prices in the gateway (the admin UI uses these endpoints).
  for (const [name, model, base, key] of [
    ["deepseek-chat", "anthropic/deepseek-chat", "https://api.deepseek.com/anthropic", upstream.DEEPSEEK_API_KEY],
    ["kimi-for-coding", "anthropic/kimi-for-coding", "https://api.kimi.com/coding", upstream.KIMI_CODING_API_KEY],
  ]) {
    const r = litellm("POST", "/model/new", { model_name: name, model_info: { id: `e2e-${name}` }, litellm_params: { model, api_base: base, api_key: key, ...PRICES } });
    console.log(`gateway model ${name}: HTTP ${r.status}`);
  }
  const gatewayKey = litellm("POST", "/key/generate", { key_alias: `paperclip-e2e-${Date.now()}` }).json.key;
  await sleep(12000); // the proxy reloads models from its database

  // 2. Paperclip: the shared gateway connection, a project with a budget, agents.
  signIn();
  const companies = paperclip("GET", "/api/companies");
  const company = (Array.isArray(companies) ? companies : companies.companies)[0];
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
  // A fresh shared connection for all agents (the UI's default for a company-wide connection).
  let list = paperclip("GET", `/api/companies/${company.id}/ai-connections`);
  for (const old of list.connections.filter((c) => c.name === "模型网关" && c.status !== "revoked")) {
    paperclip("DELETE", `/api/tool-connections/${old.id}/grants/${old.grantId}`);
  }
  paperclip("POST", `/api/companies/${company.id}/ai-connections`, {
    provider: "anthropic", method: "api_key", name: "模型网关", ownership: "shared",
    routing: { kind: "gateway", protocol: "messages", baseUrl: LLM, auth: "bearer", models: [{ id: "deepseek-chat" }, { id: "kimi-for-coding" }] },
    apiKey: gatewayKey, allAgents: true,
  });
  list = paperclip("GET", `/api/companies/${company.id}/ai-connections`);
  const gateway = list.connections.find((c) => c.name === "模型网关" && c.status !== "revoked");
  const project = paperclip("POST", `/api/companies/${company.id}/projects`, { name: `网关验证 ${stamp}` });
  paperclip("POST", `/api/companies/${company.id}/budgets/policies`, {
    scopeType: "project", scopeId: project.id, windowKind: "calendar_month_utc", amount: 5, hardStopEnabled: true, isActive: true,
  });
  const agents = [];
  for (const [label, model, adapterExtra] of [["deepseek", "deepseek-chat", {}], ["kimi", "kimi-for-coding", {}], ["custom", "deepseek-chat", { agentCommand: "/app/packages/adapters/claude-local/node_modules/.bin/claude-agent-acp" }]]) {
    const hire = paperclip("POST", `/api/companies/${company.id}/agent-hires`, {
      name: `gw-${label}-${stamp}`, adapterType: "claude_local", adapterConfig: { model, ...adapterExtra },
      capabilities: "Gateway verification agent. Do exactly what the task says, nothing more.",
    });
    const agent = hire.agent ?? hire;
    if (hire.approval?.id) paperclip("POST", `/api/approvals/${hire.approval.id}/approve`, { decisionNote: "spec 006 e2e" });
    // What the UI does when you pick the "模型网关" connection for the agent.
    paperclip("PATCH", `/api/agents/${agent.id}`, { runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "shared", connectionId: gateway.id, grantId: gateway.grantId } } });
    agents.push({ id: agent.id, name: agent.name, label, model });
  }
  fs.writeFileSync(STATE, `${JSON.stringify({ companyId: company.id, projectId: project.id, agents, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });

  // 3. gateway-sync fills in the launcher within a round or two.
  for (let i = 0; i < 12; i++) {
    const rows = psql(`select name, coalesce(adapter_config->>'agentCommand', '') from agents where id in (${agents.map((a) => `'${a.id}'`).join(",")})`);
    const set = Object.fromEntries(rows);
    if (agents.filter((a) => a.label !== "custom").every((a) => set[a.name] === LAUNCHER)) { console.log("launcher filled in:", set); break; }
    await sleep(10000);
  }

  // 4. Two concurrent tasks per default agent.
  for (const agent of agents.filter((a) => a.label !== "custom")) {
    for (const n of [1, 2]) {
      paperclip("POST", `/api/companies/${company.id}/issues`, {
        title: `网关验证 ${n}：${agent.model}`, description: "回复一句\"OK\"，然后把本任务标记为完成。不要做其他事情。",
        projectId: project.id, assigneeAgentId: agent.id, status: "todo",
      });
    }
  }
  console.log("tasks created; run `node e2e-006.mjs check` after the runs finish");
}

function check() {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const ids = s.agents.map((a) => `'${a.id}'`).join(",");
  const result = {
    launcher: Object.fromEntries(psql(`select name, coalesce(adapter_config->>'agentCommand', '') from agents where id in (${ids})`)),
    runs: psql(`select a.name, r.status, coalesce(r.error, '') from heartbeat_runs r join agents a on a.id = r.agent_id where a.id in (${ids}) order by r.created_at`),
    written: psql(`select a.name, count(*), round(sum(c.cost_cents)::numeric, 4), count(c.project_id), count(distinct c.heartbeat_run_id)
      from cost_events c join agents a on a.id = c.agent_id where c.provider = 'litellm' and a.id in (${ids}) group by a.name`),
    projectSpendCents: psql(`select round(coalesce(sum(cost_cents), 0)::numeric, 4) from cost_events where project_id = '${s.projectId}' and provider = 'litellm'`)[0][0],
    project: psql(`select coalesce(paused_at::text, ''), coalesce(pause_reason, '') from projects where id = '${s.projectId}'`)[0],
    incidents: psql(`select threshold_type, status from budget_incidents where scope_id = '${s.projectId}' order by created_at`),
    syncLog: spawnSync("docker", ["logs", "--since", s.startedAt, "paperclip-gateway-sync-1"], { encoding: "utf8" }).stdout.trim().split("\n").filter((l) => /launcher-set|not-via-gateway|unattributed|write-failed|round-failed/.test(l)).slice(-8),
  };
  console.log(JSON.stringify(result, null, 2));
}

async function down() {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const agent = s.agents.find((a) => a.label === "deepseek");
  spawnSync("docker", ["stop", "paperclip-litellm-1"], { encoding: "utf8" });
  signIn();
  const issue = paperclip("POST", `/api/companies/${s.companyId}/issues`, {
    title: "网关停止时的运行", description: "回复一句\"OK\"。", assigneeAgentId: agent.id, status: "todo",
  });
  let run;
  for (let i = 0; i < 30; i++) {
    run = psql(`select status, coalesce(error, '') from heartbeat_runs where agent_id = '${agent.id}' and created_at > now() - interval '5 minutes' and issue_id = '${issue.id}' order by created_at desc limit 1`)[0];
    if (run && ["failed", "succeeded", "timed_out"].includes(run[0])) break;
    await sleep(10000);
  }
  spawnSync("docker", ["start", "paperclip-litellm-1"], { encoding: "utf8" });
  console.log("run while the gateway was down:", run);
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "check" ? Promise.resolve(check()) : cmd === "down" ? down() : Promise.reject(new Error("usage: e2e-006.mjs setup|check|down")))
  .catch((e) => { console.error(e.message ?? e); process.exit(1); });
