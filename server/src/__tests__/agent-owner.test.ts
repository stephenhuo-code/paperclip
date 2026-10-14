import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { canEditOwnAgent } from "../auth/agent-owner.js";

const companyId = "company-1";
const agent = { id: "agent-1", companyId, createdByUserId: "user-a" };

function boardReq(userId = "user-a") {
  return { actor: { type: "board", userId, source: "session", companyIds: [companyId] } } as unknown as Request;
}

function accessAllowingCreate(allowed: boolean) {
  return {
    decide: vi.fn(async () => ({
      allowed,
      action: "agents:create",
      reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: "test",
    })),
  };
}

describe("canEditOwnAgent", () => {
  it("lets the creator edit while they can still create agents", async () => {
    const access = accessAllowingCreate(true);
    await expect(canEditOwnAgent(boardReq(), access, agent)).resolves.toBe(true);
    expect(access.decide).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agents:create", resource: { type: "company", companyId } }),
    );
  });

  it("refuses someone who did not create the agent", async () => {
    await expect(canEditOwnAgent(boardReq("user-b"), accessAllowingCreate(true), agent)).resolves.toBe(false);
  });

  it("refuses when the agent has no recorded creator", async () => {
    await expect(
      canEditOwnAgent(boardReq(), accessAllowingCreate(true), { ...agent, createdByUserId: null }),
    ).resolves.toBe(false);
  });

  it("refuses the creator after their agent-creator role is removed", async () => {
    await expect(canEditOwnAgent(boardReq(), accessAllowingCreate(false), agent)).resolves.toBe(false);
  });

  it("refuses agent actors", async () => {
    const agentReq = { actor: { type: "agent", agentId: "agent-2", source: "agent_key" } } as unknown as Request;
    const access = accessAllowingCreate(true);
    await expect(canEditOwnAgent(agentReq, access, agent)).resolves.toBe(false);
    expect(access.decide).not.toHaveBeenCalled();
  });
});
