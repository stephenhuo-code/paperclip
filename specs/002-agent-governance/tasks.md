# Tasks: 数字员工的管控

**Input**: [spec.md](./spec.md)、[plan.md](./plan.md)、[research.md](./research.md)、[contracts/governance.md](./contracts/governance.md)

**TDD**：每组先写测试并确认失败，再实现。上游文件只加行。

## Phase 1: Setup

- [X] T001 运行基线测试并记录结果：`pnpm test -- server/src/__tests__/auth-oidc.test.ts server/src/__tests__/better-auth-oidc.test.ts server/src/__tests__/approval-routes-idempotency.test.ts server/src/__tests__/access-service.test.ts`

## Phase 2: User Story 1 - 只有管理员能审批新建 agent (P1) 🎯 MVP

**独立验证**：operator 批准/驳回 hire 申请、改审批开关返回 403；admin 成功。

- [X] T002 [P] [US1] 写失败测试 `server/src/__tests__/company-admin.test.ts`：`assertCompanyAdmin(req, access, companyId)` 对 `local_implicit`、`isInstanceAdmin`、成员角色 `owner`/`admin` 放行；`operator`/`viewer`/非成员抛 403（`HttpError`，消息 `Only company owners and admins can ...`）
- [X] T003 [US1] 实现 `server/src/auth/company-admin.ts`：用 `access.getMembership(companyId, "user", req.actor.userId)` 读 `membershipRole`；接受一个动作描述参数生成 403 消息
- [X] T004 [P] [US1] 写失败测试 `server/src/__tests__/agent-hire-approval-admin.test.ts`（参照 `approval-routes-idempotency.test.ts`、`companies-route-cross-company-authz.test.ts` 的 mock 方式）：
  - `POST /api/approvals/:id/approve|reject|request-revision`，`type=hire_agent`：operator 403 且审批服务未被调用；admin 成功
  - 同三个接口，其他审批类型：operator 行为不变
  - `POST /api/agents/:id/approve`：operator 403；admin 成功
  - `POST /api/agents/:id/terminate`：待审批 agent，operator 403 且申请未被驳回；admin 成功；已审批的 agent，operator 行为不变
  - `PATCH /api/companies/:companyId`：operator 改变 `requireBoardApprovalForNewAgents` 403；值不变或只改其他字段成功；admin 改变成功
- [X] T005 [US1] `server/src/routes/approvals.ts` 三处（约 296/412/448 行）：读出审批后，`type === "hire_agent"` 时调用 `assertCompanyAdmin`
- [X] T006 [US1] `server/src/routes/agents.ts`：`POST /agents/:id/approve`（约 5956 行）调用 `assertCompanyAdmin`；`POST /agents/:id/terminate`（约 6010 行）在 `existing.status === "pending_approval"` 时调用 `assertCompanyAdmin`
- [X] T007 [US1] `server/src/routes/companies.ts` `PATCH /:companyId`（约 364 行）：请求体含 `requireBoardApprovalForNewAgents` 且与当前值不同时调用 `assertCompanyAdmin`
- [X] T008 [US1] 运行 T002、T004 的测试，全部通过

## Phase 3: User Story 2 - 新建由 Keycloak 角色决定，修改只归管理员 (P2)

**独立验证**：user-a 有 `agent-creator`、user-b 没有；登录后 a 能建、b 不能，两人都不能改 agent；重启后不恢复。

### 测试（先写，确认失败）

- [X] T009 [P] [US2] `server/src/__tests__/auth-oidc.test.ts` 追加：
  - `extractAgentRoles(profile)`：读 `paperclip_roles`，只保留 `agent-creator`；缺失或非字符串数组返回 `[]`
  - `syncOidcAgentPermissions(deps, { userId, roles, companyIds })`：operator 有角色时缺 `agents:create` 则插入；无角色时有则收回；`agents:configure` 有则收回；owner/admin/viewer 不动；不动其他权限；有变化写一条 `company_membership.sso_permissions_synced`（details `{ providerId, granted, revoked }`），无变化不写；授予不调用 `setPrincipalPermission(..., true)`
- [X] T010 [P] [US2] `server/src/__tests__/better-auth-oidc.test.ts` 追加：老用户登录、新用户首登（经 `databaseHooks.user.create.after`）都按令牌角色同步
- [X] T011 [P] [US2] 新建 `server/src/__tests__/oidc-backfill-skip.test.ts`（参照 `access-service.test.ts` 中 `backfillPrincipalAccessCompatibility` 用例的数据库准备方式）：有 `provider_id='keycloak'` 账户的 operator 被收回的两项权限，执行 `backfillPrincipalAccessCompatibility(db, { skipHumanGrant: await oidcSkipHumanGrant(db) })` 后仍不存在；非 SSO 用户照常补回；不传选项时行为与原来一致

### 实现

- [X] T012 [US2] `server/src/auth/oidc.ts`：新增 `extractAgentRoles`、`syncOidcAgentPermissions`；`OidcMembershipDeps` 增加 `listPrincipalGrants`、`setPrincipalPermission`、`insertMissingGrants`（R2）
- [X] T013 [US2] `server/src/auth/oidc.ts` `buildOidcAuthOptions`：`join` 之后对 `orgCompanyMap` 映射到的公司调用同步（只同步这些公司，其他公司的成员关系不动）；`pendingOrganizationsByEmail` 改为同时暂存角色；`applyOidcAuthOptions` 的依赖接上 `access.listPrincipalGrants`、`access.setPrincipalPermission`、`insertMissingPrincipalGrants`
- [X] T014 [US2] `server/src/auth/oidc.ts` 导出 `oidcSkipHumanGrant(db)`：一次查出 `account.provider_id = OIDC_PROVIDER_ID` 的用户集合，返回 `(membership, permissionKey) => boolean`，对这些用户的 `agents:create`、`agents:configure` 返回 true
- [X] T015 [US2] `server/src/services/principal-access-compatibility.ts`：`backfillPrincipalAccessCompatibility(db, options?: { skipHumanGrant? })`；提供时过滤 `grantsForHumanRole(role)` 后调用 `insertMissingPrincipalGrants`，否则保持原调用
- [X] T016 [US2] `server/src/index.ts:707`：OIDC 开启时传入 `{ skipHumanGrant: await oidcSkipHumanGrant(db) }`
- [X] T017 [US2] 运行 T009–T011 和 T001 的测试，全部通过

### Keycloak 与端到端

- [X] T018 [P] [US2] `deploy/aliyun/tests/keycloak-provision-test.sh` 先加失败断言：`paperclip` 客户端有角色 `agent-creator`、有 `paperclip_roles` 映射（配置见 research R4）；重复执行不变；已分配给用户的角色保留
- [X] T019 [US2] `deploy/aliyun/keycloak/provision.sh`：缺少时创建角色；创建或更新映射；不碰角色分配；运行 T018 通过
- [X] T020 [US2] `deploy/aliyun/tests/sso-e2e/keycloak-setup.sh` 给 user-a 分配 `agent-creator`；`deploy/aliyun/tests/sso-e2e/e2e.mjs` 加检查：a 能建 agent、b 403；a、b 改 agent 配置 403；去掉 a 的角色重新登录后 403；operator 审批 hire、终止待审批 agent 403，应急管理员成功

## Phase 4: Polish

- [X] T021 [P] `deploy/aliyun/README.md`、`doc/DEPLOYMENT-MODES.md` 第 12 节：如何分配 `agent-creator`、何时生效、谁能审批和修改 agent
- [X] T022 运行 `pnpm -r typecheck`、[quickstart](./quickstart.md) 全部命令；stack-smoke 中重启 paperclip 容器后确认 user-b 仍无两项权限；记录结果到 `specs/002-agent-governance/verification.md`

## Phase 5: User Story 3 - 创建人可以修改自己创建的 agent (P3)（2026-10-14 新增）

**独立验证**：A（有 `agent-creator`）能改自己创建的 agent（直接创建的、审批通过的），不能改别人创建的；去掉角色并重新登录后，改自己的也被拒绝。见 [plan](./plan.md) "🆕 US3 要改的文件"、[research](./research.md) R5。

### 数据库字段

- [X] T023 [US3] 写失败测试 `server/src/__tests__/agent-created-by.test.ts`（内嵌 Postgres，参照 `agents-pending-approval-config.test.ts`）：`agentService.create(companyId, data, { createdByUserId: "user-a" })` 后 `agents.created_by_user_id = 'user-a'`；不传时为 null；`agentService.update` 传入 `createdByUserId` 不改变该值
- [X] T024 [US3] `packages/db/src/schema/agents.ts` 新增 `createdByUserId: text("created_by_user_id")`（可为空）；运行 `pnpm db:generate` 生成 `packages/db/src/migrations/0320_*.sql` 和 `meta/`
- [X] T025 [US3] 在 T024 生成的迁移 SQL 末尾追加补值：`created_by_user_id` 为空的 agent，取 `activity_log` 中 `entity_type='agent'`、`entity_id=agents.id::text`、`action in ('agent.created','agent.hire_created')`、`actor_type='user'` 按 `created_at` 最早一条的 `actor_id`；在 T023 测试中加用例：插入活动日志后执行该 SQL，老 agent 被补值、已有值不被覆盖
- [X] T026 [US3] `server/src/services/agents.ts` `create` 的 `insert(agents).values` 中加 `createdByUserId: options?.createdByUserId ?? null`；运行 T023 测试通过

### 放行创建人

- [X] T027 [P] [US3] 写失败测试 `server/src/__tests__/agent-owner.test.ts`：`canEditOwnAgent(req, access, agent)` 在 board 用户、`agent.createdByUserId === req.actor.userId`、`access.decide({ action: "agents:create", resource: { type: "company", companyId } })` 允许时返回 true；非创建人、`createdByUserId` 为 null、没有 `agents:create`、agent 调用者均返回 false
- [X] T028 [US3] 实现 `server/src/auth/agent-owner.ts`；运行 T027 测试通过
- [X] T029 [P] [US3] 写失败测试 `server/src/__tests__/agent-owner-edit-routes.test.ts`（参照 `agent-hire-approval-admin.test.ts` 的 mock 方式，`access.decide` 对 `agent_config:update` 拒绝、对 `agents:create` 允许）：创建人 `PATCH /api/agents/:id` 成功；非创建人 403；创建人修改指令路径（走 `assertCanApplyProtectedAgentChange` 的接口）成功；请求体带 `createdByUserId` 时创建人不变
- [X] T030 [US3] `server/src/routes/agents.ts`：`assertCanUpdateAgent`（约 2170 行）和 `assertCanApplyProtectedAgentChange`（约 2842 行）在抛出 403 前加 `if (await canEditOwnAgent(req, access, targetAgent)) return;`，加 import；只加行。运行 T027、T029 和 US1 的 `agent-hire-approval-admin.test.ts`、`agent-cross-tenant-authz-routes.test.ts` 通过

### 端到端与文档

- [X] T031 [US3] `deploy/aliyun/tests/sso-e2e/e2e.mjs`：原检查"A cannot change the agent configuration"改为 A 修改管理员创建的 agent 返回 403；新增 A 修改自己直接创建的 agent、审批通过的 agent 返回 200；去掉 A 的角色并重新登录后，修改自己的 agent 返回 403；运行 `deploy/aliyun/tests/sso-e2e/run-all.sh` 通过
- [X] T032 [P] [US3] `deploy/aliyun/README.md`、`doc/DEPLOYMENT-MODES.md` 第 12 节补充：创建人可修改自己创建的 agent；升级会给 agent 表新增 `created_by_user_id` 字段
- [X] T033 [US3] 运行 `pnpm -r typecheck` 和本阶段相关测试（不跑全量 `pnpm test:run`）；更新 `specs/002-agent-governance/verification.md`

### 补充（2026-10-14 本地测试发现）

- [X] T034 [US3] 创建人保存 `AGENTS.md` 返回 403：指令文件在服务层由 `authorizeInstructionCommit` 检查，T030 没覆盖。先在 `server/src/__tests__/agent-created-by.test.ts` 加失败用例（创建人能提交指令、别人不能、没有 `agents:create` 不能），再在 `server/src/auth/agent-owner.ts` 加 `canEditOwnAgentById`，在 `server/src/services/agent-instruction-authorization.ts` 拒绝前调用

## 依赖与并行

- US1（T002–T008）与 US2（T009–T020）互不依赖，可并行。
- 组内：测试 → 实现 → 运行。T002/T004、T009/T010/T011、T018 标 [P]，可同时写。
- T022 在全部完成后。
- US3（T023–T033）在 US2 之后：T023→T024→T025→T026；T027/T029 可同时写，T028、T030 依次实现；T031 依赖 T026 和 T030。

## 实施策略

先做 US1 并验证（MVP），再做 US2，最后 T021–T022。US3 单独一轮：先数据库字段，再放行逻辑，最后 e2e 和文档。
