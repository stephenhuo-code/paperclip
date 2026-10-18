// gateway-sync logic (specs/006-litellm-gateway-billing), kept free of I/O so
// it can be tested with fakes. sync.mjs wires it to the databases and Paperclip.

const RUN_TAG = "paperclip-run:";
const TASK_TAG = "paperclip-task:";

/** The run and task the ACP launcher attached to a request (x-litellm-tags). */
export function parseRunTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const value = (prefix) => {
    const tag = list.find((t) => typeof t === "string" && t.startsWith(prefix));
    const id = tag?.slice(prefix.length);
    return id && id !== "none" ? id : null;
  };
  return { runId: value(RUN_TAG), taskId: value(TASK_TAG) };
}

/** LiteLLM stores naive UTC timestamps. */
function toIsoUtc(value) {
  const text = String(value).replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`).toISOString();
}

/** A LiteLLM spend row as a Paperclip cost event for its run. */
export function toCostEvent(row, run) {
  const cacheRead = row.usage?.cache_read_input_tokens ?? 0;
  return {
    idempotencyKey: `litellm:${row.request_id}`,
    agentId: run.agentId,
    heartbeatRunId: run.id,
    issueId: run.issueId ?? null,
    projectId: run.projectId ?? null,
    provider: "litellm",
    biller: "litellm",
    billingType: "metered_api",
    costStatus: "estimated",
    model: row.model_group,
    // Paperclip counts cache writes in inputTokens and cache reads separately.
    inputTokens: Math.max((row.prompt_tokens ?? 0) - cacheRead, 0),
    cachedInputTokens: cacheRead,
    outputTokens: row.completion_tokens ?? 0,
    costCents: (Number(row.spend) * 100).toFixed(7),
    providerRequestId: row.request_id,
    occurredAt: toIsoUtc(row.startTime),
  };
}

/** Compare gateway addresses: case-insensitive scheme and host, no trailing "/" or "/v1". */
export function normalizeGatewayUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${url.protocol}//${url.host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Ids of the live AI connections that point at the configured gateway, whatever they are called. */
export function gatewayConnectionIds(connections, gatewayUrl) {
  const target = normalizeGatewayUrl(gatewayUrl);
  if (!target) return new Set();
  return new Set(connections
    .filter((c) => c.status !== "revoked" && normalizeGatewayUrl(c.routing?.baseUrl) === target)
    .map((c) => c.id));
}

/**
 * Fill in the tagging launcher only where nothing was chosen: a Claude Code
 * agent on a gateway connection, on the ACP engine, with an empty ACP command.
 * Anything customized is left alone and reported as not via the gateway.
 */
export function reconcileAgent(agent, { gatewayConnectionIds: gateways, launcher }) {
  if (agent.adapterType !== "claude_local") return { action: "skip", reason: "not Claude Code" };
  if (!gateways.has(agent.runtimeConfig?.aiConnection?.connectionId)) {
    return { action: "skip", reason: "not on a gateway connection" };
  }
  if (agent.adapterConfig?.engine === "cli") return { action: "skip", reason: "Claude CLI engine (uses no ACP command)" };
  const command = agent.adapterConfig?.agentCommand;
  if (command === launcher) return { action: "ok" };
  if (command) return { action: "skip", reason: "custom ACP server command" };
  return { action: "patch", adapterConfig: { ...agent.adapterConfig, agentCommand: launcher } };
}

/** Paperclip API as the sync account: session cookie, one re-login on 401. */
export function createPaperclipClient({ baseUrl, origin = baseUrl, email, password, fetchImpl = fetch }) {
  let cookie = null;
  const headers = () => ({ origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) });

  async function signIn() {
    const res = await fetchImpl(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST", headers: headers(), body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`Paperclip sign-in failed (HTTP ${res.status})`);
    const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
    cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  }

  async function request(method, route, body) {
    if (!cookie) await signIn();
    const send = () => fetchImpl(`${baseUrl}${route}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
    let res = await send();
    if (res.status === 401) { await signIn(); res = await send(); }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (route) => request("GET", route),
    post: (route, body) => request("POST", route, body),
    patch: (route, body) => request("PATCH", route, body),
  };
}

const asList = (value, key) => (Array.isArray(value) ? value : value?.[key] ?? []);

async function reconcileAgents({ paperclip, config, state, log }, stats) {
  state.missingConnection ??= new Set();
  const notViaGateway = [];
  if (!normalizeGatewayUrl(config.gatewayUrl)) {
    if (!state.warnedNoGatewayUrl) log("gateway-url-missing", { hint: "set PAPERCLIP_GATEWAY_URL in environments/<env>.env" });
    state.warnedNoGatewayUrl = true;
    return notViaGateway;
  }
  for (const company of asList(await paperclip.get("/api/companies"), "companies")) {
    const connections = asList(await paperclip.get(`/api/companies/${company.id}/ai-connections`), "connections");
    const gateways = gatewayConnectionIds(connections, config.gatewayUrl);
    const agents = asList(await paperclip.get(`/api/companies/${company.id}/agents`), "agents");
    if (gateways.size === 0) {
      // Once per company until the connection appears; the hourly report repeats it.
      if (!state.missingConnection.has(company.id)) {
        log("gateway-connection-missing", { companyId: company.id, gatewayUrl: config.gatewayUrl });
        state.missingConnection.add(company.id);
      }
      for (const a of agents) notViaGateway.push({ name: a.name, reason: "no gateway connection in this company" });
      continue;
    }
    state.missingConnection.delete(company.id);
    for (const agent of agents) {
      const result = reconcileAgent(agent, { gatewayConnectionIds: gateways, launcher: config.launcher });
      if (result.action === "patch") {
        await paperclip.patch(`/api/agents/${agent.id}`, { adapterConfig: result.adapterConfig });
        stats.patched++;
        log("launcher-set", { agent: agent.name });
      } else if (result.action === "skip") {
        notViaGateway.push({ name: agent.name, reason: result.reason });
      }
    }
  }
  return notViaGateway;
}

/** One round: fill in launchers, then write back the last window of spend. */
export async function runOnce(deps) {
  const { db, paperclip, config, now, state, log } = deps;
  const stats = { patched: 0, posted: 0, failed: 0, unattributed: { count: 0, usd: 0 } };
  const notViaGateway = await reconcileAgents(deps, stats);

  const since = new Date(now().getTime() - config.windowMs).toISOString();
  const rows = (await db.spendRows(since)).filter((r) => r.status !== "failure" && Number(r.spend) > 0);
  const tagged = rows.map((r) => ({ row: r, ...parseRunTags(r.request_tags) }));
  const runIds = [...new Set(tagged.map((t) => t.runId).filter(Boolean))];
  const runs = new Map((runIds.length ? await db.runs(runIds) : []).map((r) => [r.id, r]));

  for (const { row, runId } of tagged) {
    const run = runId ? runs.get(runId) : undefined;
    if (!run) {
      stats.unattributed.count++;
      stats.unattributed.usd += Number(row.spend);
      continue;
    }
    try {
      await paperclip.post(`/api/companies/${run.companyId}/cost-events`, toCostEvent(row, run));
      stats.posted++;
    } catch (error) {
      stats.failed++;
      log("write-failed", { requestId: row.request_id, error: error.message });
    }
  }

  const last = state.lastReportAt ?? 0;
  if (now().getTime() - last >= config.reportEveryMs) {
    log("unattributed", { ...stats.unattributed, windowHours: config.windowMs / 3600_000 });
    log("not-via-gateway", { agents: notViaGateway });
    state.lastReportAt = now().getTime();
  }
  return stats;
}

/** What gateway-sync reports about its last round (read by deploy.sh). */
export function syncStatus({ accountConfigured, gatewayUrl, stats, error, at }) {
  const base = { at: at.toISOString() };
  if (!accountConfigured) return { ...base, status: "account-missing" };
  if (error) return { ...base, status: /sign-in failed/i.test(error.message) ? "login-failed" : "error", error: error.message };
  const counts = { posted: stats?.posted ?? 0, patched: stats?.patched ?? 0, failed: stats?.failed ?? 0 };
  if (!normalizeGatewayUrl(gatewayUrl)) return { ...base, status: "gateway-url-missing", ...counts };
  return { ...base, status: "ok", ...counts };
}
