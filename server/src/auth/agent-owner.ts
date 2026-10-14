import type { Request } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";

interface AgentCreateDecision {
  decide(input: {
    actor: AuthorizationActor;
    action: "agents:create";
    resource: { type: "company"; companyId: string };
  }): Promise<{ allowed: boolean }>;
}

type Connection = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

async function creatorMayEdit(
  actor: AuthorizationActor,
  access: AgentCreateDecision,
  agent: { companyId: string; createdByUserId?: string | null },
): Promise<boolean> {
  if (actor.type !== "board" || !actor.userId || !agent.createdByUserId) return false;
  if (agent.createdByUserId !== actor.userId) return false;
  const decision = await access.decide({
    actor,
    action: "agents:create",
    resource: { type: "company", companyId: agent.companyId },
  });
  return decision.allowed;
}

/**
 * The board user who created an agent may change it while they can still
 * create agents (Keycloak role agent-creator). Everyone else needs
 * agents:configure. See specs/002-agent-governance (US3, FR-006).
 */
export async function canEditOwnAgent(
  req: Request,
  access: AgentCreateDecision,
  agent: { companyId: string; createdByUserId?: string | null },
): Promise<boolean> {
  return creatorMayEdit(req.actor as AuthorizationActor, access, agent);
}

/** Same rule for service-layer checks (instruction files), which only have the agent id. */
export async function canEditOwnAgentById(
  db: Connection,
  actor: AuthorizationActor,
  target: { companyId: string; id: string },
): Promise<boolean> {
  if (actor.type !== "board") return false;
  const [row] = await db
    .select({ companyId: agents.companyId, createdByUserId: agents.createdByUserId })
    .from(agents)
    .where(eq(agents.id, target.id));
  if (!row || row.companyId !== target.companyId) return false;
  return creatorMayEdit(actor, authorizationService(db as Db), row);
}
