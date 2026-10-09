/**
 * OIDC single sign-on (Keycloak) for authenticated deployments.
 *
 * Kept in its own module so the upstream better-auth wiring only needs a
 * small, well-defined hook-in point. See specs/001-keycloak-sso-aliyun.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Keycloak organization alias -> Paperclip company id. Keys are the login allowlist. */
  orgCompanyMap: Record<string, string>;
  label: string;
}

export interface ParsedOidcSettings {
  authOidc: OidcConfig | null;
  authSessionTtlSeconds: number | undefined;
}

const DEFAULT_OIDC_LABEL = "Sign in with SSO";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_OIDC_KEYS = [
  "PAPERCLIP_AUTH_OIDC_ISSUER",
  "PAPERCLIP_AUTH_OIDC_CLIENT_ID",
  "PAPERCLIP_AUTH_OIDC_CLIENT_SECRET",
] as const;

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOrgCompanyMap(raw: string | undefined): Record<string, string> {
  const value = nonEmpty(raw);
  if (!value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP must be a JSON object of organization alias to company id");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP must be a JSON object of organization alias to company id");
  }

  const map: Record<string, string> = {};
  for (const [alias, companyId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof companyId !== "string" || !UUID_PATTERN.test(companyId)) {
      throw new Error(
        `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP entry "${alias}" must map to a company id (UUID)`,
      );
    }
    map[alias] = companyId;
  }
  return map;
}

function parseSessionTtl(raw: string | undefined): number | undefined {
  const value = nonEmpty(raw);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("PAPERCLIP_AUTH_SESSION_TTL_SECONDS must be a positive integer number of seconds");
  }
  return parsed;
}

/**
 * Reads OIDC settings from the environment. OIDC is enabled only when the
 * issuer, client id and client secret are all present; a partial setup is a
 * startup error rather than a silent fallback. Error messages never include
 * the client secret.
 */
export function parseOidcConfig(env: Env): ParsedOidcSettings {
  const authSessionTtlSeconds = parseSessionTtl(env.PAPERCLIP_AUTH_SESSION_TTL_SECONDS);

  const present = REQUIRED_OIDC_KEYS.filter((key) => nonEmpty(env[key]) !== undefined);
  if (present.length === 0) {
    return { authOidc: null, authSessionTtlSeconds };
  }
  const missing = REQUIRED_OIDC_KEYS.filter((key) => nonEmpty(env[key]) === undefined);
  if (missing.length > 0) {
    throw new Error(`OIDC sign-in is partially configured; missing ${missing.join(", ")}`);
  }

  return {
    authOidc: {
      issuer: nonEmpty(env.PAPERCLIP_AUTH_OIDC_ISSUER)!,
      clientId: nonEmpty(env.PAPERCLIP_AUTH_OIDC_CLIENT_ID)!,
      clientSecret: nonEmpty(env.PAPERCLIP_AUTH_OIDC_CLIENT_SECRET)!,
      orgCompanyMap: parseOrgCompanyMap(env.PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP),
      label: nonEmpty(env.PAPERCLIP_AUTH_OIDC_LABEL) ?? DEFAULT_OIDC_LABEL,
    },
    authSessionTtlSeconds,
  };
}
