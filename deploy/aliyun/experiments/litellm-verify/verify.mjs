#!/usr/bin/env node
// LiteLLM verification, stage 1 (no Paperclip). See README.md.
//
//   node verify.mjs            # start the stack, run all checks, write results/
//   node verify.mjs --down     # stop the stack and delete its data
//
// Upstream keys live in ~/paperclip-local/litellm/keys.env (you fill them in).
// Checks for a model whose key is empty are skipped and reported as SKIP.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SECRETS_DIR = process.env.LITELLM_SECRETS_DIR ?? path.join(os.homedir(), "paperclip-local", "litellm");
const RESULTS = path.join(HERE, "results");
const BASE = "http://127.0.0.1:4000";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
// Must match config.yaml (USD per token).
const PRICE = { input: 0.000001, cacheRead: 0.0000001, cacheWrite: 0.000002, output: 0.000004 };
const REAL_MODELS = [
  { name: "deepseek-chat", keyVar: "DEEPSEEK_API_KEY", kind: "pay-as-you-go" },
  { name: "kimi-for-coding", keyVar: "KIMI_CODING_API_KEY", kind: "Kimi membership" },
  { name: "minimax", keyVar: "MINIMAX_CODING_API_KEY", kind: "MiniMax coding plan" },
];

const compose = (...args) => spawnSync("docker", ["compose", ...args], {
  cwd: HERE, encoding: "utf8", env: { ...process.env, LITELLM_SECRETS_DIR: SECRETS_DIR },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (key) => (key ? `…${String(key).slice(-4)}` : key);
const round = (n) => Math.round(n * 1e9) / 1e9;

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function prepareSecrets() {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const keysFile = path.join(SECRETS_DIR, "keys.env");
  if (!fs.existsSync(keysFile)) {
    fs.copyFileSync(path.join(HERE, "keys.env.example"), keysFile);
    fs.chmodSync(keysFile, 0o600);
    console.log(`Created ${keysFile}. Fill in the keys you want to test, then run this again.`);
    process.exit(2);
  }
  const masterFile = path.join(SECRETS_DIR, "master.env");
  if (!fs.existsSync(masterFile)) {
    fs.writeFileSync(masterFile, `LITELLM_MASTER_KEY=sk-${crypto.randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  }
  return { keys: readEnvFile(keysFile), master: readEnvFile(masterFile).LITELLM_MASTER_KEY };
}

async function api(master, method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method, headers: { authorization: `Bearer ${master}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function waitHealthy() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health/liveliness`)).ok) return; } catch { /* starting */ }
    await sleep(2000);
  }
  throw new Error("LiteLLM did not become healthy; see `docker compose logs litellm`");
}

async function newKey(master, model, extra = {}) {
  const r = await api(master, "POST", "/key/generate", { models: [model], key_alias: `verify-${model}-${Date.now()}`, ...extra });
  if (r.status !== 200 || !r.json.key) throw new Error(`key/generate failed for ${model}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.key;
}

// Spend rows are written in batches; wait until the expected count appears.
async function spendLogs(master, key, minRows) {
  let rows = [];
  for (let i = 0; i < 20; i++) {
    let r;
    try { r = await api(master, "GET", `/spend/logs?api_key=${encodeURIComponent(key)}`); }
    catch { await sleep(3000); continue; } // transient connection reset
    rows = Array.isArray(r.json) ? r.json : (r.json?.data ?? []);
    if (rows.length >= minRows) break;
    await sleep(3000);
  }
  return rows;
}

function rowTokens(row) {
  const usage = row.metadata?.usage_object ?? {};
  const cacheRead = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const prompt = row.prompt_tokens ?? usage.prompt_tokens ?? 0;
  // LiteLLM's prompt_tokens includes cache reads and writes for Anthropic models.
  const plainInput = Math.max(prompt - cacheRead - cacheWrite, 0);
  return { prompt, plainInput, cacheRead, cacheWrite, output: row.completion_tokens ?? 0 };
}
const expectedCost = (t) => t.plainInput * PRICE.input + t.cacheRead * PRICE.cacheRead + t.cacheWrite * PRICE.cacheWrite + t.output * PRICE.output;
const costIfCacheAtInputRate = (t) => (t.plainInput + t.cacheRead + t.cacheWrite) * PRICE.input + t.output * PRICE.output;

function runClaude(model, key, prompt, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "litellm-verify-claude-"));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, ...extraEnv };
  const r = spawnSync(CLAUDE, ["-p", prompt, "--output-format", "json"], { cwd: home, env, encoding: "utf8", timeout: 300_000 });
  fs.rmSync(home, { recursive: true, force: true });
  let out; try { out = JSON.parse(r.stdout); } catch { out = { parseError: true, stdout: r.stdout?.slice(0, 500), stderr: r.stderr?.slice(0, 500) }; }
  const mu = Object.values(out.modelUsage ?? {});
  const sum = (f) => mu.reduce((s, m) => s + (m[f] ?? 0), 0);
  return { ok: r.status === 0 && !out.is_error, isError: out.is_error ?? null, result: String(out.result ?? "").slice(0, 120),
    claudeReportedCostUsd: out.total_cost_usd ?? null,
    claudeTokens: { input: sum("inputTokens"), cacheRead: sum("cacheReadInputTokens"), cacheWrite: sum("cacheCreationInputTokens"), output: sum("outputTokens") },
    error: out.parseError ? out : undefined };
}

function priceCheck(rows) {
  return rows.map((row) => {
    const t = rowTokens(row);
    const expected = expectedCost(t);
    return { model: row.model_group ?? row.model, startTime: row.startTime, spend: round(row.spend ?? 0),
      tokens: t, expected: round(expected), cacheAtInputRate: round(costIfCacheAtInputRate(t)),
      match: Math.abs((row.spend ?? 0) - expected) < 1e-7, tags: row.request_tags ?? null,
      userAgent: row.metadata?.user_agent ?? null };
  });
}

async function main() {
  if (process.argv.includes("--down")) { console.log(compose("down", "-v").stderr); return; }
  const { keys, master } = prepareSecrets();
  fs.mkdirSync(RESULTS, { recursive: true });
  const captureLog = path.join(RESULTS, "capture-headers.jsonl");
  fs.rmSync(captureLog, { force: true });

  const up = compose("up", "-d");
  if (up.status !== 0) throw new Error(up.stderr);
  await waitHealthy();
  const report = { startedAt: new Date().toISOString(), litellmVersion: null, claudeVersion: null, checks: {} };
  report.litellmVersion = (await api(master, "GET", "/health/readiness")).json?.litellm_version ?? null;
  report.claudeVersion = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" }).stdout.trim();

  // 1. Header forwarding and request tags, against the fake upstream.
  const tagHeaders = { ANTHROPIC_CUSTOM_HEADERS: "x-litellm-tags: project-demo\nx-paperclip-run-id: run-demo" };
  const headerCheck = {};
  for (const model of ["capture", "capture-fwd"]) {
    const key = await newKey(master, model);
    const before = fs.existsSync(captureLog) ? fs.readFileSync(captureLog, "utf8").split("\n").filter(Boolean).length : 0;
    const run = runClaude(model, key, "Reply with OK.", tagHeaders);
    const seen = fs.readFileSync(captureLog, "utf8").split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l))
      .filter((e) => e.path.includes("/v1/messages") && !e.path.includes("count_tokens"));
    const rows = await spendLogs(master, key, Math.max(seen.length, 1));
    headerCheck[model] = { claudeOk: run.ok, upstreamUserAgents: [...new Set(seen.map((e) => e.headers["user-agent"]))],
      upstreamGotRunIdHeader: seen.some((e) => e.headers["x-paperclip-run-id"] === "run-demo"),
      spendRows: priceCheck(rows) };
  }
  report.checks.headersAndTags = headerCheck;
  report.litellmVersion ??= headerCheck.capture?.upstreamUserAgents?.[0]?.replace(/^litellm\//, "") ?? null;

  // 2. Budget enforcement on a key (fake upstream, fixed usage $0.0029 a call).
  {
    const key = await newKey(master, "capture", { max_budget: 0.005 });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE}/v1/messages`, { method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "capture", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }) });
      statuses.push(res.status);
      await sleep(15000); // spend is written in batches
    }
    report.checks.budget = { maxBudget: 0.005, perCall: 0.0029, statuses, blockedThirdCall: statuses[0] === 200 && statuses[1] === 200 && statuses[2] >= 400 };
  }

  // 3. Real models through Claude Code: does it work, and how is it priced.
  report.checks.realModels = {};
  for (const m of REAL_MODELS) {
    if (!keys[m.keyVar]) { report.checks.realModels[m.name] = { kind: m.kind, status: "SKIP (no key)" }; continue; }
    const key = await newKey(master, m.name);
    const runs = [runClaude(m.name, key, "Reply with OK."), runClaude(m.name, key, "Reply with OK again.")];
    const rows = await spendLogs(master, key, 2);
    const priced = priceCheck(rows);
    const claudeTotal = runs.reduce((acc, r) => {
      for (const k of Object.keys(r.claudeTokens)) acc[k] = (acc[k] ?? 0) + r.claudeTokens[k];
      return acc;
    }, {});
    const litellmTotal = priced.reduce((acc, p) => ({ plainInput: acc.plainInput + p.tokens.plainInput, cacheRead: acc.cacheRead + p.tokens.cacheRead,
      cacheWrite: acc.cacheWrite + p.tokens.cacheWrite, output: acc.output + p.tokens.output }), { plainInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    report.checks.realModels[m.name] = { kind: m.kind, status: runs.every((r) => r.ok) ? "OK" : "FAIL",
      runs, spendRows: priced, claudeTotal, litellmTotal,
      allRowsPricedAsConfigured: priced.length > 0 && priced.every((p) => p.match),
      cacheTokensSeen: litellmTotal.cacheRead + litellmTotal.cacheWrite > 0 };
  }

  report.finishedAt = new Date().toISOString();
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(RESULTS, `run-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(RESULTS, `run-${stamp}.md`), summarize(report));
  console.log(summarize(report));
}

function summarize(r) {
  const h = r.checks.headersAndTags ?? {};
  const lines = [`# LiteLLM verification ${r.startedAt}`, "", `LiteLLM ${r.litellmVersion ?? "?"} · Claude Code ${r.claudeVersion}`, "",
    "| Check | Result |", "|---|---|"];
  for (const [model, c] of Object.entries(h)) {
    const row = c.spendRows?.[0];
    lines.push(`| ${model}: upstream User-Agent | ${c.upstreamUserAgents.join(", ") || "none"} |`);
    lines.push(`| ${model}: x-paperclip-run-id reached upstream | ${c.upstreamGotRunIdHeader ? "yes" : "no"} |`);
    lines.push(`| ${model}: request tags in spend log | ${JSON.stringify(row?.tags ?? null)} |`);
    lines.push(`| ${model}: priced as configured | ${c.spendRows?.length ? c.spendRows.every((p) => p.match) ? "yes" : `no (spend ${row.spend}, expected ${row.expected}, all-input-rate ${row.cacheAtInputRate})` : "no spend rows"} |`);
  }
  if (r.checks.budget) lines.push(`| key budget $0.005 blocks 3rd call | ${r.checks.budget.blockedThirdCall ? "yes" : "no"} (HTTP ${r.checks.budget.statuses.join(", ")}) |`);
  for (const [model, c] of Object.entries(r.checks.realModels ?? {})) {
    if (c.status.startsWith("SKIP")) { lines.push(`| ${model} (${c.kind}) | ${c.status} |`); continue; }
    lines.push(`| ${model} (${c.kind}): Claude Code works | ${c.status} |`);
    lines.push(`| ${model}: cache tokens recorded | ${c.cacheTokensSeen ? "yes" : "no"} |`);
    lines.push(`| ${model}: priced as configured | ${c.allRowsPricedAsConfigured ? "yes" : "no"} |`);
    lines.push(`| ${model}: tokens Claude Code vs LiteLLM | CC ${JSON.stringify(c.claudeTotal)} / LiteLLM ${JSON.stringify(c.litellmTotal)} |`);
  }
  lines.push("", "Raw data: the matching run-*.json file.", "");
  return lines.join("\n");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
