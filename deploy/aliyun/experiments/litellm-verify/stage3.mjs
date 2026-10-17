#!/usr/bin/env node
// LiteLLM verification, stage 3: tag every model request with the Paperclip
// run, then write LiteLLM's priced spend back into Paperclip per run/project
// and check that Paperclip's existing budgets act on it. No Paperclip code
// changes: only agent config (agentCommand) and the public cost-event API.
//
//   PAPERCLIP_ADMIN_PASSWORD=... node stage3.mjs tag    # launcher on agents, P1 budget, new tasks
//   PAPERCLIP_ADMIN_PASSWORD=... node stage3.mjs sync   # LiteLLM spend -> Paperclip cost events, check budget
//
// Needs stage2 state (agents with LiteLLM keys) and the launcher installed at
// /usr/local/bin/claude-agent-acp-tagged in the Paperclip container.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SECRETS_DIR = process.env.LITELLM_SECRETS_DIR ?? path.join(os.homedir(), "paperclip-local", "litellm");
const STATE2 = path.join(SECRETS_DIR, "stage2-state.json");
const STATE3 = path.join(SECRETS_DIR, "stage3-state.json");
const RESULTS = path.join(HERE, "results");
const LITELLM = "http://127.0.0.1:4000";
const PAPERCLIP = "https://agents.127.0.0.1.nip.io";
const CA = path.join(os.homedir(), "paperclip-local", "caddy-root.crt");
const LAUNCHER = "/usr/local/bin/claude-agent-acp-tagged";
const P1_BUDGET_CENTS = 5; // $0.05 at the test prices: a couple of runs exceed it

const master = fs.readFileSync(path.join(SECRETS_DIR, "master.env"), "utf8").match(/LITELLM_MASTER_KEY=(\S+)/)[1];
const jar = path.join(os.tmpdir(), "litellm-stage3-cookies");

async function litellm(route) {
  const res = await fetch(`${LITELLM}${route}`, { headers: { authorization: `Bearer ${master}` } });
  return res.json();
}

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

function signIn() {
  const password = process.env.PAPERCLIP_ADMIN_PASSWORD;
  if (!password) throw new Error("set PAPERCLIP_ADMIN_PASSWORD (local emergency admin)");
  fs.rmSync(jar, { force: true });
  paperclip("POST", "/api/auth/sign-in/email", { email: "admin@example.cn", password });
}

async function tag() {
  signIn();
  const s2 = JSON.parse(fs.readFileSync(STATE2, "utf8"));
  const [p1, p2] = s2.projects;
  for (const agent of s2.agents) {
    paperclip("PATCH", `/api/agents/${agent.id}`, { adapterConfig: { model: agent.model, agentCommand: LAUNCHER } });
  }
  paperclip("POST", `/api/companies/${s2.companyId}/budgets/policies`, {
    scopeType: "project", scopeId: p1.id, windowKind: "calendar_month_utc", amount: P1_BUDGET_CENTS,
    hardStopEnabled: true, unpricedUsagePolicy: "allow", isActive: true,
  });
  const startedAt = new Date().toISOString();
  const issues = [];
  for (const agent of s2.agents) {
    for (const project of [p1, p2]) {
      const issue = paperclip("POST", `/api/companies/${s2.companyId}/issues`, {
        title: `LiteLLM 标签验证：${agent.model} / ${project.name}`,
        description: "回复一句\"OK\"，然后把本任务标记为完成。不要做其他事情。",
        projectId: project.id, assigneeAgentId: agent.id, status: "todo",
      });
      issues.push({ id: issue.id, identifier: issue.identifier, agentId: agent.id, projectId: project.id });
    }
  }
  fs.writeFileSync(STATE3, `${JSON.stringify({ startedAt, budgetProjectId: p1.id, issues }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Launcher set on ${s2.agents.length} agents; P1 budget $${(P1_BUDGET_CENTS / 100).toFixed(2)}; ${issues.length} tasks created.`);
}

async function sync() {
  signIn();
  const s2 = JSON.parse(fs.readFileSync(STATE2, "utf8"));
  const s3 = JSON.parse(fs.readFileSync(STATE3, "utf8"));
  const report = { at: new Date().toISOString(), agents: [], budget: null };
  for (const agent of s2.agents) {
    const logs = await litellm(`/spend/logs?api_key=${encodeURIComponent(agent.litellmKey)}`);
    const rows = (Array.isArray(logs) ? logs : logs.data ?? []).filter((r) => r.startTime >= s3.startedAt);
    const stats = { agent: agent.name, rows: rows.length, tagged: 0, untagged: 0, runs: {}, posted: 0, replayed: 0 };
    for (const row of rows) {
      const tags = row.request_tags ?? [];
      const runId = tags.find((t) => t.startsWith("paperclip-run:"))?.slice("paperclip-run:".length);
      const run = runId && runId !== "none"
        ? psql(`select r.id, r.issue_id, coalesce(r.usage_json->'ledgerScope'->>'projectId', i.project_id::text) from heartbeat_runs r
            left join issues i on i.id = r.issue_id where r.id = '${runId}'`)[0]
        : undefined;
      run ? stats.tagged++ : stats.untagged++;
      const usage = row.metadata?.usage_object ?? {};
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      // Paperclip's inputTokens: uncached input plus cache writes; cache reads go to cachedInputTokens.
      const input = Math.max((row.prompt_tokens ?? 0) - cacheRead, 0);
      const before = psql(`select count(*) from cost_events where idempotency_key = 'litellm:${row.request_id}'`)[0][0];
      paperclip("POST", `/api/companies/${s2.companyId}/cost-events`, {
        idempotencyKey: `litellm:${row.request_id}`, agentId: agent.id,
        heartbeatRunId: run?.[0] ?? null, issueId: run?.[1] || null, projectId: run?.[2] || null,
        provider: "litellm", biller: "litellm", billingType: "metered_api", costStatus: "estimated",
        model: agent.model, inputTokens: input, cachedInputTokens: cacheRead, outputTokens: row.completion_tokens ?? 0,
        costCents: (row.spend * 100).toFixed(7), providerRequestId: row.request_id, occurredAt: new Date(row.startTime).toISOString(),
      });
      before === "0" ? stats.posted++ : stats.replayed++;
      if (run) {
        const r = (stats.runs[run[0]] ??= { projectId: run[2], rows: 0, usd: 0 });
        r.rows++; r.usd += row.spend;
      }
    }
    report.agents.push(stats);
  }
  // Did Paperclip's own project budget react to the synced spend?
  const p1 = s3.budgetProjectId;
  report.budget = {
    projectPausedAt: psql(`select coalesce(paused_at::text, '') , coalesce(pause_reason, '') from projects where id = '${p1}'`)[0],
    projectSpendCents: psql(`select coalesce(sum(cost_cents), 0) from cost_events where project_id = '${p1}' and occurred_at >= date_trunc('month', now())`)[0][0],
    incidents: psql(`select threshold_type, status, amount_observed from budget_incidents where scope_id = '${p1}' order by created_at`),
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `stage3-${report.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  for (const a of report.agents) {
    console.log(`${a.agent}: LiteLLM rows ${a.rows}, tagged with a run ${a.tagged}, untagged ${a.untagged}; posted ${a.posted}, replayed ${a.replayed}`);
    for (const [runId, r] of Object.entries(a.runs)) console.log(`  run ${runId.slice(0, 8)} project ${r.projectId?.slice(0, 8)}: ${r.rows} rows, $${r.usd.toFixed(6)}`);
  }
  console.log(`P1 budget: spend ${report.budget.projectSpendCents}¢ vs ${P1_BUDGET_CENTS}¢; paused ${JSON.stringify(report.budget.projectPausedAt)}; incidents ${JSON.stringify(report.budget.incidents)}`);
  console.log(`Raw: ${path.relative(process.cwd(), file)}`);
}

const cmd = process.argv[2];
(cmd === "tag" ? tag() : cmd === "sync" ? sync() : Promise.reject(new Error("usage: stage3.mjs tag|sync")))
  .catch((e) => { console.error(e.message ?? e); process.exit(1); });
