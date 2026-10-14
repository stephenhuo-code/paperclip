# Contract: 数字员工的管控

## ID 令牌

```json
{ "paperclip_roles": ["agent-creator"] }
```

缺失或格式不对按没有角色处理。

## 新增的 403

| 接口 | 条件 |
|---|---|
| `POST /api/approvals/:id/approve`、`/reject`、`/request-revision` | 审批类型为 `hire_agent`，且不是管理员 |
| `POST /api/agents/:id/approve` | 不是管理员 |
| `POST /api/agents/:id/terminate` | agent 状态为 `pending_approval`，且不是管理员 |
| `PATCH /api/companies/:companyId` | 改变 `requireBoardApprovalForNewAgents`，且不是管理员 |

管理员 = `local_implicit`、实例管理员、或公司 owner/admin。

## 活动日志

权限变化时写 `company_membership.sso_permissions_synced`，details 为 `{ providerId, granted, revoked }`。

## 新增的放行（US3）

修改 agent 配置和指令的接口（`PATCH /api/agents/:id` 等，原来要求 `agents:configure`）：操作人有 `agents:create`，且是该 agent 的创建人（`agents.created_by_user_id`）时，也放行。

## 数据库

`agents.created_by_user_id text null`：创建 agent 的 board 用户。由 agent 创建流程写入，接口不能修改。老 agent 在迁移时从活动日志补值。
