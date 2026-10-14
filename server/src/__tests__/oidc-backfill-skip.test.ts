import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { oidcSkipHumanGrant } from "../auth/oidc.js";
import { backfillPrincipalAccessCompatibility } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres OIDC backfill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Spec 002 FR-003: permissions revoked by the SSO sync must not come back when
// the server restarts and backfills default role grants.
describeEmbeddedPostgres("startup backfill with OIDC", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oidc-backfill-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(authAccounts);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const now = new Date();
    const company = await db
      .insert(companies)
      .values({ name: `OIDC ${randomUUID()}`, issuePrefix: `OB${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const ssoUserId = `sso-${randomUUID()}`;
    const localUserId = `local-${randomUUID()}`;
    await db.insert(authUsers).values([
      { id: ssoUserId, name: "SSO", email: `${ssoUserId}@example.cn`, createdAt: now, updatedAt: now },
      { id: localUserId, name: "Local", email: `${localUserId}@example.cn`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(authAccounts).values([
      { id: randomUUID(), issuer: "https://sso.example.cn", accountId: ssoUserId, providerId: "keycloak", userId: ssoUserId, createdAt: now, updatedAt: now },
      { id: randomUUID(), issuer: "local", accountId: localUserId, providerId: "credential", userId: localUserId, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: ssoUserId, status: "active", membershipRole: "operator" },
      { companyId: company.id, principalType: "user", principalId: localUserId, status: "active", membershipRole: "operator" },
    ]);
    return { companyId: company.id, ssoUserId, localUserId };
  }

  async function keys(companyId: string, userId: string) {
    const rows = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, userId)));
    return rows.map((row) => row.permissionKey);
  }

  it("does not restore agents:create or agents:configure for Keycloak operators", async () => {
    const { companyId, ssoUserId, localUserId } = await seed();

    await backfillPrincipalAccessCompatibility(db, { skipHumanGrant: await oidcSkipHumanGrant(db) });

    const ssoKeys = await keys(companyId, ssoUserId);
    expect(ssoKeys).not.toContain("agents:create");
    expect(ssoKeys).not.toContain("agents:configure");
    expect(ssoKeys).toContain("tasks:assign");

    const localKeys = await keys(companyId, localUserId);
    expect(localKeys).toContain("agents:create");
    expect(localKeys).toContain("agents:configure");
  });

  it("keeps the upstream behavior without the option", async () => {
    const { companyId, ssoUserId } = await seed();

    await backfillPrincipalAccessCompatibility(db);

    const ssoKeys = await keys(companyId, ssoUserId);
    expect(ssoKeys).toContain("agents:create");
    expect(ssoKeys).toContain("agents:configure");
  });
});
