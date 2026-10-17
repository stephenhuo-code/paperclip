#!/usr/bin/env node
// LiteLLM verification, stage 2: local Paperclip agents through LiteLLM.
//
//   PAPERCLIP_ADMIN_PASSWORD=... node stage2.mjs setup   # projects, agents, connections, tasks
//   node stage2.mjs map                                  # match LiteLLM spend to Paperclip runs
//
// setup signs in as the local emergency admin (admin@example.cn; password from
// the environment, see ~/paperclip-local/accounts.md). Each agent gets its own
// LiteLLM virtual key through a Paperclip "custom gateway" AI connection, so
// LiteLLM spend can be attributed per agent. Two tasks per agent, in two
// projects, are created at the same time to see whether runs overlap.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SECRETS_DIR = process.env.LITELLM_SECRETS_DIR ?? path.join(os.homedir(), "paperclip-local", "litellm");
const STATE = path.join(SECRETS_DIR, "stage2-state.json"); // holds virtual keys; stays out of the repo
const RESULTS = path.join(HERE, "results");
const LITELLM = "http://127.0.0.1:4000";
const PAPERCLIP = "https://agents.127.0.0.1.nip.io";
const CA = path.join(os.homedir(), "paperclip-local", "caddy-root.crt");
const MODELS = ["deepseek-chat", "kimi-for-coding"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const master = fs.readFileSync(path.join(SECRETS_DIR, "master.env"), "utf8").match(/LITELLM_MASTER_KEY=(\S+)/)[1];

async function litellm(method, route, body) {
  const res = await fetch(`${LITELLM}${route}`, { method, headers: { authorization: `Bearer ${master}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: text }; }
}

// Paperclip through the local Caddy (curl, for the private CA).
const jar = path.join(os.tmpdir(), "litellm-stage2-cookies");
function paperclip(method, route, body) {
  const args = ["-sS", "--cacert", CA, "-c", jar, "-b", jar, "-X", method, "-H", `Origin: ${PAPERCLIP}`,
    "-H", "Content-Type: application/json", "-w", "\n%{http_code}", `${PAPERCLIP}${route}`];
  if (body) args.push("--data", "@-");
  const r = spawnSync("curl", args, { input: body ? JSON.stringify(body) : undefined, encoding: "utf8" });
  const out = r.stdout.trimEnd();
  const status = Number(out.slice(out.lastIndexOf("\n") + 1));
  const text = out.slice(0, out.lastIndexOf("\n"));
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (status >= 400) throw new Error(`${method} ${route} -> ${status}: ${text.slice(0, 300)}`);
  return json;
}

function psql(sql) {
  const r = spawnSync("docker", ["exec", "paperclip-postgres-1", "psql", "-U", "postgres", "-d", "paperclip", "-tA", "-F", "\t", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
}

// Creating a connection with agentIds grants access but does not select it for
// the agent; the agent's runtimeConfig.aiConnection must point at it (the UI
// does both). Without this the run starts unauthenticated ("Not logged in").
function bindConnection(companyId, agentId, created) {
  const list = paperclip("GET", `/api/companies/${companyId}/ai-connections`);
  const id = created?.id ?? created?.connection?.id;
  const c = list.connections.find((x) => x.id === id) ?? list.connections.find((x) => x.name === created?.name);
  if (!c) throw new Error(`connection not found for agent ${agentId}`);
  paperclip("PATCH", `/api/agents/${agentId}`, { runtimeConfig: { aiConnection: {
    provider: "anthropic", method: "api_key", mode: "shared", connectionId: c.id, grantId: c.grantId } } });
}

// Repair an earlier setup run: bind each agent to its LiteLLM connection and wake it.
async function bind() {
  const password = process.env.PAPERCLIP_ADMIN_PASSWORD;
  if (!password) throw new Error("set PAPERCLIP_ADMIN_PASSWORD (local emergency admin)");
  fs.rmSync(jar, { force: true });
  paperclip("POST", "/api/auth/sign-in/email", { email: "admin@example.cn", password });
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const list = paperclip("GET", `/api/companies/${state.companyId}/ai-connections`);
  for (const agent of state.agents) {
    const c = list.connections.find((x) => x.name === `LiteLLM ${agent.model} (${agent.name})`);
    bindConnection(state.companyId, agent.id, c);
    try { paperclip("POST", `/api/agents/${agent.id}/resume`); } catch (e) { console.log(`resume ${agent.name}: ${e.message}`); }
    // Wake the agent on its open tasks again: a comment on an assigned task
    // wakes the assignee (exact failed-run retries reject the new binding).
    for (const [issueId] of psql(`select id from issues where assignee_agent_id = '${agent.id}' and status not in ('done', 'cancelled')`)) {
      paperclip("POST", `/api/issues/${issueId}/comments`, { body: "连接已修复，请继续：回复一句\"OK\"，然后把本任务标记为完成。" });
    }
    console.log(`bound ${agent.name} -> ${c.name}`);
  }
}

async function setup() {
  const password = process.env.PAPERCLIP_ADMIN_PASSWORD;
  if (!password) throw new Error("set PAPERCLIP_ADMIN_PASSWORD (local emergency admin)");

  // Paperclip accepts only HTTPS gateways, or HTTP on loopback. For this local
  // test a socat sidecar in the Paperclip container's network namespace turns
  // 127.0.0.1:4000 there into LiteLLM. (Production would put LiteLLM behind HTTPS.)
  spawnSync("docker", ["network", "connect", "paperclip_default", "litellm-verify-litellm-1"], { encoding: "utf8" });
  spawnSync("docker", ["rm", "-f", "litellm-loopback"], { encoding: "utf8" });
  const sidecar = spawnSync("docker", ["run", "-d", "--name", "litellm-loopback", "--network", "container:paperclip-paperclip-1",
    "alpine/socat:1.8.0.3", "TCP-LISTEN:4000,fork,reuseaddr", "TCP:litellm-verify-litellm-1:4000"], { encoding: "utf8" });
  if (sidecar.status !== 0) throw new Error(sidecar.stderr);

  fs.rmSync(jar, { force: true });
  paperclip("POST", "/api/auth/sign-in/email", { email: "admin@example.cn", password });
  const companies = paperclip("GET", "/api/companies");
  const company = (Array.isArray(companies) ? companies : companies.companies)[0];
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
  const projects = ["P1", "P2"].map((p) => paperclip("POST", `/api/companies/${company.id}/projects`, { name: `LiteLLM 验证 ${p} ${stamp}` }));

  const state = { companyId: company.id, createdAt: new Date().toISOString(), projects: projects.map((p) => ({ id: p.id, name: p.name })), agents: [] };
  for (const model of MODELS) {
    const name = `litellm-${model}-${stamp}`;
    const key = (await litellm("POST", "/key/generate", { models: [model], key_alias: name })).json.key;
    // The local company requires hire approval: request the hire, then approve it as admin.
    const hire = paperclip("POST", `/api/companies/${company.id}/agent-hires`, {
      name, adapterType: "claude_local", adapterConfig: { model },
      capabilities: "LiteLLM verification agent. Do exactly what the task says, nothing more.",
    });
    const agent = hire.agent ?? hire;
    if (hire.approval?.id) paperclip("POST", `/api/approvals/${hire.approval.id}/approve`, { decisionNote: "LiteLLM verification" });
    const connection = paperclip("POST", `/api/companies/${company.id}/ai-connections`, {
      provider: "anthropic", method: "api_key", name: `LiteLLM ${model} (${name})`, ownership: "shared",
      routing: { kind: "gateway", protocol: "messages", baseUrl: "http://127.0.0.1:4000", auth: "bearer", models: [{ id: model }] },
      apiKey: key, agentIds: [agent.id],
    });
    bindConnection(company.id, agent.id, connection);
    state.agents.push({ id: agent.id, name, model, status: agent.status, litellmKey: key });
  }
  fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  for (const agent of state.agents) {
    for (const project of state.projects) {
      paperclip("POST", `/api/companies/${company.id}/issues`, {
        title: `LiteLLM 验证：${agent.model} / ${project.name}`,
        description: "回复一句\"OK\"，然后把本任务标记为完成。不要做其他事情。",
        projectId: project.id, assigneeAgentId: agent.id, status: "todo",
      });
    }
  }
  console.log(JSON.stringify({ ...state, agents: state.agents.map(({ litellmKey, ...a }) => a) }, null, 2));
  console.log("Tasks created. Wait for the runs to finish, then: node stage2.mjs map");
}

async function map() {
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const report = { at: new Date().toISOString(), agents: [] };
  for (const agent of state.agents) {
    const runs = psql(`select id, to_char(coalesce(process_started_at, started_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(finished_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), status, usage_json->'ledgerScope'->>'projectId'
      from heartbeat_runs where agent_id = '${agent.id}' order by created_at`)
      .map(([id, start, end, status, projectId]) => ({ id, start, end, status, projectId }));
    const costs = Object.fromEntries(psql(`select heartbeat_run_id, sum(input_tokens), sum(cached_input_tokens), sum(output_tokens), sum(cost_cents), string_agg(distinct billing_type, ',')
      from cost_events where agent_id = '${agent.id}' group by heartbeat_run_id`)
      .map(([run, input, cached, output, cents, billing]) => [run, { input: +input, cached: +cached, output: +output, cents: +cents, billing }]));
    const logs = (await litellm("GET", `/spend/logs?api_key=${encodeURIComponent(agent.litellmKey)}`)).json;
    const rows = (Array.isArray(logs) ? logs : logs.data ?? []).map((r) => ({ start: r.startTime, end: r.endTime, spend: r.spend,
      prompt: r.prompt_tokens, output: r.completion_tokens, cacheRead: r.metadata?.usage_object?.cache_read_input_tokens ?? 0 }));

    // Overlapping runs of the same agent make time-based attribution ambiguous.
    const overlaps = runs.filter((a, i) => runs.some((b, j) => j !== i && a.end && b.end && a.start < b.end && b.start < a.end)).length;
    const slackMs = 2000;
    const perRun = Object.fromEntries(runs.map((r) => [r.id, { projectId: r.projectId, status: r.status, spend: 0, rows: 0, litellmTokens: { prompt: 0, cacheRead: 0, output: 0 }, paperclip: costs[r.id] ?? null }]));
    let matched = 0, ambiguous = 0, unmatched = 0;
    for (const row of rows) {
      const t = Date.parse(row.start);
      const hits = runs.filter((r) => Date.parse(r.start) - slackMs <= t && t <= (r.end ? Date.parse(r.end) : Infinity) + slackMs);
      if (hits.length === 1) {
        matched++;
        const p = perRun[hits[0].id];
        p.spend += row.spend; p.rows++;
        p.litellmTokens.prompt += row.prompt; p.litellmTokens.cacheRead += row.cacheRead; p.litellmTokens.output += row.output;
      } else if (hits.length > 1) ambiguous++; else unmatched++;
    }
    const byProject = {};
    for (const p of Object.values(perRun)) byProject[p.projectId ?? "none"] = (byProject[p.projectId ?? "none"] ?? 0) + p.spend;
    report.agents.push({ agent: agent.name, model: agent.model, runs: runs.length, overlappingRuns: overlaps,
      litellmRows: rows.length, matched, ambiguous, unmatched, byProject, perRun });
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `stage2-${report.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  for (const a of report.agents) {
    console.log(`${a.agent}: runs ${a.runs} (overlapping ${a.overlappingRuns}), LiteLLM rows ${a.litellmRows}: matched ${a.matched}, ambiguous ${a.ambiguous}, unmatched ${a.unmatched}`);
    for (const [runId, p] of Object.entries(a.perRun)) {
      console.log(`  run ${runId.slice(0, 8)} ${p.status} project ${p.projectId?.slice(0, 8) ?? "-"}: LiteLLM $${p.spend.toFixed(6)} ${JSON.stringify(p.litellmTokens)} / Paperclip ${JSON.stringify(p.paperclip)}`);
    }
  }
  console.log(`Raw: ${path.relative(process.cwd(), file)}`);
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "bind" ? bind() : cmd === "map" ? map() : Promise.reject(new Error("usage: stage2.mjs setup|bind|map")))
  .catch((e) => { console.error(e.message ?? e); process.exit(1); });
