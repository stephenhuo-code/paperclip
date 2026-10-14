import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdByUserId: "creator-user",
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getConfigRevision: vi.fn(),
  listConfigRevisions: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  activatePendingApproval: vi.fn(),
  terminate: vi.fn(),
  update: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  findOpenHireApprovalForAgent: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
    return {
      ...actual,
      ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
    };
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/approvals.js", () => ({
    approvalService: () => mockApprovalService,
  }));

  vi.doMock("../services/company-skills.js", () => ({
    companySkillService: () => mockCompanySkillService,
  }));

  vi.doMock("../services/budgets.js", () => ({
    budgetService: () => mockBudgetService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issue-approvals.js", () => ({
    issueApprovalService: () => mockIssueApprovalService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => mockAgentInstructionsService,
    agentInstructionsBundleMode: (agent: { adapterConfig?: unknown }) => {
      const config = agent.adapterConfig as Record<string, unknown> | undefined;
      return config?.instructionsBundleMode === "external" ? "external" : "managed";
    },
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));

  vi.doMock("../services/workspace-operations.js", () => ({
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => mockBuiltInAgentService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationService,
    environmentService: () => mockEnvironmentService,
  }));
}

function createDbStub(options: { requireBoardApprovalForNewAgents?: boolean } = {}) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve([{
              id: companyId,
              name: "Paperclip",
              requireBoardApprovalForNewAgents: options.requireBoardApprovalForNewAgents ?? false,
            }])),
          ),
        }),
      }),
    }),
  };
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

// Spec 002 US3 / FR-006: creators edit the agents they created; others need agents:configure.
// Harness copied from agent-permissions-routes.test.ts.
describe("agent creator edit routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { agentRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    ]);
    return { errorHandler, agentRoutes };
  });

  function createApp(actor: Record<string, unknown>, dbOptions: { requireBoardApprovalForNewAgents?: boolean } = {}) {
    const { errorHandler, agentRoutes } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        ...actor,
        companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
      };
      next();
    });
    app.use("/api", agentRoutes(createDbStub(dbOptions) as any));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockAgentService.getById.mockReset();
    mockAgentService.getConfigRevision.mockReset();
    mockAgentService.listConfigRevisions.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.create.mockReset();
    mockAgentService.activatePendingApproval.mockReset();
    mockAgentService.terminate.mockReset();
    mockAgentService.update.mockReset();
    mockAgentService.rollbackConfigRevision.mockReset();
    mockAgentService.updatePermissions.mockReset();
    mockAgentService.getChainOfCommand.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAccessService.getMembership.mockReset();
    mockAccessService.ensureMembership.mockReset();
    mockAccessService.listPrincipalGrants.mockReset();
    mockAccessService.setPrincipalPermission.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.findOpenHireApprovalForAgent.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockBudgetService.upsertPolicy.mockReset();
    mockHeartbeatService.listTaskSessions.mockReset();
    mockHeartbeatService.resetRuntimeSession.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelInvocationsForAgents.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockIssueService.list.mockReset();
    mockSecretService.normalizeAdapterConfigForPersistence.mockReset();
    mockSecretService.resolveAdapterConfigForRuntime.mockReset();
    mockAgentInstructionsService.materializeManagedBundle.mockReset();
    mockCompanySkillService.listRuntimeSkillEntries.mockReset();
    mockCompanySkillService.resolveRequestedSkillKeys.mockReset();
    mockLogActivity.mockReset();
    mockTrackAgentCreated.mockReset();
    mockGetTelemetryClient.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockReset();
    mockInstanceSettingsService.getGeneral.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getConfigRevision.mockResolvedValue(null);
    mockAgentService.listConfigRevisions.mockResolvedValue([]);
    mockAgentService.list.mockResolvedValue([baseAgent]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.activatePendingApproval.mockResolvedValue({
      agent: baseAgent,
      activated: false,
    });
    mockAgentService.update.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = Boolean(await mockAccessService.canUser());
      return {
        allowed,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant" : `Missing test grant for ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_companyId, requested) => requested);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  function boardActor(userId: string) {
    return { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId] };
  }

  function allowOnly(actions: string[]) {
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = actions.includes(input.action ?? "");
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_no_grant",
        explanation: allowed ? "Allowed by test grant" : `Missing test grant for ${input.action ?? "action"}`,
      };
    });
  }

  it("lets the creator change the configuration of their own agent", async () => {
    allowOnly(["agents:create", "agent:read", "agent_config:read"]);
    const res = await requestApp(createApp(boardActor("creator-user")), (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ icon: "code" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("lets the creator change the profile of their own agent", async () => {
    allowOnly(["agents:create", "agent:read", "agent_config:read"]);
    const res = await requestApp(createApp(boardActor("creator-user")), (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ title: "Lead Builder" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it.each([{ icon: "code" }, { title: "Lead Builder" }])("refuses other operators (%o)", async (body) => {
    allowOnly(["agents:create", "agent:read", "agent_config:read"]);
    const res = await requestApp(createApp(boardActor("other-user")), (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send(body));

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("refuses the creator once they can no longer create agents", async () => {
    allowOnly(["agent:read", "agent_config:read"]);
    const res = await requestApp(createApp(boardActor("creator-user")), (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ icon: "code" }));

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("never lets an update rewrite the creator", async () => {
    allowOnly(["agents:create", "agent:read", "agent_config:read"]);
    const res = await requestApp(createApp(boardActor("creator-user")), (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ icon: "code", createdByUserId: "other-user" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("createdByUserId");
  });

  it("keeps the existing rule for users with agents:configure", async () => {
    allowOnly(["agents:create", "agent:read", "agent_config:read", "agent_config:update"]);
    const res = await requestApp(createApp(boardActor("admin-user")), (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ icon: "code" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
