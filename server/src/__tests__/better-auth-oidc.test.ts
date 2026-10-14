import { describe, expect, it, vi } from "vitest";
import { applyOidcAuthOptions, buildOidcAuthOptions, type OidcConfig } from "../auth/oidc.js";

const COMPANY_ID = "5facf42d-f31f-4698-9bc9-e38f876b1579";

const OIDC: OidcConfig = {
  issuer: "https://sso.example.cn/realms/digital-workforce/",
  clientId: "paperclip",
  clientSecret: "client-secret",
  orgCompanyMap: { acme: COMPANY_ID },
  label: "Sign in with SSO",
};

function deps() {
  return {
    getMembership: vi.fn(async () => null),
    ensureMembership: vi.fn(async () => ({})),
    setPrincipalGrants: vi.fn(async () => undefined),
    listPrincipalGrants: vi.fn(async () => []),
    setPrincipalPermission: vi.fn(async () => undefined),
    insertMissingGrants: vi.fn(async () => 0),
    logActivity: vi.fn(async () => ({})),
  };
}

function operatorDeps(keys: string[]) {
  const d = deps();
  d.getMembership.mockImplementation(async () => ({ membershipRole: "operator", status: "active" }) as never);
  d.listPrincipalGrants.mockImplementation(async () => keys.map((permissionKey) => ({ permissionKey })) as never);
  return d;
}

type ProviderConfig = Record<string, unknown> & {
  mapProfileToUser?: (profile: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

function keycloakProvider(result: ReturnType<typeof buildOidcAuthOptions>): ProviderConfig {
  const plugin = result.plugins[0] as unknown as { id: string; options: { config: ProviderConfig[] } };
  expect(plugin.id).toBe("generic-oauth");
  return plugin.options.config[0]!;
}

function oauthSource(action: string, organization: unknown = ["acme"], roles?: unknown) {
  const profile: Record<string, unknown> = { organization };
  if (roles !== undefined) profile.paperclip_roles = roles;
  return { action, method: "oauth", oauth: { providerId: "keycloak", profile } };
}

describe("buildOidcAuthOptions", () => {
  it("adds nothing when OIDC is not configured", () => {
    expect(buildOidcAuthOptions({ authOidc: null, authSessionTtlSeconds: undefined }, deps())).toEqual({
      plugins: [],
      options: {},
    });
  });

  it("treats a missing authOidc field as not configured", () => {
    expect(buildOidcAuthOptions({} as never, deps())).toEqual({ plugins: [], options: {} });
  });

  it("registers the Keycloak provider with the organization scope and per-login profile sync", () => {
    const provider = keycloakProvider(buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, deps()));

    expect(provider.providerId).toBe("keycloak");
    expect(provider.clientId).toBe("paperclip");
    expect(provider.clientSecret).toBe("client-secret");
    expect(provider.discoveryUrl).toBe(
      "https://sso.example.cn/realms/digital-workforce/.well-known/openid-configuration",
    );
    expect(provider.scopes).toEqual(["openid", "profile", "email", "organization"]);
    expect(provider.overrideUserInfo).toBe(true);
  });

  it("maps name with a preferred_username fallback and keeps email verification", async () => {
    const provider = keycloakProvider(buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, deps()));

    await expect(
      provider.mapProfileToUser!({ name: "Ada Li", email: "ada@example.cn", email_verified: true }),
    ).resolves.toMatchObject({ name: "Ada Li", email: "ada@example.cn", emailVerified: true });
    await expect(
      provider.mapProfileToUser!({ preferred_username: "ada", email: "ada@example.cn" }),
    ).resolves.toMatchObject({ name: "ada", emailVerified: false });
  });

  it("installs the organization gate as validateUserInfo", async () => {
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, deps());
    const validate = options.user!.validateUserInfo!;

    await expect(
      validate({ user: { email: "c@example.cn" }, source: oauthSource("sign-in", ["other"]) } as never, {} as never),
    ).resolves.toEqual({ error: "org_not_allowed" });
  });

  it("joins mapped companies during sign-in for an existing user", async () => {
    const d = deps();
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, d);

    await options.user!.validateUserInfo!(
      { user: { id: "user-a", email: "a@example.cn" }, source: oauthSource("sign-in") } as never,
      {} as never,
    );

    expect(d.ensureMembership).toHaveBeenCalledWith(COMPANY_ID, "user", "user-a", "operator", "active");
  });

  it("joins mapped companies right after a new user is created", async () => {
    const d = deps();
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, d);

    await options.user!.validateUserInfo!(
      { user: { email: "New@Example.cn" }, source: oauthSource("create-user") } as never,
      {} as never,
    );
    expect(d.ensureMembership).not.toHaveBeenCalled();

    await options.databaseHooks!.user!.create!.after!({ id: "user-new", email: "new@example.cn" } as never, null);
    expect(d.ensureMembership).toHaveBeenCalledWith(COMPANY_ID, "user", "user-new", "operator", "active");

    // The pending organizations are consumed once.
    d.ensureMembership.mockClear();
    await options.databaseHooks!.user!.create!.after!({ id: "user-new", email: "new@example.cn" } as never, null);
    expect(d.ensureMembership).not.toHaveBeenCalled();
  });

  it("syncs agent permissions from the token roles for an existing user", async () => {
    const d = operatorDeps(["agents:create", "agents:configure"]);
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, d);

    await options.user!.validateUserInfo!(
      { user: { id: "user-b", email: "b@example.cn" }, source: oauthSource("sign-in", ["acme"]) } as never,
      {} as never,
    );

    expect(d.setPrincipalPermission).toHaveBeenCalledWith(COMPANY_ID, "user", "user-b", "agents:create", false, null);
    expect(d.setPrincipalPermission).toHaveBeenCalledWith(COMPANY_ID, "user", "user-b", "agents:configure", false, null);
  });

  it("syncs agent permissions for a new user after the company join", async () => {
    const d = deps();
    let joined = false;
    d.ensureMembership.mockImplementation(async () => {
      joined = true;
      return {};
    });
    d.getMembership.mockImplementation(async () =>
      (joined ? { membershipRole: "operator", status: "active" } : null) as never,
    );
    d.listPrincipalGrants.mockImplementation(async () =>
      [{ permissionKey: "agents:create" }, { permissionKey: "agents:configure" }] as never,
    );
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, d);

    await options.user!.validateUserInfo!(
      { user: { email: "new@example.cn" }, source: oauthSource("create-user", ["acme"], ["agent-creator"]) } as never,
      {} as never,
    );
    await options.databaseHooks!.user!.create!.after!({ id: "user-new", email: "new@example.cn" } as never, null);

    expect(d.setPrincipalPermission).toHaveBeenCalledTimes(1);
    expect(d.setPrincipalPermission).toHaveBeenCalledWith(COMPANY_ID, "user", "user-new", "agents:configure", false, null);
  });

  it("does not join anything for a rejected login", async () => {
    const d = deps();
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, d);

    await options.user!.validateUserInfo!(
      { user: { id: "user-c", email: "c@example.cn" }, source: oauthSource("sign-in", ["other"]) } as never,
      {} as never,
    );
    await options.databaseHooks!.user!.create!.after!({ id: "user-c", email: "c@example.cn" } as never, null);

    expect(d.ensureMembership).not.toHaveBeenCalled();
  });

  it("ignores users created without Keycloak (break-glass admin sign-up)", async () => {
    const d = deps();
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, d);

    await options.databaseHooks!.user!.create!.after!({ id: "admin", email: "admin@example.cn" } as never, null);

    expect(d.ensureMembership).not.toHaveBeenCalled();
  });
});

describe("applyOidcAuthOptions", () => {
  function accessDeps() {
    return {
      access: {
        getMembership: vi.fn(async () => null),
        ensureMembership: vi.fn(async () => ({})),
        setPrincipalGrants: vi.fn(async () => undefined),
        listPrincipalGrants: vi.fn(async () => []),
        setPrincipalPermission: vi.fn(async () => undefined),
      },
      insertMissingGrants: vi.fn(async () => 0),
      logActivity: vi.fn(async () => ({})),
    };
  }

  it("leaves the upstream auth config untouched when OIDC is not configured", () => {
    const existingPlugin = { id: "workspace-login-handoff" };
    const authConfig: Record<string, unknown> = { secret: "s", plugins: [existingPlugin] };
    applyOidcAuthOptions(authConfig, { authOidc: null, authSessionTtlSeconds: undefined }, accessDeps());
    expect(authConfig).toEqual({ secret: "s", plugins: [existingPlugin] });

    const withoutPlugins: Record<string, unknown> = { secret: "s" };
    applyOidcAuthOptions(withoutPlugins, { authOidc: null, authSessionTtlSeconds: undefined }, accessDeps());
    expect(withoutPlugins).toEqual({ secret: "s" });
  });

  it("appends the Keycloak plugin after existing plugins and installs the hooks", () => {
    const existingPlugin = { id: "workspace-login-handoff" };
    const authConfig: Record<string, unknown> = { secret: "s", plugins: [existingPlugin] };
    applyOidcAuthOptions(authConfig, { authOidc: OIDC, authSessionTtlSeconds: undefined }, accessDeps());

    const plugins = authConfig.plugins as Array<{ id: string }>;
    expect(plugins.map((plugin) => plugin.id)).toEqual(["workspace-login-handoff", "generic-oauth"]);
    expect(typeof (authConfig.user as { validateUserInfo?: unknown }).validateUserInfo).toBe("function");
    expect(
      typeof (authConfig.databaseHooks as { user?: { create?: { after?: unknown } } }).user?.create?.after,
    ).toBe("function");
  });

  it("joins companies through the access service and activity log", async () => {
    const d = accessDeps();
    const authConfig: Record<string, unknown> = {};
    applyOidcAuthOptions(authConfig, { authOidc: OIDC, authSessionTtlSeconds: undefined }, d);

    const validate = (authConfig.user as { validateUserInfo: (data: unknown, ctx: unknown) => Promise<unknown> })
      .validateUserInfo;
    await validate({ user: { id: "user-a", email: "a@example.cn" }, source: oauthSource("sign-in") }, {});

    expect(d.access.getMembership).toHaveBeenCalledWith(COMPANY_ID, "user", "user-a");
    expect(d.access.ensureMembership).toHaveBeenCalledWith(COMPANY_ID, "user", "user-a", "operator", "active");
    expect(d.access.setPrincipalGrants).toHaveBeenCalledTimes(1);
    expect(d.logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "company_membership.sso_joined" }));
  });
});

describe("session lifetime and account linking", () => {
  it("sets the session lifetime from PAPERCLIP_AUTH_SESSION_TTL_SECONDS even without OIDC", () => {
    const { plugins, options } = buildOidcAuthOptions({ authOidc: null, authSessionTtlSeconds: 86400 }, deps());
    expect(plugins).toEqual([]);
    expect(options).toEqual({ session: { expiresIn: 86400 } });
  });

  it("keeps better-auth's default session lifetime when no TTL is configured", () => {
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, deps());
    expect(options).not.toHaveProperty("session");
  });

  it("links a Keycloak account to an existing local account only through a verified Keycloak email", () => {
    const { options } = buildOidcAuthOptions({ authOidc: OIDC, authSessionTtlSeconds: undefined }, deps());
    expect(options.account).toEqual({
      accountLinking: { enabled: true, requireLocalEmailVerified: false },
    });
    // Keycloak must not be a trusted provider: trusted providers skip the email_verified check.
    expect(options.account?.accountLinking?.trustedProviders).toBeUndefined();
  });

  it("applies the session lifetime to the upstream auth config without adding plugins", () => {
    const authConfig: Record<string, unknown> = { secret: "s" };
    applyOidcAuthOptions(authConfig, { authOidc: null, authSessionTtlSeconds: 86400 }, {
      access: {
        getMembership: vi.fn(async () => null),
        ensureMembership: vi.fn(async () => ({})),
        setPrincipalGrants: vi.fn(async () => undefined),
        listPrincipalGrants: vi.fn(async () => []),
        setPrincipalPermission: vi.fn(async () => undefined),
      },
      insertMissingGrants: vi.fn(async () => 0),
      logActivity: vi.fn(async () => ({})),
    });
    expect(authConfig).toEqual({ secret: "s", session: { expiresIn: 86400 } });
  });
});
