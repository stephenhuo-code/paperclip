import { describe, expect, it, vi } from "vitest";
import {
  extractAgentRoles,
  extractOrganizations,
  oidcSkipsHumanGrant,
  parseOidcConfig,
  reconcileOidcMemberships,
  syncOidcAgentPermissions,
  validateOidcUserInfo,
  type OidcConfig,
} from "../auth/oidc.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";

const COMPANY_ID = "5facf42d-f31f-4698-9bc9-e38f876b1579";
const SECRET = "super-secret-client-value";

function oidcEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PAPERCLIP_AUTH_OIDC_ISSUER: "https://sso.example.cn/realms/digital-workforce",
    PAPERCLIP_AUTH_OIDC_CLIENT_ID: "paperclip",
    PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: SECRET,
    PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: JSON.stringify({ acme: COMPANY_ID }),
    ...overrides,
  };
}

describe("parseOidcConfig", () => {
  it("leaves OIDC disabled when no OIDC variables are set", () => {
    expect(parseOidcConfig({})).toEqual({ authOidc: null, authSessionTtlSeconds: undefined });
  });

  it("enables OIDC when issuer, client id and client secret are all set", () => {
    const { authOidc } = parseOidcConfig(oidcEnv());
    expect(authOidc).toEqual({
      issuer: "https://sso.example.cn/realms/digital-workforce",
      clientId: "paperclip",
      clientSecret: SECRET,
      orgCompanyMap: { acme: COMPANY_ID },
      label: "Sign in with SSO",
    });
  });

  it.each([
    ["PAPERCLIP_AUTH_OIDC_ISSUER"],
    ["PAPERCLIP_AUTH_OIDC_CLIENT_ID"],
    ["PAPERCLIP_AUTH_OIDC_CLIENT_SECRET"],
  ])("fails loudly when only part of the required settings is present (missing %s)", (missing) => {
    expect(() => parseOidcConfig(oidcEnv({ [missing]: undefined }))).toThrow(missing);
  });

  it("never includes the client secret in configuration errors", () => {
    let message = "";
    try {
      parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_ISSUER: undefined }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(SECRET);

    try {
      parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: "{not json" }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(SECRET);
  });

  it("rejects an organization map that is not a JSON object", () => {
    expect(() => parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: "{not json" }))).toThrow(
      "PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP",
    );
    expect(() => parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: "[\"acme\"]" }))).toThrow(
      "PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP",
    );
  });

  it("rejects organization map values that are not UUIDs", () => {
    expect(() =>
      parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: JSON.stringify({ acme: "STE" }) })),
    ).toThrow("acme");
  });

  it("fails closed with an empty allowlist when the organization map is missing or empty", () => {
    expect(parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: undefined })).authOidc?.orgCompanyMap)
      .toEqual({});
    expect(parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: "{}" })).authOidc?.orgCompanyMap)
      .toEqual({});
  });

  it("uses a custom button label when provided", () => {
    expect(parseOidcConfig(oidcEnv({ PAPERCLIP_AUTH_OIDC_LABEL: "使用企业账号登录" })).authOidc?.label)
      .toBe("使用企业账号登录");
  });

  it("parses the session TTL as a positive integer and rejects invalid values", () => {
    expect(parseOidcConfig({ PAPERCLIP_AUTH_SESSION_TTL_SECONDS: "86400" }).authSessionTtlSeconds).toBe(86400);
    expect(() => parseOidcConfig({ PAPERCLIP_AUTH_SESSION_TTL_SECONDS: "0" })).toThrow(
      "PAPERCLIP_AUTH_SESSION_TTL_SECONDS",
    );
    expect(() => parseOidcConfig({ PAPERCLIP_AUTH_SESSION_TTL_SECONDS: "1.5" })).toThrow(
      "PAPERCLIP_AUTH_SESSION_TTL_SECONDS",
    );
  });
});

const OTHER_COMPANY_ID = "0b6f1d4e-2c3a-4b5d-8e9f-0a1b2c3d4e5f";

function config(orgCompanyMap: Record<string, string> = { acme: COMPANY_ID }): OidcConfig {
  return {
    issuer: "https://sso.example.cn/realms/digital-workforce",
    clientId: "paperclip",
    clientSecret: SECRET,
    orgCompanyMap,
    label: "Sign in with SSO",
  };
}

function oauthSource(profile: Record<string, unknown>, action = "sign-in") {
  return { action, method: "oauth", oauth: { providerId: "keycloak", profile } };
}

describe("extractOrganizations", () => {
  it("reads the list form of the organization claim", () => {
    expect(extractOrganizations({ organization: ["acme", "beta"] })).toEqual(["acme", "beta"]);
  });

  it("reads organization aliases from the map form of the claim", () => {
    expect(extractOrganizations({ organization: { acme: { id: "x" }, beta: {} } })).toEqual(["acme", "beta"]);
  });

  it.each([
    [{}],
    [{ organization: null }],
    [{ organization: "acme" }],
    [{ organization: [1, null, ""] }],
    [null],
    ["not-an-object"],
  ])("returns no organizations for a missing or malformed claim (%j)", (profile) => {
    expect(extractOrganizations(profile)).toEqual([]);
  });
});

describe("validateOidcUserInfo", () => {
  it("rejects a Keycloak user whose organizations are not in the map", () => {
    expect(
      validateOidcUserInfo(config(), {
        user: { email: "c@example.cn" },
        source: oauthSource({ organization: ["other"] }),
      }),
    ).toEqual({ error: "org_not_allowed" });
  });

  it("rejects a Keycloak user without organizations", () => {
    expect(
      validateOidcUserInfo(config(), { user: { email: "c@example.cn" }, source: oauthSource({}) }),
    ).toEqual({ error: "org_not_allowed" });
  });

  it("rejects everyone when the organization map is empty (fail closed)", () => {
    expect(
      validateOidcUserInfo(config({}), {
        user: { email: "a@example.cn" },
        source: oauthSource({ organization: ["acme"] }),
      }),
    ).toEqual({ error: "org_not_allowed" });
  });

  it("rejects a Keycloak user without an email", () => {
    expect(
      validateOidcUserInfo(config(), { user: {}, source: oauthSource({ organization: ["acme"] }) }),
    ).toEqual({ error: "email_required" });
  });

  it.each(["sign-in", "create-user", "link-account"])("allows a member of a mapped organization (%s)", (action) => {
    expect(
      validateOidcUserInfo(config(), {
        user: { email: "a@example.cn" },
        source: oauthSource({ organization: ["acme"] }, action),
      }),
    ).toBeUndefined();
  });

  it("does not interfere with email and password sign-in (break-glass admin)", () => {
    expect(
      validateOidcUserInfo(config(), {
        user: { email: "admin@example.cn" },
        source: { action: "create-user", method: "email" },
      }),
    ).toBeUndefined();
  });

  it("does not interfere with other OAuth providers", () => {
    expect(
      validateOidcUserInfo(config(), {
        user: { email: "a@example.cn" },
        source: { action: "sign-in", method: "oauth", oauth: { providerId: "github", profile: {} } },
      }),
    ).toBeUndefined();
  });
});

describe("reconcileOidcMemberships", () => {
  function deps(existingCompanyIds: string[] = []) {
    return {
      getMembership: vi.fn(async (companyId: string) =>
        existingCompanyIds.includes(companyId) ? { companyId, membershipRole: "admin" } : null,
      ),
      ensureMembership: vi.fn(async () => ({})),
      setPrincipalGrants: vi.fn(async () => undefined),
      logActivity: vi.fn(async () => ({})),
    };
  }

  it("adds a new user to each mapped company as an operator with default grants", async () => {
    const d = deps();
    const result = await reconcileOidcMemberships(d, {
      userId: "user-a",
      organizations: ["acme", "unmapped"],
      orgCompanyMap: { acme: COMPANY_ID },
    });

    expect(result).toEqual({ joinedCompanyIds: [COMPANY_ID] });
    expect(d.getMembership).toHaveBeenCalledWith(COMPANY_ID, "user", "user-a");
    expect(d.ensureMembership).toHaveBeenCalledTimes(1);
    expect(d.ensureMembership).toHaveBeenCalledWith(COMPANY_ID, "user", "user-a", "operator", "active");
    expect(d.setPrincipalGrants).toHaveBeenCalledWith(
      COMPANY_ID,
      "user",
      "user-a",
      grantsForHumanRole("operator"),
      null,
    );
  });

  it("writes one activity entry per newly created membership", async () => {
    const d = deps();
    await reconcileOidcMemberships(d, {
      userId: "user-a",
      organizations: ["acme"],
      orgCompanyMap: { acme: COMPANY_ID },
    });

    expect(d.logActivity).toHaveBeenCalledTimes(1);
    expect(d.logActivity).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: "user-a",
      action: "company_membership.sso_joined",
      entityType: "user",
      entityId: "user-a",
      details: { providerId: "keycloak", organization: "acme" },
    });
  });

  it("leaves an existing membership and its role untouched", async () => {
    const d = deps([COMPANY_ID]);
    const result = await reconcileOidcMemberships(d, {
      userId: "user-b",
      organizations: ["acme"],
      orgCompanyMap: { acme: COMPANY_ID },
    });

    expect(result).toEqual({ joinedCompanyIds: [] });
    expect(d.ensureMembership).not.toHaveBeenCalled();
    expect(d.setPrincipalGrants).not.toHaveBeenCalled();
    expect(d.logActivity).not.toHaveBeenCalled();
  });

  it("joins each company once even when two organizations map to it", async () => {
    const d = deps();
    const result = await reconcileOidcMemberships(d, {
      userId: "user-a",
      organizations: ["acme", "acme-cn", "beta"],
      orgCompanyMap: { acme: COMPANY_ID, "acme-cn": COMPANY_ID, beta: OTHER_COMPANY_ID },
    });

    expect(result.joinedCompanyIds).toEqual([COMPANY_ID, OTHER_COMPANY_ID]);
    expect(d.ensureMembership).toHaveBeenCalledTimes(2);
  });
});

describe("extractAgentRoles", () => {
  it("keeps only the known agent-creator role", () => {
    expect(extractAgentRoles({ paperclip_roles: ["agent-creator", "agent-configurer", "other"] })).toEqual([
      "agent-creator",
    ]);
  });

  it("treats a missing or malformed claim as no roles", () => {
    expect(extractAgentRoles({})).toEqual([]);
    expect(extractAgentRoles({ paperclip_roles: "agent-creator" })).toEqual([]);
    expect(extractAgentRoles({ paperclip_roles: [1, null] })).toEqual([]);
    expect(extractAgentRoles(null)).toEqual([]);
  });
});

describe("syncOidcAgentPermissions", () => {
  function deps(options: { role?: string; status?: string; keys?: string[] } = {}) {
    const membership = options.role === undefined
      ? { membershipRole: "operator", status: options.status ?? "active" }
      : options.role === "none"
        ? null
        : { membershipRole: options.role, status: options.status ?? "active" };
    return {
      getMembership: vi.fn(async () => membership),
      listPrincipalGrants: vi.fn(async () =>
        (options.keys ?? ["agents:create", "agents:configure", "tasks:assign"]).map((permissionKey) => ({ permissionKey })),
      ),
      setPrincipalPermission: vi.fn(async () => undefined),
      insertMissingGrants: vi.fn(async () => 1),
      logActivity: vi.fn(async () => ({})),
    };
  }

  it("keeps agents:create for an operator with the role and revokes agents:configure", async () => {
    const d = deps();
    await syncOidcAgentPermissions(d, { userId: "user-a", roles: ["agent-creator"], companyIds: [COMPANY_ID] });

    expect(d.insertMissingGrants).not.toHaveBeenCalled();
    expect(d.setPrincipalPermission).toHaveBeenCalledTimes(1);
    expect(d.setPrincipalPermission).toHaveBeenCalledWith(COMPANY_ID, "user", "user-a", "agents:configure", false, null);
    expect(d.logActivity).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: "user-a",
      action: "company_membership.sso_permissions_synced",
      entityType: "user",
      entityId: "user-a",
      details: { providerId: "keycloak", granted: [], revoked: ["agents:configure"] },
    });
  });

  it("revokes agents:create from an operator without the role", async () => {
    const d = deps();
    await syncOidcAgentPermissions(d, { userId: "user-b", roles: [], companyIds: [COMPANY_ID] });

    expect(d.setPrincipalPermission).toHaveBeenCalledWith(COMPANY_ID, "user", "user-b", "agents:create", false, null);
    expect(d.setPrincipalPermission).toHaveBeenCalledWith(COMPANY_ID, "user", "user-b", "agents:configure", false, null);
    expect(d.setPrincipalPermission).toHaveBeenCalledTimes(2);
    expect(d.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: { providerId: "keycloak", granted: [], revoked: ["agents:create", "agents:configure"] } }),
    );
  });

  it("grants agents:create without touching the membership role", async () => {
    const d = deps({ keys: ["tasks:assign"] });
    await syncOidcAgentPermissions(d, { userId: "user-a", roles: ["agent-creator"], companyIds: [COMPANY_ID] });

    expect(d.insertMissingGrants).toHaveBeenCalledWith(
      COMPANY_ID,
      "user",
      "user-a",
      [{ permissionKey: "agents:create", scope: null }],
      null,
    );
    expect(d.setPrincipalPermission).not.toHaveBeenCalled();
    expect(d.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: { providerId: "keycloak", granted: ["agents:create"], revoked: [] } }),
    );
  });

  it("writes nothing when the permissions already match", async () => {
    const d = deps({ keys: ["agents:create", "tasks:assign"] });
    await syncOidcAgentPermissions(d, { userId: "user-a", roles: ["agent-creator"], companyIds: [COMPANY_ID] });

    expect(d.insertMissingGrants).not.toHaveBeenCalled();
    expect(d.setPrincipalPermission).not.toHaveBeenCalled();
    expect(d.logActivity).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "viewer", "none"])("leaves %s memberships untouched", async (role) => {
    const d = deps({ role });
    await syncOidcAgentPermissions(d, { userId: "user-a", roles: [], companyIds: [COMPANY_ID] });

    expect(d.listPrincipalGrants).not.toHaveBeenCalled();
    expect(d.setPrincipalPermission).not.toHaveBeenCalled();
    expect(d.insertMissingGrants).not.toHaveBeenCalled();
  });

  it("leaves suspended operator memberships untouched", async () => {
    const d = deps({ status: "suspended" });
    await syncOidcAgentPermissions(d, { userId: "user-a", roles: [], companyIds: [COMPANY_ID] });
    expect(d.setPrincipalPermission).not.toHaveBeenCalled();
  });

  it("syncs each company once", async () => {
    const d = deps();
    await syncOidcAgentPermissions(d, {
      userId: "user-a",
      roles: ["agent-creator"],
      companyIds: [COMPANY_ID, OTHER_COMPANY_ID, COMPANY_ID],
    });
    expect(d.listPrincipalGrants).toHaveBeenCalledTimes(2);
  });
});

describe("oidcSkipsHumanGrant", () => {
  const ssoUsers = new Set(["sso-user"]);

  it("skips only the two synced permissions of SSO operators", () => {
    const operator = { companyId: COMPANY_ID, principalId: "sso-user", membershipRole: "operator" };
    expect(oidcSkipsHumanGrant(ssoUsers, operator, "agents:create")).toBe(true);
    expect(oidcSkipsHumanGrant(ssoUsers, operator, "agents:configure")).toBe(true);
    expect(oidcSkipsHumanGrant(ssoUsers, operator, "tasks:assign")).toBe(false);
  });

  it("keeps default grants for admins and for users without a Keycloak account", () => {
    expect(
      oidcSkipsHumanGrant(ssoUsers, { companyId: COMPANY_ID, principalId: "sso-user", membershipRole: "admin" }, "agents:create"),
    ).toBe(false);
    expect(
      oidcSkipsHumanGrant(ssoUsers, { companyId: COMPANY_ID, principalId: "local-user", membershipRole: "operator" }, "agents:create"),
    ).toBe(false);
  });
});
