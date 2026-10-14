# Implementation Plan: 数字员工的管控

**Branch**: `feat/keycloak-sso` | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)

## 方案

1. **审批只归管理员**：新函数 `assertCompanyAdmin`，在审批和公司设置的路由里各调用一次。
2. **登录时同步权限**：`oidc.ts` 读 ID 令牌的 `paperclip_roles`，对 operator 按 `agent-creator` 授予或收回 `agents:create`，并收回 `agents:configure`。
3. **重启不恢复**：启动时的默认权限补回跳过 SSO 用户的这两项（[research](./research.md) R1）。
4. **Keycloak**：`provision.sh` 创建角色和令牌映射。
5. **创建人修改自己的 agent**（US3，2026-10-13）：新函数 `canEditOwnAgent`，在上游两个修改配置的检查函数里，原检查不通过时调用（[research](./research.md) R5）。

无数据库变更，复用 `principal_permission_grants`、`company_memberships`、`account` 表。

## 要改的文件（US1、US2，已完成）

**新增**

| 文件 | 内容 |
|---|---|
| `server/src/auth/company-admin.ts` | `assertCompanyAdmin(req, access, companyId)`：`local_implicit`、实例管理员、owner/admin 放行，否则 403 |
| `server/src/__tests__/company-admin.test.ts` | 上面函数的测试 |
| `server/src/__tests__/agent-hire-approval-admin.test.ts` | 路由测试：operator 审批 hire、终止待审批 agent、改开关 403；admin 成功；其他审批类型不受影响 |
| `server/src/__tests__/oidc-backfill-skip.test.ts` | 启动补回跳过 SSO 用户的测试 |

**我们已有的文件**

| 文件 | 改动 |
|---|---|
| `server/src/auth/oidc.ts` | 读角色；`syncOidcAgentPermissions` 只改 operator 的两项权限，有变化写活动日志；在 `reconcileOidcMemberships` 之后，对组织映射到的公司调用；新用户暂存加上角色；导出给启动补回用的跳过判断 |
| `server/src/__tests__/auth-oidc.test.ts`、`better-auth-oidc.test.ts` | 同步逻辑和登录流程的测试 |
| `deploy/aliyun/keycloak/provision.sh` | 创建 `agent-creator` 和 `paperclip_roles` 映射（R4） |
| `deploy/aliyun/tests/keycloak-provision-test.sh` | 角色和映射存在、可重复执行 |
| `deploy/aliyun/tests/sso-e2e/keycloak-setup.sh`、`e2e.mjs` | user-a 有角色、user-b 没有，按 spec 验收场景验证 |
| `deploy/aliyun/README.md`、`doc/DEPLOYMENT-MODES.md` | 如何分配角色、谁能审批 |

**上游文件（只加行）**

| 文件 | 改动 | 行数 |
|---|---|---|
| `server/src/routes/approvals.ts` | approve / reject / request-revision：`hire_agent` 时调用 `assertCompanyAdmin` | +7 |
| `server/src/routes/agents.ts` | `POST /agents/:id/approve`，以及 `POST /agents/:id/terminate` 遇到待审批 agent 时，调用 `assertCompanyAdmin`（R3） | +3 |
| `server/src/routes/companies.ts` | `requireBoardApprovalForNewAgents` 值变化时调用 `assertCompanyAdmin` | +7 |
| `server/src/services/principal-access-compatibility.ts` | 补回函数加可选参数 `skipHumanGrant` | +15 |
| `server/src/index.ts` | OIDC 开启时传入跳过判断（改动 1 行调用、加 2 行） | +3 / -1 |
| `server/src/auth/better-auth.ts`（001 已有的接入点） | 把 `insertMissingPrincipalGrants` 传给 `applyOidcAuthOptions` | +3 |

另：上游测试 `server/src/__tests__/approval-routes-idempotency.test.ts` 的 mock 加一行 `getMembership`（测试用户为 owner），否则其 hire 审批用例被新规则拦截。

上游必须改这些文件：审批检查只能放在路由里；不改补回，重启就会恢复权限。

## 🆕 US3 要改的文件（2026-10-13 新增，2026-10-14 改为数据库字段，待开发）

创建人修改自己创建的 agent，见 [spec](./spec.md) US3、FR-005/FR-006 和 [research](./research.md) R5。

| | 文件 | 改动 |
|---|---|---|
| ✏️ 上游，只加行 | `packages/db/src/schema/agents.ts` | 新增 `createdByUserId: text("created_by_user_id")`，可为空 |
| 🆕 新增 | `packages/db/src/migrations/0320_*.sql`（`pnpm db:generate` 生成）及 `meta/` | 加列；末尾追加一条 UPDATE：从 `activity_log` 中 `entity_type='agent'`、`action in ('agent.created','agent.hire_created')`、`actor_type='user'` 的最早一条，为 `created_by_user_id` 为空的 agent 补值 |
| ✏️ 上游，只加行 | `server/src/services/agents.ts` | `create` 插入时写 `createdByUserId: options?.createdByUserId ?? null`（两个创建入口已传入，路由不用改）。+1 行 |
| ✏️ 上游，只加行 | `server/src/routes/agents.ts` | `assertCanUpdateAgent`（约 2170 行）、`assertCanApplyProtectedAgentChange`（约 2842 行）在返回 403 前调用 `canEditOwnAgent`，通过则放行；加 1 行 import。约 +3 行 |
| ✏️ 上游，只加行 | `server/src/services/agent-instruction-authorization.ts` | `authorizeInstructionCommit` 拒绝前调用 `canEditOwnAgentById`（保存 `AGENTS.md` 等指令文件走这里，不经过路由检查）；加 1 行 import。+2 行 |
| 🆕 新增 | `server/src/auth/agent-owner.ts` | `canEditOwnAgent(req, access, agent)`：操作人是 board 用户、`agent.createdByUserId` 等于自己、且在该公司有 `agents:create` 时返回 true；`canEditOwnAgentById(db, actor, target)`：服务层用，按 agent id 查创建人后同样判断 |
| 🆕 新增 | `server/src/__tests__/agent-owner.test.ts` | 上面函数的单元测试：创建人、非创建人、创建人为空、没有 `agents:create`、agent 调用者 |
| 🆕 新增 | `server/src/__tests__/agent-owner-edit-routes.test.ts` | 路由测试：创建人改自己 agent 的配置和指令成功，改别人的 403；请求体里带 `createdByUserId` 不会改写创建人；管理员不受影响 |
| 🆕 新增 | `server/src/__tests__/agent-created-by.test.ts` | 内嵌 Postgres：`create` 写入创建人；迁移补值 SQL 从活动日志补老 agent、不覆盖已有值 |
| ✏️ 我们已有 | `deploy/aliyun/tests/sso-e2e/e2e.mjs` | A 改自己直接创建的、审批通过的 agent 成功；改管理员创建的 403；去掉角色并重新登录后改自己的也 403。原有检查"A cannot change the agent configuration"改为改别人创建的 agent |
| ✏️ 我们已有 | `deploy/aliyun/README.md`、`doc/DEPLOYMENT-MODES.md` | 补一句：创建人可修改自己创建的 agent；升级会新增一个数据库字段 |

不改 `packages/shared` 类型和界面：界面不需要显示创建人。不改 Keycloak 配置。

**和上游同步的影响**：以后合并上游时，如果上游也新增了 `0320` 号迁移，需要把我们的迁移重新编号并重新生成 `meta/`。

## 测试顺序（TDD，先写失败测试）

1. `company-admin` → 2. 三个路由 → 3. 登录同步 → 4. 启动补回跳过 → 5. `provision.sh` → 6. sso-e2e、stack-smoke（含重启后检查）
7. US3：`agent-owner` → 两个检查函数的路由测试 → sso-e2e。只跑相关测试，不跑全量。
