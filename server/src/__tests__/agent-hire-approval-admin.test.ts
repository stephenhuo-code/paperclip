import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Governance for spec 002 (US1): only company owners and admins decide agent
// hires and change the hire-approval setting. Other approvals, agent actions
// and company settings keep their existing rules.

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  findOpenHireApprovalForAgent: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  activatePendingApproval: vi.fn(),
  terminate: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  getMembership: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../services/authorization.js", async (importActual) => ({
  ...await importActual<typeof import("../services/authorization.js")>(),
  canActorReadApproval: async () => true,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  approvalService: () => mockApprovalService,
  budgetService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companyArtifactsService: () => ({}),
  companyPortabilityService: () => ({}),
  companyService: () => mockCompanyService,
  companySkillService: () => ({}),
  feedbackService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

let routeModules: Promise<[
  typeof import("../middleware/index.js"),
  typeof import("../routes/approvals.js"),
  typeof import("../routes/agents.js"),
  typeof import("../routes/companies.js"),
]> | null = null;

function emptySelectDb() {
  const rows = {
    then: (resolve: (value: unknown[]) => unknown) => resolve([]),
  };
  return {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => rows) })) })),
  } as any;
}

async function createApp(role: "operator" | "admin" | "owner") {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
    import("../routes/agents.js"),
    import("../routes/companies.js"),
  ]);
  const [{ errorHandler }, { approvalRoutes }, { agentRoutes }, { companyRoutes }] = await routeModules;
  mockAccessService.getMembership.mockResolvedValue({ membershipRole: role, status: "active" });
  const db = emptySelectDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(db));
  app.use("/api", agentRoutes(db));
  app.use("/api/companies", companyRoutes(db));
  app.use(errorHandler);
  return app;
}

function approvalRow(type: string, status = "pending") {
  return { id: "approval-1", companyId, type, status, payload: {}, requestedByAgentId: null };
}

function agentRow(status: string) {
  return {
    id: agentId,
    companyId,
    name: "Builder",
    role: "engineer",
    status,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    metadata: null,
  };
}

function companyRow(requireBoardApprovalForNewAgents: boolean) {
  return { id: companyId, name: "Acme", status: "active", requireBoardApprovalForNewAgents };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAccessService.decide.mockResolvedValue({
    allowed: true,
    action: "agents:create",
    reason: "allow_test",
    explanation: "Allowed by test mock.",
  });
  mockApprovalService.approve.mockImplementation(async () => ({ approval: approvalRow("hire_agent", "approved"), applied: false }));
  mockApprovalService.reject.mockImplementation(async () => ({ approval: approvalRow("hire_agent", "rejected"), applied: false }));
  mockApprovalService.requestRevision.mockImplementation(async () => approvalRow("hire_agent", "revision_requested"));
  mockApprovalService.findOpenHireApprovalForAgent.mockResolvedValue(null);
  mockAgentService.activatePendingApproval.mockResolvedValue({ activated: true, agent: agentRow("idle") });
  mockAgentService.terminate.mockResolvedValue(agentRow("terminated"));
  mockHeartbeatService.cancelInvocationsForAgents.mockResolvedValue({ agentIds: [], runsCancelled: 0, wakeupsCancelled: 0 });
  mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
  mockCompanyService.update.mockImplementation(async (_id: string, body: Record<string, unknown>) => ({
    ...companyRow(true),
    ...body,
  }));
  mockLogActivity.mockResolvedValue(undefined);
});

describe("hire approval decisions", () => {
  const decisions = [
    ["approve", () => mockApprovalService.approve],
    ["reject", () => mockApprovalService.reject],
    ["request-revision", () => mockApprovalService.requestRevision],
  ] as const;

  it.each(decisions)("blocks operators from %s on hire approvals", async (decision, serviceCall) => {
    mockApprovalService.getById.mockResolvedValue(approvalRow("hire_agent"));
    const res = await request(await createApp("operator"))
      .post(`/api/approvals/approval-1/${decision}`)
      .send({ decisionNote: "note" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only company owners and admins can decide agent hires");
    expect(serviceCall()).not.toHaveBeenCalled();
  });

  it.each(decisions)("lets admins %s hire approvals", async (decision, serviceCall) => {
    mockApprovalService.getById.mockResolvedValue(approvalRow("hire_agent"));
    const res = await request(await createApp("admin"))
      .post(`/api/approvals/approval-1/${decision}`)
      .send({ decisionNote: "note" });
    expect(res.status).toBe(200);
    expect(serviceCall()).toHaveBeenCalled();
  });

  it.each(decisions)("keeps the existing rule for operators on other approval types (%s)", async (decision, serviceCall) => {
    mockApprovalService.getById.mockResolvedValue(approvalRow("request_board_approval"));
    const res = await request(await createApp("operator"))
      .post(`/api/approvals/approval-1/${decision}`)
      .send({ decisionNote: "note" });
    expect(res.status).toBe(200);
    expect(serviceCall()).toHaveBeenCalled();
  });
});

describe("pending agent decisions on the agent detail page", () => {
  it("blocks operators from approving a pending agent", async () => {
    mockAgentService.getById.mockResolvedValue(agentRow("pending_approval"));
    const res = await request(await createApp("operator")).post(`/api/agents/${agentId}/approve`).send({});
    expect(res.status).toBe(403);
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("lets owners approve a pending agent", async () => {
    mockAgentService.getById.mockResolvedValue(agentRow("pending_approval"));
    const res = await request(await createApp("owner")).post(`/api/agents/${agentId}/approve`).send({});
    expect(res.status).toBe(200);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith(agentId);
  });

  it("blocks operators from terminating a pending agent, which would reject its hire", async () => {
    mockAgentService.getById.mockResolvedValue(agentRow("pending_approval"));
    mockApprovalService.findOpenHireApprovalForAgent.mockResolvedValue(approvalRow("hire_agent"));
    const res = await request(await createApp("operator")).post(`/api/agents/${agentId}/terminate`).send({});
    expect(res.status).toBe(403);
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("lets admins terminate a pending agent", async () => {
    mockAgentService.getById.mockResolvedValue(agentRow("pending_approval"));
    const res = await request(await createApp("admin")).post(`/api/agents/${agentId}/terminate`).send({});
    expect(res.status).toBe(200);
    expect(mockAgentService.terminate).toHaveBeenCalledWith(agentId);
  });

  it("keeps the existing rule for operators terminating an approved agent", async () => {
    mockAgentService.getById.mockResolvedValue(agentRow("idle"));
    const res = await request(await createApp("operator")).post(`/api/agents/${agentId}/terminate`).send({});
    expect(res.status).toBe(200);
    expect(mockAgentService.terminate).toHaveBeenCalledWith(agentId);
  });
});

describe("hire approval setting", () => {
  it("blocks operators from changing the setting", async () => {
    mockCompanyService.getById.mockResolvedValue(companyRow(true));
    const res = await request(await createApp("operator"))
      .patch(`/api/companies/${companyId}`)
      .send({ requireBoardApprovalForNewAgents: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only company owners and admins can change agent hire approval");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("lets operators save other settings, including an unchanged setting value", async () => {
    mockCompanyService.getById.mockResolvedValue(companyRow(true));
    const res = await request(await createApp("operator"))
      .patch(`/api/companies/${companyId}`)
      .send({ name: "Acme Two", requireBoardApprovalForNewAgents: true });
    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalled();
  });

  it("lets admins change the setting", async () => {
    mockCompanyService.getById.mockResolvedValue(companyRow(true));
    const res = await request(await createApp("admin"))
      .patch(`/api/companies/${companyId}`)
      .send({ requireBoardApprovalForNewAgents: false });
    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalled();
  });
});
