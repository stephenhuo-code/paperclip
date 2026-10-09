# Data Model: Keycloak SSO + 阿里云部署

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-09

**本功能不新增数据表，也不做数据库迁移。** 所有实体都映射到现有表或配置。

## 1. 现有表的使用方式

### 平台用户 → `user`（better-auth，`packages/db/src/schema/auth.ts`）

| 字段 | 来源 | 规则 |
|---|---|---|
| `id` | better-auth 生成 | — |
| `name` | Keycloak `name`（缺省回退 `preferred_username`） | 每次登录同步（FR-005） |
| `email` | Keycloak `email` | 每次登录同步；必须存在，否则拒绝登录 |
| `emailVerified` | Keycloak `email_verified` | 仅 `true` 时允许与已有本地账号关联（FR-010） |

### 外部身份关联 → `account`（`auth.ts:37-60`）

| 字段 | 值 |
|---|---|
| `providerId` | `"keycloak"` |
| `accountId` | Keycloak `sub` |
| `issuer` | Keycloak realm URL（如 `https://sso.example.cn/realms/digital-workforce`） |
| `idToken` / `accessToken` / `refreshToken` | better-auth 写入 |

唯一约束：(`issuer`, `accountId`)。同一 Keycloak 用户永远对应同一平台用户。

### 工作空间成员关系 → `company_memberships`

| 字段 | SSO 登录时的写入规则 |
|---|---|
| `companyId` | 来自组织映射 |
| `principalType` | `"user"` |
| `principalId` | 平台用户 `id` |
| `membershipRole` | 新建时 `"member"`；**已存在时不修改**（FR-006） |
| `status` | 新建时 `"active"`；已存在时不修改 |

通过 `access.ensureMembership(...)`（`server/src/services/access.ts:871`）写入，幂等。

### 活动日志 → `activity_log`

SSO 新建成员关系时写一条：`action = "company_membership.sso_joined"`，`actorType = "user"`，`details = { providerId: "keycloak", organization: "<alias>" }`。已存在成员关系时不写。

### 会话 → `session`

`expiresAt` = 创建时间 + `PAPERCLIP_AUTH_SESSION_TTL_SECONDS`（生产配置 86400）。

## 2. 配置实体（环境变量，不入库）

### 组织 ↔ 工作空间映射

```text
PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP = {"<keycloak-org-alias>": "<paperclip-company-id>", ...}
```

验证规则：
- 必须是合法 JSON 对象；值必须是 UUID 格式；为空对象或缺失时，OIDC 登录全部拒绝（fail closed）。
- 键集合即准入白名单（FR-002、FR-004a）。
- 首期仅一条。

### Keycloak 用户（权威来源，存于 Keycloak）

平台读取的声明：`sub`、`email`、`email_verified`、`name`、`preferred_username`、`organization`。`organization` 兼容两种形态：
- 列表：`["acme"]`
- 对象：`{"acme": {"id": "..."}}`（取键）

## 3. 登录状态流转

```text
未登录
  │ 点击"使用企业账号登录"
  ▼
Keycloak 认证 ──失败/取消──▶ 回到登录页（显示错误）
  │ 成功，回调 /api/auth/callback/keycloak
  ▼
validateUserInfo：组织 ∩ 映射键 = ∅ ？
  ├─ 是 ──▶ 拒绝（403 / 错误页），不建账号、不建会话
  └─ 否
      ▼
  首次？──是──▶ 创建 user + account（或按已验证邮箱关联已有 user）
      │
      ▼
  对每个匹配组织：ensureMembership(member) ──新建时──▶ 写活动日志
      │
      ▼
  创建 session（TTL 24h）──▶ 进入平台
```

## 4. 部署环境（配置，不入库）

| 属性 | 存放位置 |
|---|---|
| 环境名、地域、域名、ACR 命名空间、ECS 实例 ID | `deploy/aliyun/environments/<env>.env`（入仓库，非敏感） |
| 服务端密钥、数据库口令、Keycloak 管理员口令、OIDC client secret | ECS `/opt/paperclip/.env`（600 权限，不入仓库） |
| 当前/上一版本号 | ECS `/opt/paperclip/state/current`、`/opt/paperclip/state/previous` |
| CI 凭据（ACR 推送、云助手 RAM AccessKey） | GitHub Secrets |
