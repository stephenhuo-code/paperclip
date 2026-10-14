import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { assertCompanyAdmin } from "../auth/company-admin.js";
import { HttpError } from "../errors.js";

const companyId = "company-1";

function boardReq(actor: Record<string, unknown>) {
  return { actor: { type: "board", userId: "user-1", source: "session", ...actor } } as unknown as Request;
}

function accessWith(membership: Record<string, unknown> | null) {
  return { getMembership: vi.fn(async () => membership) };
}

describe("assertCompanyAdmin", () => {
  it("allows local trusted mode without a membership lookup", async () => {
    const access = accessWith(null);
    await expect(
      assertCompanyAdmin(boardReq({ source: "local_implicit" }), access, companyId, "approve agent hires"),
    ).resolves.toBeUndefined();
    expect(access.getMembership).not.toHaveBeenCalled();
  });

  it("allows instance admins", async () => {
    await expect(
      assertCompanyAdmin(boardReq({ isInstanceAdmin: true }), accessWith(null), companyId, "approve agent hires"),
    ).resolves.toBeUndefined();
  });

  it.each(["owner", "admin"])("allows active %s members", async (membershipRole) => {
    const access = accessWith({ membershipRole, status: "active" });
    await expect(
      assertCompanyAdmin(boardReq({}), access, companyId, "approve agent hires"),
    ).resolves.toBeUndefined();
    expect(access.getMembership).toHaveBeenCalledWith(companyId, "user", "user-1");
  });

  it.each([
    ["operator", "active"],
    ["viewer", "active"],
    ["admin", "suspended"],
  ])("rejects %s members with status %s", async (membershipRole, status) => {
    const error = await assertCompanyAdmin(
      boardReq({}),
      accessWith({ membershipRole, status }),
      companyId,
      "approve agent hires",
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).message).toBe("Only company owners and admins can approve agent hires");
  });

  it("rejects non-members and agent actors", async () => {
    await expect(
      assertCompanyAdmin(boardReq({}), accessWith(null), companyId, "approve agent hires"),
    ).rejects.toMatchObject({ status: 403 });
    const agentReq = { actor: { type: "agent", agentId: "agent-1", source: "agent_key" } } as unknown as Request;
    await expect(
      assertCompanyAdmin(agentReq, accessWith({ membershipRole: "admin", status: "active" }), companyId, "approve agent hires"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
