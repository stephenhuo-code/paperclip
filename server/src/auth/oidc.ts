/**
 * OIDC single sign-on (Keycloak) for authenticated deployments.
 *
 * Kept in its own module so the upstream better-auth wiring only needs a
 * small, well-defined hook-in point. See specs/001-keycloak-sso-aliyun.
 */

import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { genericOAuth, keycloak } from "better-auth/plugins/generic-oauth";
import { grantsForHumanRole } from "../services/company-member-roles.js";

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

export const OIDC_PROVIDER_ID = "keycloak";

/**
 * Organization aliases from a Keycloak `organization` claim. Keycloak emits
 * either a list of aliases or, with id/attributes enabled on the mapper, a
 * map keyed by alias; both are accepted.
 */
export function extractOrganizations(profile: unknown): string[] {
  if (!profile || typeof profile !== "object") return [];
  const claim = (profile as Record<string, unknown>).organization;
  if (Array.isArray(claim)) {
    return claim.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  if (claim && typeof claim === "object") return Object.keys(claim);
  return [];
}

export interface OidcUserInfoValidationInput {
  user: { email?: string | null };
  source: {
    action?: string;
    method?: string;
    oauth?: { providerId?: string; profile?: unknown };
  };
}

/**
 * Admission gate for better-auth's `user.validateUserInfo`. Only Keycloak
 * sign-ins are checked; email/password (break-glass admin) and any other
 * provider pass through untouched.
 */
export function validateOidcUserInfo(
  config: OidcConfig,
  input: OidcUserInfoValidationInput,
): { error: "org_not_allowed" | "email_required" } | undefined {
  if (input.source.method !== "oauth" || input.source.oauth?.providerId !== OIDC_PROVIDER_ID) {
    return undefined;
  }
  if (!input.user.email) return { error: "email_required" };
  const allowed = extractOrganizations(input.source.oauth.profile).some((alias) =>
    Object.hasOwn(config.orgCompanyMap, alias),
  );
  return allowed ? undefined : { error: "org_not_allowed" };
}

export interface OidcMembershipDeps {
  getMembership(companyId: string, principalType: "user", principalId: string): Promise<unknown>;
  ensureMembership(
    companyId: string,
    principalType: "user",
    principalId: string,
    membershipRole: "operator",
    status: "active",
  ): Promise<unknown>;
  setPrincipalGrants(
    companyId: string,
    principalType: "user",
    principalId: string,
    grants: ReturnType<typeof grantsForHumanRole>,
    grantedByUserId: null,
  ): Promise<unknown>;
  logActivity(input: {
    companyId: string;
    actorType: "user";
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * Adds the user to each company mapped from their Keycloak organizations,
 * exactly as accepting a default human invite would (operator role plus its
 * default grants). Existing memberships are never touched, so roles set in
 * Paperclip survive every login.
 */
export async function reconcileOidcMemberships(
  deps: OidcMembershipDeps,
  input: { userId: string; organizations: string[]; orgCompanyMap: Record<string, string> },
): Promise<{ joinedCompanyIds: string[] }> {
  const joinedCompanyIds: string[] = [];
  const seen = new Set<string>();
  for (const organization of input.organizations) {
    if (!Object.hasOwn(input.orgCompanyMap, organization)) continue;
    const companyId = input.orgCompanyMap[organization]!;
    if (seen.has(companyId)) continue;
    seen.add(companyId);

    if (await deps.getMembership(companyId, "user", input.userId)) continue;

    await deps.ensureMembership(companyId, "user", input.userId, "operator", "active");
    await deps.setPrincipalGrants(companyId, "user", input.userId, grantsForHumanRole("operator"), null);
    await deps.logActivity({
      companyId,
      actorType: "user",
      actorId: input.userId,
      action: "company_membership.sso_joined",
      entityType: "user",
      entityId: input.userId,
      details: { providerId: OIDC_PROVIDER_ID, organization },
    });
    joinedCompanyIds.push(companyId);
  }
  return { joinedCompanyIds };
}

export interface OidcAuthOptions {
  plugins: BetterAuthPlugin[];
  options: Pick<BetterAuthOptions, "user" | "databaseHooks">;
}

function profileString(profile: Record<string, unknown>, key: string): string | undefined {
  const value = profile[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Better Auth plugins and options for Keycloak sign-in. Returns empty
 * fragments when OIDC is not configured so the upstream auth setup is
 * unchanged.
 *
 * Membership joins run in `validateUserInfo` for returning users (sign-in,
 * link-account). A brand-new user has no id yet at that point, so its
 * organizations are held by email until `user.create.after` fires.
 */
export function buildOidcAuthOptions(
  config: { authOidc?: OidcConfig | null },
  deps: OidcMembershipDeps,
): OidcAuthOptions {
  const oidc = config.authOidc;
  if (!oidc) return { plugins: [], options: {} };

  const pendingOrganizationsByEmail = new Map<string, string[]>();

  const join = (userId: string, organizations: string[]) =>
    reconcileOidcMemberships(deps, { userId, organizations, orgCompanyMap: oidc.orgCompanyMap });

  const provider = {
    ...keycloak({
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      scopes: ["openid", "profile", "email", "organization"],
      overrideUserInfo: true,
    }),
    mapProfileToUser: async (profile: Record<string, unknown>) => ({
      name: profileString(profile, "name") ?? profileString(profile, "preferred_username"),
      email: profileString(profile, "email"),
      emailVerified: profile.email_verified === true,
    }),
  };

  return {
    plugins: [genericOAuth({ config: [provider] })],
    options: {
      user: {
        validateUserInfo: async ({ user, source }) => {
          const input = { user, source } as OidcUserInfoValidationInput;
          const rejection = validateOidcUserInfo(oidc, input);
          if (rejection) return rejection;
          if (source.method !== "oauth" || source.oauth?.providerId !== OIDC_PROVIDER_ID) return;

          const organizations = extractOrganizations(source.oauth.profile);
          const userId = typeof user.id === "string" ? user.id : undefined;
          if (userId) {
            await join(userId, organizations);
          } else if (typeof user.email === "string") {
            pendingOrganizationsByEmail.set(user.email.toLowerCase(), organizations);
          }
        },
      },
      databaseHooks: {
        user: {
          create: {
            after: async (user) => {
              const email = user.email?.toLowerCase();
              const organizations = email ? pendingOrganizationsByEmail.get(email) : undefined;
              if (!email || !organizations) return;
              pendingOrganizationsByEmail.delete(email);
              await join(user.id, organizations);
            },
          },
        },
      },
    },
  };
}

interface OidcAccessDeps {
  access: Pick<OidcMembershipDeps, "getMembership" | "ensureMembership" | "setPrincipalGrants">;
  logActivity: OidcMembershipDeps["logActivity"];
}

/**
 * Hook-in point for `createBetterAuthInstance`: adds the Keycloak plugin after
 * any existing plugins and installs the admission and membership hooks. A
 * no-op when OIDC is not configured.
 */
export function applyOidcAuthOptions(
  authConfig: Record<string, unknown>,
  config: { authOidc?: OidcConfig | null },
  deps: OidcAccessDeps,
): void {
  const { plugins, options } = buildOidcAuthOptions(config, {
    getMembership: (...args) => deps.access.getMembership(...args),
    ensureMembership: (...args) => deps.access.ensureMembership(...args),
    setPrincipalGrants: (...args) => deps.access.setPrincipalGrants(...args),
    logActivity: (input) => deps.logActivity(input),
  });
  if (plugins.length === 0) return;

  const existing = Array.isArray(authConfig.plugins) ? (authConfig.plugins as BetterAuthPlugin[]) : [];
  authConfig.plugins = [...existing, ...plugins];
  authConfig.user = { ...(authConfig.user as object | undefined), ...options.user };
  authConfig.databaseHooks = { ...(authConfig.databaseHooks as object | undefined), ...options.databaseHooks };
}
