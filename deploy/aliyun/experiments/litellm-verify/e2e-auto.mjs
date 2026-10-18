#!/usr/bin/env node
// plan-auto-setup check on the local stack: a gateway connection with any name
// is recognized by its address; a new Claude Code agent on it gets the launcher
// automatically and its spend is written back with the project.
//   node e2e-auto.mjs setup | check
import { spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const LOCAL = path.join(os.homedir(), "paperclip-local"), CA = path.join(LOCAL, "caddy-root.crt");
const LLM = "https://llm.127.0.0.1.nip.io", APP = "https://agents.127.0.0.1.nip.io", STATE = path.join(LOCAL, "litellm", "e2e-auto-state.json");
const env = Object.fromEntries(fs.readFileSync(path.join(LOCAL, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function curl(base, method, route, body, extra) {
  const jar = path.join(os.tmpdir(), "e2e-auto-cookies");
  const args = ["-sS", "--cacert", CA, "-c", jar, "-b", jar, "-X", method, "-H", "Content-Type: application/json", ...extra, "-w", "\n%{http_code}", base + route];
  if (body) args.push("--data", "@-");
  const out = spawnSync("curl", args, { input: body ? JSON.stringify(body) : undefined, encoding: "utf8" }).stdout.trimEnd();
  const status = Number(out.slice(out.lastIndexOf("\n") + 1)), text = out.slice(0, out.lastIndexOf("\n"));
  if (status >= 400) throw new Error(`${method} ${route} -> ${status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const pc = (m, r, b) => curl(APP, m, r, b, ["-H", `Origin: ${APP}`]);
const llm = (m, r, b) => curl(LLM, m, r, b, ["-H", `Authorization: Bearer sk-${env.LITELLM_MASTER_KEY}`]);
const psql = (sql) => spawnSync("docker", ["exec", "paperclip-postgres-1", "psql", "-U", "postgres", "-d", "paperclip", "-tA", "-F", "\t", "-c", sql], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));

async function setup() {
  fs.rmSync(path.join(os.tmpdir(), "e2e-auto-cookies"), { force: true });
  pc("POST", "/api/auth/sign-in/email", { email: env.PAPERCLIP_SYNC_EMAIL, password: env.PAPERCLIP_SYNC_PASSWORD });
  const company = (() => { const c = pc("GET", "/api/companies"); return (Array.isArray(c) ? c : c.companies)[0]; })();
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
  const key = llm("POST", "/key/generate", { key_alias: `paperclip-auto-${stamp}` }).key;
  const name = `网关-自动-${stamp}`; // deliberately not "模型网关"
  pc("POST", `/api/companies/${company.id}/ai-connections`, {
    provider: "anthropic", method: "api_key", name, ownership: "shared", allAgents: true, apiKey: key,
    routing: { kind: "gateway", protocol: "messages", baseUrl: `${LLM}/`, auth: "bearer", models: [{ id: "deepseek-chat" }] },
  });
  const conn = pc("GET", `/api/companies/${company.id}/ai-connections`).connections.find((c) => c.name === name && c.status !== "revoked");
  const project = pc("POST", `/api/companies/${company.id}/projects`, { name: `自动接入验证 ${stamp}` });
  const hire = pc("POST", `/api/companies/${company.id}/agent-hires`, { name: `auto-${stamp}`, adapterType: "claude_local", adapterConfig: { model: "deepseek-chat" }, capabilities: "Verification agent. Do exactly what the task says." });
  const agent = hire.agent ?? hire;
  if (hire.approval?.id) pc("POST", `/api/approvals/${hire.approval.id}/approve`, { decisionNote: "plan-auto-setup check" });
  // Exactly what the UI does: pick the connection and a model. Nothing else.
  pc("PATCH", `/api/agents/${agent.id}`, { runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "shared", connectionId: conn.id, grantId: conn.grantId } } });
  let command = "";
  for (let i = 0; i < 9 && !command; i++) { await sleep(10000); command = psql(`select coalesce(adapter_config->>'agentCommand','') from agents where id='${agent.id}'`)[0]?.[0] ?? ""; }
  console.log(`connection "${name}" (base URL with trailing slash); launcher set automatically: ${command || "NO"}`);
  pc("POST", `/api/companies/${company.id}/issues`, { title: "自动接入验证：回复 OK", description: "回复一句\"OK\"，然后把本任务标记为完成。", projectId: project.id, assigneeAgentId: agent.id, status: "todo" });
  fs.writeFileSync(STATE, JSON.stringify({ agentId: agent.id, projectId: project.id, connectionId: conn.id, startedAt: new Date().toISOString() }), { mode: 0o600 });
  console.log("task created; run `node e2e-auto.mjs check` after it finishes");
}
function check() {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  console.log("runs:", psql(`select status from heartbeat_runs where agent_id='${s.agentId}' order by created_at`).map((r) => r[0]).join(","));
  console.log("written back (rows, cents, with project):", psql(`select count(*), round(coalesce(sum(cost_cents),0)::numeric,4), count(project_id) from cost_events where agent_id='${s.agentId}' and provider='litellm'`)[0].join(" | "));
}
async function task() {
  // Resume after setup: the newest auto-* agent and project.
  fs.rmSync(path.join(os.tmpdir(), "e2e-auto-cookies"), { force: true });
  pc("POST", "/api/auth/sign-in/email", { email: env.PAPERCLIP_SYNC_EMAIL, password: env.PAPERCLIP_SYNC_PASSWORD });
  const [agentId, companyId] = psql("select id, company_id from agents where name like 'auto-%' order by created_at desc limit 1")[0];
  const [projectId] = psql("select id from projects where name like '自动接入验证%' order by created_at desc limit 1")[0];
  pc("POST", `/api/companies/${companyId}/issues`, { title: "自动接入验证：回复 OK", description: "回复一句\"OK\"，然后把本任务标记为完成。", projectId, assigneeAgentId: agentId, status: "todo" });
  fs.writeFileSync(STATE, JSON.stringify({ agentId, projectId, startedAt: new Date().toISOString() }), { mode: 0o600 });
  console.log("task created");
}
(process.argv[2] === "setup" ? setup() : process.argv[2] === "task" ? task() : Promise.resolve(check())).catch((e) => { console.error(e.message); process.exit(1); });
