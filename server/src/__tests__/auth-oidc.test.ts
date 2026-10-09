import { describe, expect, it } from "vitest";
import { parseOidcConfig } from "../auth/oidc.js";

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
