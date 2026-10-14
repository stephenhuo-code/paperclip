# Research: 数字员工的管控

## R1. 重启会补回已收回的权限

- **发现**: 启动时 `server/src/index.ts:707` 调用 `backfillPrincipalAccessCompatibility`，按成员角色补齐默认权限（`principal-access-compatibility.ts:127-134`）。operator 默认有 `agents:create`、`agents:configure`（`company-member-roles.ts`）。
- **决定**: 补回函数加可选参数 `skipHumanGrant`。OIDC 开启时，`account` 表中有 `provider_id = 'keycloak'` 的用户跳过这两项。

## R2. 授予权限时不能改成员角色

- **发现**: `setPrincipalPermission(..., true)` 会把成员角色改成 `member`（`access.ts:1013`）。
- **决定**: 授予用 `insertMissingPrincipalGrants`，收回用 `setPrincipalPermission(..., false)`，先用 `listPrincipalGrants` 读现状。

## R3. 批准新建 agent 有两个入口

- **发现**: `POST /api/approvals/:id/approve|reject|request-revision`（`approvals.ts:296/412/448`）只检查 `assertBoard`；`POST /api/agents/:id/approve`（`agents.ts:5956`）只要求 `agents:create`。两者都不要求管理员。
- **决定**: 两个入口都加 `assertCompanyAdmin`。`POST /api/agents/:id/terminate` 终止待审批 agent 时会驳回申请（`agents.ts:6019-6028`），同样加检查。暂停、恢复、删除及终止已审批的 agent 需要 `agents:create`（`getAccessibleAgent` → `assertBoardCanManageAgentsForCompany`，`agents.ts:1812`），即只有 `agent-creator` 员工和管理员能做，保持现状。

## R4. Keycloak 角色如何进入令牌

- **发现**: 登录时 Paperclip 读的是 ID 令牌；Keycloak 的客户端角色默认不在 ID 令牌里。
- **决定**: `provision.sh` 在 `paperclip` 客户端加映射 `oidc-usermodel-client-role-mapper`：`claim.name=paperclip_roles`、`multivalued=true`、只放 ID 令牌、`usermodel.clientRoleMapping.clientId=paperclip`。

## R5. 创建人修改自己创建的 agent（2026-10-13，2026-10-14 改为数据库字段）

- **发现**: agent 表没有创建人字段。两个创建入口（直接创建 `agents.ts:5092`、新建申请 `agents.ts:4838`）都已把 `createdByUserId`（board 用户）传给 `agentService.create` 的 options（`services/agents.ts:138`），但没有存进 agent 表。活动日志里 `agent.created` / `agent.hire_created` 的操作人也是创建人。修改配置的路由入口经过 `assertCanUpdateAgent`（`agents.ts:2170`）和 `assertCanApplyProtectedAgentChange`（`agents.ts:2842`）；指令文件（`AGENTS.md` 等）的保存在服务层另由 `authorizeInstructionCommit`（`services/agent-instruction-authorization.ts:158`）检查，被指令修订、agent 文件存储和运行时工具三处调用（2026-10-14 本地测试时发现）。`createAgentSchema` / `updateAgentSchema` 不含该字段，接口无法写入或改写它。
- **决定**: agent 表新增可为空的 `created_by_user_id`（与 issue 表的 `created_by_user_id` 一致）。`agentService.create` 把 options 里的 `createdByUserId` 写入。迁移时从活动日志为老 agent 补一次（只补空值）。新函数 `canEditOwnAgent`：操作人是创建人且仍有 `agents:create` 时放行，在上面三个检查拒绝前调用（服务层用按 agent id 查询的 `canEditOwnAgentById`）。去掉 `agent-creator` 角色即同时收回修改权。
- **放弃**: 只查活动日志（日志用于审计，不宜作授权依据，以后若有清理会悄悄失效）；写进 `agents.metadata`（可通过修改接口伪造）；单独建一张创建人表（同样要迁移，查询更绕）。
