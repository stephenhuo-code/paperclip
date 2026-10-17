import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRunTags, toCostEvent, reconcileAgent, createPaperclipClient, runOnce,
} from "../gateway-sync/lib.mjs";

// specs/006-litellm-gateway-billing: gateway-sync writes LiteLLM spend back to
// Paperclip per run (US3) and fills in the tagging launcher on agents (US5).

const LAUNCHER = "/usr/local/bin/claude-agent-acp-tagged";
const RUN = "9e8d1cc8-1071-47fa-b10b-ddfbcf33ee01";
const TASK = "28a41f4c-de85-49d2-85e4-25a9782ee205";
const row = (over = {}) => ({
  request_id: "req-1", startTime: "2026-10-17T08:32:02.197Z", spend: 0.025399, status: "success",
  prompt_tokens: 24679, completion_tokens: 180, model_group: "deepseek-chat",
  usage: { cache_read_input_tokens: 20000, cache_creation_input_tokens: 300 },
  request_tags: [`paperclip-run:${RUN}`, `paperclip-task:${TASK}`, "User-Agent: claude-cli/2.1.300"],
  ...over,
});
const run = { id: RUN, agentId: "agent-1", companyId: "company-1", issueId: TASK, projectId: "project-1" };

describe("parseRunTags", () => {
  it("reads the run and task the launcher put on the request", () => {
    assert.deepEqual(parseRunTags(row().request_tags), { runId: RUN, taskId: TASK });
  });
  it("returns no run for untagged requests or the launcher's placeholder", () => {
    assert.equal(parseRunTags(["User-Agent: claude-cli"]).runId, null);
    assert.equal(parseRunTags(["paperclip-run:none"]).runId, null);
    assert.equal(parseRunTags(null).runId, null);
  });
});

describe("toCostEvent", () => {
  it("maps a LiteLLM spend row to a Paperclip cost event for the run", () => {
    assert.deepEqual(toCostEvent(row(), run), {
      idempotencyKey: "litellm:req-1",
      agentId: "agent-1", heartbeatRunId: RUN, issueId: TASK, projectId: "project-1",
      provider: "litellm", biller: "litellm", billingType: "metered_api", costStatus: "estimated",
      model: "deepseek-chat",
      // Paperclip's inputTokens: uncached input plus cache writes; cache reads are separate.
      inputTokens: 24679 - 20000, cachedInputTokens: 20000, outputTokens: 180,
      costCents: "2.5399000", providerRequestId: "req-1", occurredAt: "2026-10-17T08:32:02.197Z",
    });
  });
  it("treats LiteLLM's naive timestamps as UTC and keeps exact cents", () => {
    const event = toCostEvent(row({ startTime: "2026-10-17 08:32:02.197", spend: 0.0000001 }), run);
    assert.equal(event.occurredAt, "2026-10-17T08:32:02.197Z");
    assert.equal(event.costCents, "0.0000100");
  });
  it("leaves task and project empty when the run has none", () => {
    const event = toCostEvent(row(), { ...run, issueId: null, projectId: null });
    assert.equal(event.issueId, null);
    assert.equal(event.projectId, null);
  });
});

describe("reconcileAgent", () => {
  const opts = { gatewayConnectionId: "conn-gw", launcher: LAUNCHER };
  const agent = (over = {}) => ({
    id: "a1", name: "AI情报员", adapterType: "claude_local",
    adapterConfig: { model: "deepseek-chat", effort: "high" },
    runtimeConfig: { aiConnection: { mode: "shared", connectionId: "conn-gw" } }, ...over,
  });
  it("fills in the launcher for a Claude Code agent on the gateway with no ACP command", () => {
    assert.deepEqual(reconcileAgent(agent(), opts), {
      action: "patch", adapterConfig: { model: "deepseek-chat", effort: "high", agentCommand: LAUNCHER },
    });
  });
  it("leaves an agent that already uses the launcher alone", () => {
    assert.deepEqual(reconcileAgent(agent({ adapterConfig: { agentCommand: LAUNCHER } }), opts), { action: "ok" });
  });
  for (const [label, over] of [
    ["a custom ACP command", { adapterConfig: { agentCommand: "/opt/my-harness" } }],
    ["another connection", { runtimeConfig: { aiConnection: { mode: "shared", connectionId: "conn-deepseek" } } }],
    ["no connection", { runtimeConfig: {} }],
    ["another runtime", { adapterType: "codex_local" }],
  ]) {
    it(`never changes an agent with ${label}; reports it as not via the gateway`, () => {
      const result = reconcileAgent(agent(over), opts);
      assert.equal(result.action, "skip");
      assert.ok(result.reason);
    });
  }
});

// Fake Paperclip HTTP API for the client and the loop.
function fakePaperclip({ agents = [], connections = [], failCostEvents = false } = {}) {
  const calls = [];
  let session = null, logins = 0, expireOnce = false;
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, route, body, cookie: init.headers?.cookie, origin: init.headers?.origin });
    const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
    if (route === "/api/auth/sign-in/email") {
      logins++; session = `s${logins}`;
      return json(200, { ok: true }, { "set-cookie": `better-auth.session_token=${session}; Path=/; HttpOnly` });
    }
    if (init.headers?.cookie !== `better-auth.session_token=${session}` || expireOnce) {
      expireOnce = false;
      return json(401, { error: "unauthorized" });
    }
    if (route === "/api/companies") return json(200, [{ id: "company-1" }]);
    if (route === "/api/companies/company-1/ai-connections") return json(200, { connections });
    if (route === "/api/companies/company-1/agents") return json(200, agents);
    if (method === "PATCH" && route.startsWith("/api/agents/")) return json(200, { id: route.split("/")[3] });
    if (method === "POST" && route === "/api/companies/company-1/cost-events") {
      return failCostEvents ? json(500, { error: "boom" }) : json(201, { id: `ce-${body.idempotencyKey}` });
    }
    return json(404, { error: "not found" });
  };
  return { fetchImpl, calls, expire() { expireOnce = true; }, logins: () => logins };
}

describe("createPaperclipClient", () => {
  it("signs in with the sync account and sends the Origin header", async () => {
    const fake = fakePaperclip();
    const client = createPaperclipClient({ baseUrl: "https://agents.example.cn", email: "ops@example.cn", password: "pw", fetchImpl: fake.fetchImpl });
    await client.get("/api/companies");
    assert.equal(fake.logins(), 1);
    const login = fake.calls[0];
    assert.equal(login.route, "/api/auth/sign-in/email");
    assert.deepEqual(login.body, { email: "ops@example.cn", password: "pw" });
    assert.ok(fake.calls.every((c) => c.origin === "https://agents.example.cn"));
  });
  it("signs in again once when the session expires", async () => {
    const fake = fakePaperclip();
    const client = createPaperclipClient({ baseUrl: "https://agents.example.cn", email: "e", password: "p", fetchImpl: fake.fetchImpl });
    await client.get("/api/companies");
    fake.expire();
    const companies = await client.get("/api/companies");
    assert.deepEqual(companies, [{ id: "company-1" }]);
    assert.equal(fake.logins(), 2);
  });
});

describe("runOnce", () => {
  const NOW = new Date("2026-10-17T09:00:00Z");
  const gateway = { id: "conn-gw", name: "模型网关" };
  const deps = (fake, rows, runs = [run], state = {}) => {
    const logs = [];
    return {
      logs,
      deps: {
        db: {
          async spendRows(sinceIso) { logs.push(["since", sinceIso]); return rows; },
          async runs(ids) { return runs.filter((r) => ids.includes(r.id)); },
        },
        paperclip: createPaperclipClient({ baseUrl: "https://agents.example.cn", email: "e", password: "p", fetchImpl: fake.fetchImpl }),
        config: { launcher: LAUNCHER, gatewayConnectionName: "模型网关", windowMs: 2 * 3600_000, reportEveryMs: 3600_000 },
        now: () => NOW, state, log: (event, fields) => logs.push([event, fields]),
      },
    };
  };

  it("posts every tagged success row once per request, scanning the last two hours", async () => {
    const fake = fakePaperclip({ connections: [gateway] });
    const { deps: d, logs } = deps(fake, [row(), row({ request_id: "req-2" }), row({ request_id: "req-3", status: "failure", spend: 0 })]);
    const stats = await runOnce(d);
    assert.equal(logs[0][1], "2026-10-17T07:00:00.000Z");
    const posts = fake.calls.filter((c) => c.route.endsWith("/cost-events"));
    assert.deepEqual(posts.map((p) => p.body.idempotencyKey), ["litellm:req-1", "litellm:req-2"]);
    assert.equal(stats.posted, 2);
  });

  it("does not post untagged rows or rows whose run is unknown; counts them as unattributed", async () => {
    const fake = fakePaperclip({ connections: [gateway] });
    const { deps: d } = deps(fake, [row({ request_tags: ["User-Agent: claude-cli"], spend: 0.016 }), row({ request_tags: ["paperclip-run:11111111-1111-1111-1111-111111111111"], spend: 0.01 })]);
    const stats = await runOnce(d);
    assert.equal(fake.calls.filter((c) => c.route.endsWith("/cost-events")).length, 0);
    assert.equal(stats.unattributed.count, 2);
    assert.ok(Math.abs(stats.unattributed.usd - 0.026) < 1e-9);
  });

  it("reports unattributed spend and agents not via the gateway at most once an hour", async () => {
    const agents = [{ id: "a9", name: "Codex 员工", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {} }];
    const fake = fakePaperclip({ connections: [gateway], agents });
    const state = {};
    const first = deps(fake, [row({ request_tags: [], spend: 0.016 })], [run], state);
    await runOnce(first.deps);
    assert.ok(first.logs.some(([e, f]) => e === "unattributed" && f.count === 1));
    assert.ok(first.logs.some(([e, f]) => e === "not-via-gateway" && f.agents.some((a) => a.name === "Codex 员工")));
    const second = deps(fake, [row({ request_tags: [], spend: 0.016 })], [run], state);
    await runOnce(second.deps);
    assert.ok(!second.logs.some(([e]) => e === "unattributed" || e === "not-via-gateway"), "not again within the hour");
  });

  it("fills in the launcher before writing spend, without touching other agents", async () => {
    const agents = [
      { id: "a1", name: "AI情报员", adapterType: "claude_local", adapterConfig: { model: "deepseek-chat" }, runtimeConfig: { aiConnection: { connectionId: "conn-gw" } } },
      { id: "a2", name: "CFO", adapterType: "claude_local", adapterConfig: { agentCommand: "/opt/custom" }, runtimeConfig: { aiConnection: { connectionId: "conn-gw" } } },
    ];
    const fake = fakePaperclip({ connections: [gateway], agents });
    const { deps: d } = deps(fake, [row()]);
    const stats = await runOnce(d);
    const patches = fake.calls.filter((c) => c.method === "PATCH");
    assert.deepEqual(patches.map((p) => [p.route, p.body]), [["/api/agents/a1", { adapterConfig: { model: "deepseek-chat", agentCommand: LAUNCHER } }]]);
    const order = fake.calls.map((c) => c.method);
    assert.ok(order.indexOf("PATCH") < fake.calls.findIndex((c) => c.route.endsWith("/cost-events")));
    assert.equal(stats.patched, 1);
  });

  it("uses the live gateway connection, not a revoked one with the same name", async () => {
    const agents = [{ id: "a1", name: "x", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aiConnection: { connectionId: "conn-new" } } }];
    const fake = fakePaperclip({ connections: [{ id: "conn-old", name: "模型网关", status: "revoked" }, { id: "conn-new", name: "模型网关", status: "connected" }], agents });
    const { deps: d } = deps(fake, []);
    await runOnce(d);
    assert.equal(fake.calls.filter((c) => c.method === "PATCH").length, 1);
  });

  it("skips filling in when the gateway connection does not exist, but still writes spend", async () => {
    const agents = [{ id: "a1", name: "x", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aiConnection: { connectionId: "conn-gw" } } }];
    const fake = fakePaperclip({ connections: [], agents });
    const { deps: d, logs } = deps(fake, [row()]);
    const stats = await runOnce(d);
    assert.equal(fake.calls.filter((c) => c.method === "PATCH").length, 0);
    assert.ok(logs.some(([e]) => e === "gateway-connection-missing"));
    assert.equal(stats.posted, 1);
    const again = await runOnce({ ...d, log: (e) => logs.push([`again:${e}`]) });
    assert.ok(!logs.some(([e]) => e === "again:gateway-connection-missing"), "logged once, not every round");
    assert.equal(again.posted, 1);
  });

  it("logs a failed write and continues with the next row (the next round retries it)", async () => {
    const fake = fakePaperclip({ connections: [gateway], failCostEvents: true });
    const { deps: d, logs } = deps(fake, [row(), row({ request_id: "req-2" })]);
    const stats = await runOnce(d);
    assert.equal(stats.failed, 2);
    assert.equal(logs.filter(([e]) => e === "write-failed").length, 2);
  });
});
