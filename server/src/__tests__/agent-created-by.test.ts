import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  budgetPolicies,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { authorizeInstructionCommit } from "../services/agent-instruction-authorization.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent creator tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Spec 002 US3 / FR-006: the platform records who created each agent.
describeEmbeddedPostgres("agent creator column", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-created-by-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(budgetPolicies);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  const agentInput = {
    name: "Builder",
    role: "engineer",
    adapterType: "process",
    adapterConfig: { command: "echo safe" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    status: "idle",
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
  } as const;

  async function creatorOf(agentId: string) {
    const rows = await db
      .select({ createdByUserId: agents.createdByUserId })
      .from(agents)
      .where(eq(agents.id, agentId));
    return rows[0]?.createdByUserId;
  }

  it("stores the board user who created the agent", async () => {
    const companyId = await seedCompany();
    const created = await agentService(db).create(companyId, { ...agentInput }, { createdByUserId: "user-a" });
    expect(await creatorOf(created.id)).toBe("user-a");
  });

  it("leaves the creator empty when no user created the agent", async () => {
    const companyId = await seedCompany();
    const created = await agentService(db).create(companyId, { ...agentInput });
    expect(await creatorOf(created.id)).toBeNull();
  });

  it("migration 0320 backfills the creator of older agents from the activity log", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const direct = await svc.create(companyId, { ...agentInput, name: "Direct" });
    const hired = await svc.create(companyId, { ...agentInput, name: "Hired" });
    const byAgent = await svc.create(companyId, { ...agentInput, name: "By agent" });
    const known = await svc.create(companyId, { ...agentInput, name: "Known" }, { createdByUserId: "user-known" });
    await db.insert(activityLog).values([
      { companyId, actorType: "user", actorId: "user-a", action: "agent.created", entityType: "agent", entityId: direct.id },
      { companyId, actorType: "user", actorId: "user-b", action: "agent.hire_created", entityType: "agent", entityId: hired.id },
      { companyId, actorType: "user", actorId: "user-c", action: "agent.updated", entityType: "agent", entityId: hired.id },
      { companyId, actorType: "agent", actorId: "agent-ceo", action: "agent.hire_created", entityType: "agent", entityId: byAgent.id },
      { companyId, actorType: "user", actorId: "user-d", action: "agent.created", entityType: "agent", entityId: known.id },
    ]);

    const migration = readFileSync(
      new URL("../../../packages/db/src/migrations/0320_fixed_northstar.sql", import.meta.url),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").find((statement) => statement.includes("UPDATE"));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(backfill!));

    expect(await creatorOf(direct.id)).toBe("user-a");
    expect(await creatorOf(hired.id)).toBe("user-b");
    expect(await creatorOf(byAgent.id)).toBeNull();
    expect(await creatorOf(known.id)).toBe("user-known");
  });

  // Instruction files (AGENTS.md and the rest of the bundle) are authorized in
  // the service layer, not by the route checks.
  async function seedOperators(companyId: string, grants: Record<string, string[]>) {
    for (const [userId, keys] of Object.entries(grants)) {
      await db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator",
      });
      if (keys.length > 0) {
        await db.insert(principalPermissionGrants).values(keys.map((permissionKey) => ({
          companyId, principalType: "user", principalId: userId, permissionKey,
        })));
      }
    }
  }

  function boardActor(userId: string) {
    return { type: "board" as const, userId, source: "session" as const };
  }

  it("lets the creator commit instruction files of their own agent", async () => {
    const companyId = await seedCompany();
    const created = await agentService(db).create(companyId, { ...agentInput }, { createdByUserId: "user-a" });
    await seedOperators(companyId, { "user-a": ["agents:create"], "user-b": ["agents:create"] });

    await expect(authorizeInstructionCommit(db, boardActor("user-a"), created)).resolves.toBeTruthy();
    await expect(authorizeInstructionCommit(db, boardActor("user-b"), created)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses the creator once they can no longer create agents", async () => {
    const companyId = await seedCompany();
    const created = await agentService(db).create(companyId, { ...agentInput }, { createdByUserId: "user-a" });
    await seedOperators(companyId, { "user-a": [] });

    await expect(authorizeInstructionCommit(db, boardActor("user-a"), created)).rejects.toMatchObject({ status: 403 });
  });
});
