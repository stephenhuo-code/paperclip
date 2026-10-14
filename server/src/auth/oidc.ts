/**
 * OIDC single sign-on (Keycloak) for authenticated deployments.
 *
 * Kept in its own module so the upstream better-auth wiring only needs a
 * small, well-defined hook-in point. See specs/001-keycloak-sso-aliyun.
 */

import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { genericOAuth, keycloak } from "better-auth/plugins/generic-oauth";
import { eq } from "drizzle-orm";
import { authAccounts, type Db } from "@paperclipai/db";
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

/** Keycloak client role on `paperclip` that lets an operator create agents. See specs/002-agent-governance. */
export const AGENT_CREATOR_ROLE = "agent-creator";

/** Operator permissions decided by Keycloak at every SSO sign-in instead of the role defaults. */
const SSO_SYNCED_PERMISSION_KEYS = ["agents:create", "agents:configure"] as const;

/**
 * Known agent roles from the `paperclip_roles` ID-token claim. A missing or
 * malformed claim means no roles, so the sign-in still succeeds.
 */
export function extractAgentRoles(profile: unknown): string[] {
  if (!profile || typeof profile !== "object") return [];
  const claim = (profile as Record<string, unknown>).paperclip_roles;
  if (!Array.isArray(claim)) return [];
  return claim.filter((value): value is string => value === AGENT_CREATOR_ROLE);
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
  getMembership(
    companyId: string,
    principalType: "user",
    principalId: string,
  ): Promise<{ membershipRole?: string | null; status?: string | null } | null>;
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
  listPrincipalGrants(
    companyId: string,
    principalType: "user",
    principalId: string,
  ): Promise<Array<{ permissionKey: string }>>;
  setPrincipalPermission(
    companyId: string,
    principalType: "user",
    principalId: string,
    permissionKey: (typeof SSO_SYNCED_PERMISSION_KEYS)[number],
    enabled: false,
    grantedByUserId: null,
  ): Promise<unknown>;
  insertMissingGrants(
    companyId: string,
    principalType: "user",
    principalId: string,
    grants: Array<{ permissionKey: "agents:create"; scope: null }>,
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

/**
 * Makes an operator's agent permissions follow Keycloak: `agents:create` only
 * with the agent-creator role, `agents:configure` never (only owners and
 * admins change agents). Grants are inserted or deleted one row at a time so
 * the membership role and every other permission stay as they are. Owners,
 * admins, viewers and inactive memberships are left alone.
 */
export async function syncOidcAgentPermissions(
  deps: Pick<
    OidcMembershipDeps,
    "getMembership" | "listPrincipalGrants" | "setPrincipalPermission" | "insertMissingGrants" | "logActivity"
  >,
  input: { userId: string; roles: string[]; companyIds: string[] },
): Promise<void> {
  const canCreate = input.roles.includes(AGENT_CREATOR_ROLE);
  for (const companyId of new Set(input.companyIds)) {
    const membership = await deps.getMembership(companyId, "user", input.userId);
    if (membership?.membershipRole !== "operator" || membership.status !== "active") continue;

    const current = new Set(
      (await deps.listPrincipalGrants(companyId, "user", input.userId)).map((grant) => grant.permissionKey),
    );
    const granted: string[] = [];
    const revoked: string[] = [];
    if (canCreate && !current.has("agents:create")) {
      await deps.insertMissingGrants(companyId, "user", input.userId, [{ permissionKey: "agents:create", scope: null }], null);
      granted.push("agents:create");
    }
    for (const key of SSO_SYNCED_PERMISSION_KEYS) {
      const keep = key === "agents:create" && canCreate;
      if (keep || !current.has(key)) continue;
      await deps.setPrincipalPermission(companyId, "user", input.userId, key, false, null);
      revoked.push(key);
    }
    if (granted.length === 0 && revoked.length === 0) continue;

    await deps.logActivity({
      companyId,
      actorType: "user",
      actorId: input.userId,
      action: "company_membership.sso_permissions_synced",
      entityType: "user",
      entityId: input.userId,
      details: { providerId: OIDC_PROVIDER_ID, granted, revoked },
    });
  }
}

/**
 * Whether the startup backfill must skip a default grant: the two synced
 * permissions of operators who sign in through Keycloak. Without this, every
 * restart would hand back what the last SSO sign-in revoked.
 */
export function oidcSkipsHumanGrant(
  ssoUserIds: ReadonlySet<string>,
  membership: { principalId: string; membershipRole: string | null },
  permissionKey: string,
): boolean {
  return (
    ssoUserIds.has(membership.principalId) &&
    membership.membershipRole === "operator" &&
    (SSO_SYNCED_PERMISSION_KEYS as readonly string[]).includes(permissionKey)
  );
}

/** Loads the Keycloak users once and returns the backfill skip predicate. */
export async function oidcSkipHumanGrant(
  db: Db,
): Promise<(membership: { principalId: string; membershipRole: string | null }, permissionKey: string) => boolean> {
  const rows = await db
    .select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(eq(authAccounts.providerId, OIDC_PROVIDER_ID));
  const ssoUserIds = new Set(rows.map((row) => row.userId));
  return (membership, permissionKey) => oidcSkipsHumanGrant(ssoUserIds, membership, permissionKey);
}

export interface OidcAuthOptions {
  plugins: BetterAuthPlugin[];
  options: Pick<BetterAuthOptions, "user" | "databaseHooks" | "session" | "account">;
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
  config: { authOidc?: OidcConfig | null; authSessionTtlSeconds?: number },
  deps: OidcMembershipDeps,
): OidcAuthOptions {
  const sessionOptions = config.authSessionTtlSeconds
    ? { session: { expiresIn: config.authSessionTtlSeconds } }
    : {};
  const oidc = config.authOidc;
  if (!oidc) return { plugins: [], options: sessionOptions };

  const pendingSignInByEmail = new Map<string, { organizations: string[]; roles: string[] }>();

  const join = async (userId: string, organizations: string[], roles: string[]) => {
    await reconcileOidcMemberships(deps, { userId, organizations, orgCompanyMap: oidc.orgCompanyMap });
    const companyIds = organizations
      .filter((organization) => Object.hasOwn(oidc.orgCompanyMap, organization))
      .map((organization) => oidc.orgCompanyMap[organization]!);
    await syncOidcAgentPermissions(deps, { userId, roles, companyIds });
  };

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
      ...sessionOptions,
      // Link to an existing local account only when Keycloak vouches for the
      // email. Keycloak is deliberately not a trusted provider (that would
      // skip its email_verified check), and local email verification cannot
      // be required because Paperclip's email sign-up never verifies email.
      account: { accountLinking: { enabled: true, requireLocalEmailVerified: false } },
      user: {
        validateUserInfo: async ({ user, source }) => {
          const input = { user, source } as OidcUserInfoValidationInput;
          const rejection = validateOidcUserInfo(oidc, input);
          if (rejection) return rejection;
          if (source.method !== "oauth" || source.oauth?.providerId !== OIDC_PROVIDER_ID) return;

          const organizations = extractOrganizations(source.oauth.profile);
          const roles = extractAgentRoles(source.oauth.profile);
          const userId = typeof user.id === "string" ? user.id : undefined;
          if (userId) {
            await join(userId, organizations, roles);
          } else if (typeof user.email === "string") {
            pendingSignInByEmail.set(user.email.toLowerCase(), { organizations, roles });
          }
        },
      },
      databaseHooks: {
        user: {
          create: {
            after: async (user) => {
              const email = user.email?.toLowerCase();
              const pending = email ? pendingSignInByEmail.get(email) : undefined;
              if (!email || !pending) return;
              pendingSignInByEmail.delete(email);
              await join(user.id, pending.organizations, pending.roles);
            },
          },
        },
      },
    },
  };
}

interface OidcAccessDeps {
  access: Pick<
    OidcMembershipDeps,
    "getMembership" | "ensureMembership" | "setPrincipalGrants" | "listPrincipalGrants" | "setPrincipalPermission"
  >;
  insertMissingGrants: OidcMembershipDeps["insertMissingGrants"];
  logActivity: OidcMembershipDeps["logActivity"];
}

/**
 * Hook-in point for `createBetterAuthInstance`: applies the configured session
 * lifetime, adds the Keycloak plugin after any existing plugins and installs
 * the admission, membership and account-linking options. A no-op when neither
 * OIDC nor a session lifetime is configured.
 */
export function applyOidcAuthOptions(
  authConfig: Record<string, unknown>,
  config: { authOidc?: OidcConfig | null; authSessionTtlSeconds?: number },
  deps: OidcAccessDeps,
): void {
  const { plugins, options } = buildOidcAuthOptions(config, {
    getMembership: (...args) => deps.access.getMembership(...args),
    ensureMembership: (...args) => deps.access.ensureMembership(...args),
    setPrincipalGrants: (...args) => deps.access.setPrincipalGrants(...args),
    listPrincipalGrants: (...args) => deps.access.listPrincipalGrants(...args),
    setPrincipalPermission: (...args) => deps.access.setPrincipalPermission(...args),
    insertMissingGrants: (...args) => deps.insertMissingGrants(...args),
    logActivity: (input) => deps.logActivity(input),
  });
  if (options.session) {
    authConfig.session = { ...(authConfig.session as object | undefined), ...options.session };
  }
  if (plugins.length === 0) return;

  const existing = Array.isArray(authConfig.plugins) ? (authConfig.plugins as BetterAuthPlugin[]) : [];
  authConfig.plugins = [...existing, ...plugins];
  authConfig.user = { ...(authConfig.user as object | undefined), ...options.user };
  authConfig.databaseHooks = { ...(authConfig.databaseHooks as object | undefined), ...options.databaseHooks };
  authConfig.account = { ...(authConfig.account as object | undefined), ...options.account };
}

/**
 * Public sign-in info for `/api/health`: whether enterprise sign-in is on and
 * the button label. Never includes issuer, client or organization settings.
 * Returns null when OIDC is off so health responses stay byte-identical.
 */
export function oidcHealthStatus(
  env: Record<string, string | undefined>,
): { oidc: { enabled: true; providerId: string; label: string } } | null {
  let authOidc: OidcConfig | null;
  try {
    authOidc = parseOidcConfig(env).authOidc;
  } catch {
    return null;
  }
  if (!authOidc) return null;
  return { oidc: { enabled: true, providerId: OIDC_PROVIDER_ID, label: authOidc.label } };
}
