import { describe, expect, it, vi } from "vitest";
import { buildOidcAuthOptions, type OidcConfig } from "../auth/oidc.js";

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
    logActivity: vi.fn(async () => ({})),
  };
}

type ProviderConfig = Record<string, unknown> & {
  mapProfileToUser?: (profile: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

function keycloakProvider(result: ReturnType<typeof buildOidcAuthOptions>): ProviderConfig {
  const plugin = result.plugins[0] as unknown as { id: string; options: { config: ProviderConfig[] } };
  expect(plugin.id).toBe("generic-oauth");
  return plugin.options.config[0]!;
}

function oauthSource(action: string, organization: unknown = ["acme"]) {
  return { action, method: "oauth", oauth: { providerId: "keycloak", profile: { organization } } };
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
