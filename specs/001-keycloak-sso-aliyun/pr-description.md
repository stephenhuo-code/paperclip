<!-- Draft PR description for feat/keycloak-sso (T058). Follows .github/PULL_REQUEST_TEMPLATE.md. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - Authenticated deployments sign people in with email and password through better-auth
> - An organization that already uses Keycloak cannot give its members single sign-on, and each member must get an invite before they can see the company's agents
> - Self-hosted teams also need a repeatable way to run Paperclip with their identity provider in their own cloud
> - This pull request adds optional Keycloak OIDC sign-in with organization-based admission and company membership, and a single-server Alibaba Cloud deployment with automated releases
> - The benefit is that organization members sign in with their company account and use shared digital employees at once, while roles, private tasks and company boundaries stay under Paperclip's control

## Linked Issues or Issue Description

**Subsystem affected**
Authentication (better-auth configuration, sign-in page, health endpoint) and deployment assets.

**Problem or motivation**
An organization uses Keycloak as its identity provider. Its members must sign in to Paperclip with the same account. Membership in a Keycloak organization must decide who can sign in. Removing a member from the organization must remove access. Today Paperclip supports only email and password and invite-based joins.

**Proposed solution**
Add an optional Keycloak provider through the better-auth `genericOAuth` plugin. Check the `organization` claim on every SSO sign-in. Add each admitted user to the mapped company as an `operator`, like a default human invite. Never change an existing membership. Keep email and password sign-in for a break-glass administrator. Add a Docker Compose deployment for one Alibaba Cloud ECS instance with Caddy, Keycloak, PostgreSQL, backups and a GitHub Actions release workflow.

**Alternatives considered**
A reverse proxy in front of Paperclip (two sign-ins, no real SSO). The Cloud trusted-header path (made for Paperclip Cloud only). keycloak-config-cli for Keycloak setup (version 6.5.1 cannot import organizations, so a `kcadm.sh` script replaces it).

**Additional context**
The change adds lines to seven upstream files and removes no lines. All other code is in new files. The feature is off unless the three required `PAPERCLIP_AUTH_OIDC_*` variables are set.

## What Changed

- Add `server/src/auth/oidc.ts`: parse `PAPERCLIP_AUTH_OIDC_*` and `PAPERCLIP_AUTH_SESSION_TTL_SECONDS`, register the Keycloak provider, check organizations in `validateUserInfo`, join mapped companies with default operator grants and a `company_membership.sso_joined` activity entry, set the session lifetime and verified-email account linking.
- Call `applyOidcAuthOptions` once from `createBetterAuthInstance` (`server/src/auth/better-auth.ts`, 7 added lines).
- Read the new settings in `server/src/config.ts` (6 added lines).
- Add public `auth.oidc` (`enabled`, `providerId`, `label`) to `/api/health` when SSO is on (`server/src/routes/health.ts`, 4 added lines). Responses without SSO do not change.
- Add the enterprise sign-in button, error messages and a folded break-glass password form to `ui/src/pages/Auth.tsx`, with `signInSocial` in `ui/src/api/auth.ts` and the health type in `ui/src/api/health.ts`.
- Add `deploy/aliyun/`: Docker Compose stack, Caddyfile, idempotent Keycloak provisioning (`keycloak/provision.sh`), `bootstrap.sh`, `bootstrap-invite.sh`, `deploy.sh` (health gate on the commit, automatic rollback), `backup.sh`, `restore.sh`, `remote-deploy.sh`, `ci-run-command.sh`, and an operations runbook.
- Add `.github/workflows/deploy-aliyun.yml`: build the image and deploy assets, mirror base images to ACR, deploy through Cloud Assistant.
- Add an OIDC section to `doc/DEPLOYMENT-MODES.md`.
- Add the spec, plan, research, contracts, tasks and verification records in `specs/001-keycloak-sso-aliyun/`.

## Verification

- Unit tests (written first, then made to pass):
  - `pnpm test -- server/src/__tests__/auth-oidc.test.ts server/src/__tests__/better-auth-oidc.test.ts server/src/__tests__/health-oidc.test.ts ui/src/pages/Auth.oidc.test.tsx`
  - The existing better-auth, managed-loopback, credential sign-up, health and auth page tests pass without changes.
- Deploy asset checks: `deploy/aliyun/tests/run.sh` (shellcheck, actionlint and 40 node:test cases for the scripts and the rendered Compose config).
- Real Keycloak 26.8.0:
  - `deploy/aliyun/tests/keycloak-provision-test.sh`: 17/17 (idempotent provisioning, owned fields restored, users and memberships kept).
  - `deploy/aliyun/tests/sso-e2e/run-all.sh`: 38/38 browser-style OIDC checks (fail closed without a map, admission, company join and grants, private task isolation, role preservation, profile sync, sign-out, removal from the organization, 24-hour session, verified-email linking, unverified-email refusal, disabled email sign-up, break-glass sign-in).
- Full local stack: `deploy/aliyun/tests/stack-smoke/stack-smoke.sh <tag>` runs the real Compose file, `deploy.sh`, Keycloak provisioning and Caddy with internal TLS. Result: 45/45 (first admin through the bootstrap invite, the SSO end-to-end checks over https, a redeploy, and a failed rollout that rolls back).
- Repository checks: `pnpm -r typecheck` passes. `pnpm build` passes. `pnpm check:token-gates` passes.
- `pnpm test:run`: 17,394 passed and 8 failed. One failure came from this branch (a `pnpm paperclipai` command in a spec document) and is fixed. The other 7 failures are in `git-credentials.test.ts` and `workspace-runtime.test.ts`. The same 7 tests fail on the upstream base commit without this branch, so they depend on the local machine.
- Not run: production acceptance on Alibaba Cloud and the DeepSeek, MiniMax and Kimi agent checks. They need cloud resources and API keys (tasks T021, T050, T051).
- Details: `specs/001-keycloak-sso-aliyun/verification.md`.

## Risks

- Authentication change. The feature is off by default. With SSO on, a wrong organization map rejects every SSO sign-in (fail closed). The break-glass password sign-in stays available.
- Account linking: a Keycloak account links to an existing local account with the same email when Keycloak reports a verified email. Keep Keycloak self-registration off. The provisioning script sets this.
- The single-server deployment has no high availability. Daily OSS backups and disk snapshots protect the data.
- Agents run as child processes in the Paperclip container without file isolation. The bubblewrap sandbox works only with weaker container hardening, so it is not enabled.
- No database migrations.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- Provider: Anthropic. Model: Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code, with tool use (shell, file editing, Docker) and subagents for research.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [ ] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [ ] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [ ] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge

🤖 Generated with [Claude Code](https://claude.com/claude-code)
