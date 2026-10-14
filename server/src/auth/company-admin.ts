import type { Request } from "express";
import { forbidden } from "../errors.js";

interface CompanyMembershipLookup {
  getMembership(
    companyId: string,
    principalType: "user",
    principalId: string,
  ): Promise<{ membershipRole?: string | null; status?: string | null } | null>;
}

/**
 * Governed agent-hire decisions belong to company owners and admins, not to
 * every board member. Local trusted mode and instance admins keep full control.
 */
export async function assertCompanyAdmin(
  req: Request,
  access: CompanyMembershipLookup,
  companyId: string,
  action: string,
): Promise<void> {
  const actor = req.actor;
  if (actor.type === "board") {
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
    if (actor.userId) {
      const membership = await access.getMembership(companyId, "user", actor.userId);
      if (
        membership?.status === "active" &&
        (membership.membershipRole === "owner" || membership.membershipRole === "admin")
      ) {
        return;
      }
    }
  }
  throw forbidden(`Only company owners and admins can ${action}`);
}
