# Implementation Plan: 基于 Keycloak 单点登录的数字员工平台（阿里云自动化部署）

**Branch**: `feat/keycloak-sso` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-keycloak-sso-aliyun/spec.md`

## Summary

在 Paperclip（authenticated 模式）上接入 Keycloak 单点登录，并提供一套在阿里云单台 ECS 上的自动化部署方案。

- **登录**：启用 better-auth 1.7.2 自带的 `genericOAuth` + `keycloak()` 插件；用 `validateUserInfo` 按 Keycloak `organization` 声明做准入；登录成功后用现有的 `ensureMembership` 把用户以普通成员身份加入映射的公司。无数据库迁移，无新数据表。
- **个人空间与数字员工**：完全沿用 Paperclip 现有能力（收件箱、我的主 agent、私有任务/项目）；DeepSeek、MiniMax、Kimi 通过现有 `claude_local`（Anthropic 兼容接口）或 `kimi_local` 接入，零 adapter 代码。
- **部署**：新增 `deploy/aliyun/`（Docker Compose：Caddy + Paperclip + Keycloak + PostgreSQL 四个常驻服务 + 一次性的 Keycloak 配置任务；备份由宿主机 cron 执行）和 GitHub Actions 工作流（境外构建 → 阿里云 ACR → 云助手在 ECS 上执行部署脚本 → 健康检查 → 失败回滚）。

技术细节与取舍见 [research.md](./research.md)。

## Technical Context

**Language/Version**: TypeScript（Node.js 24，仓库现有工具链）；部署脚本为 Bash + Docker Compose YAML

**Primary Dependencies**: better-auth 1.7.2（已有，含 `genericOAuth` 插件）；Keycloak 26.8（固定 `26.8.0`；Keycloak 初始化用镜像自带的 `kcadm.sh`）；Caddy 2；PostgreSQL 17

**Storage**: PostgreSQL 17（ECS 上自建容器，`paperclip` 与 `keycloak` 两个库）；Paperclip 数据卷 `/paperclip`；备份到阿里云 OSS

**Testing**: 全程 TDD（红 → 绿 → 重构）。服务端与前端用 Vitest（`pnpm test`）；部署脚本与 Compose 配置用 bats-core + shellcheck + actionlint（`deploy/aliyun/tests/run.sh`，在容器中运行，不新增 npm 依赖）；真实 Keycloak 登录与阿里云生产按 [quickstart.md](./quickstart.md) 验收

**Target Platform**: 阿里云 ECS（中国大陆地域，Linux x86_64，建议 4 vCPU / 16 GB / 100 GB ESSD）

**Project Type**: Web 服务（现有 monorepo：`server/` + `ui/`）+ 部署基础设施

**Performance Goals**: 单点登录全程 ≤30 秒（SC-001）；发布从触发到上线 ≤20 分钟（SC-006）

**Constraints**: 尽量少改上游代码；大陆网络（不依赖 Docker Hub/quay/ghcr/npm 官方源的运行时访问）；密钥不进仓库、不进 CI 日志；发布中断 ≤5 分钟

**Scale/Scope**: 1 个组织、数十名用户、数十个数字员工、1 套生产环境

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 仍为未填写的模板，因此以仓库 `AGENTS.md` 的核心工程规则作为门禁：

| 门禁（AGENTS.md） | 设计是否满足 | 说明 |
|---|---|---|
| §5.1 公司隔离 | ✅ | 自动入公司只针对映射表中的公司；不改任何跨公司访问检查 |
| §5.2 契约同步（db/shared/server/ui） | ✅ | 无 schema 变更；`/api/health` 新增 `auth.oidc` 字段，同步 `ui/src/api/health.ts` 类型 |
| §5.3 控制面不变量 | ✅ | 不触碰任务指派、checkout、审批、预算逻辑 |
| §5.3 写操作记活动日志 | ✅ | SSO 自动入公司时调用 `logActivity` 记录 `company_membership.sso_joined` |
| §5.7 三条数据通路 | ✅ | 只通过配置关闭第一方遥测，不改 `packages/shared/src/telemetry/` 代码 |
| §6 数据库变更流程 | ✅（不适用） | 无 schema 变更，无迁移 |
| §8 API 与认证 | ✅ | 不新增业务端点；登录端点由 better-auth 提供；准入失败返回 403 |
| §9 UI | ✅ | 登录页改动遵守 token 规则，提交前运行 `pnpm check:token-gates` |
| §11 文档同步 | ✅ | 更新 `doc/DEPLOYMENT-MODES.md`（新增 OIDC 小节），新增 `deploy/aliyun/README.md` |

**Post-design re-check（Phase 1 后）**: 仍全部满足，无需在 Complexity Tracking 中登记违例。

## Project Structure

### Documentation (this feature)

```text
specs/001-keycloak-sso-aliyun/
├── plan.md              # 本文件
├── research.md          # Phase 0：技术调研与决策
├── data-model.md        # Phase 1：实体与配置模型
├── quickstart.md        # Phase 1：端到端验证指南
├── contracts/
│   ├── auth-oidc.md     # 登录相关 HTTP 契约与服务端配置项
│   └── deployment.md    # 部署配置、脚本接口、CI 契约
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2（/speckit-tasks 生成）
```

### Source Code (repository root)

图例：✏️ 修改上游已有文件　➕ 新增文件

```text
paperclip/                                    （fork：stephenhuo-code/paperclip，分支 feat/keycloak-sso）
├── server/src/
│   ├── auth/
│   │   ├── better-auth.ts        ✏️ 注册 Keycloak 插件、会话有效期、账号关联
│   │   └── oidc.ts               ➕ 组织准入、自动加入公司、读取 OIDC 配置
│   ├── config.ts                 ✏️ 读取 PAPERCLIP_AUTH_OIDC_* 环境变量
│   ├── routes/health.ts          ✏️ 健康检查接口返回 auth.oidc 信息
│   └── __tests__/
│       ├── auth-oidc.test.ts         ➕ 配置解析、组织准入、自动入公司
│       ├── better-auth-oidc.test.ts  ➕ 插件接线、会话有效期、账号关联
│       └── health-oidc.test.ts       ➕ 健康检查的 auth.oidc 字段
├── ui/src/
│   ├── api/health.ts             ✏️ 类型新增 auth.oidc
│   ├── api/auth.ts               ✏️ 新增 signInSocial()
│   └── pages/
│       ├── Auth.tsx              ✏️ 企业登录按钮、应急登录折叠区
│       └── Auth.oidc.test.tsx    ➕ 登录页 OIDC 行为
├── deploy/aliyun/                ➕ 全部部署资产
│   ├── README.md                 部署手册、数字员工配置、上游同步
│   ├── docker-compose.yml        4 个常驻服务 + 1 个一次性任务（见下文"运行时服务"）
│   ├── Caddyfile                 按域名分流、自动 HTTPS、Keycloak 管理后台限 IP
│   ├── env.example               密钥键名模板（无值，不含 ANTHROPIC_*）
│   ├── environments/
│   │   └── production.env        非敏感参数：域名、地域、镜像仓库等
│   ├── keycloak/provision.sh     幂等初始化 realm、组织、客户端（用 Keycloak 镜像自带的 kcadm.sh）
│   ├── postgres/init.sh          首次初始化 paperclip、keycloak 两个库和账号
│   ├── scripts/
│   │   ├── bootstrap.sh          ECS 首次初始化
│   │   ├── deploy.sh             发布、健康检查、失败回滚
│   │   ├── backup.sh             备份到 OSS、检查证书有效期
│   │   └── restore.sh            从 OSS 恢复
│   └── tests/                    bats 测试 + run.sh（shellcheck、actionlint、bats）
├── .github/workflows/
│   └── deploy-aliyun.yml         ➕ 构建 → 推到 ACR → 云助手部署
├── doc/DEPLOYMENT-MODES.md       ✏️ 追加 OIDC 小节
└── specs/001-keycloak-sso-aliyun/   本功能的规格、方案、任务文档
```

上游原有文件只修改 7 个（`better-auth.ts`、`config.ts`、`health.ts`、`ui/src/api/health.ts`、`ui/src/api/auth.ts`、`Auth.tsx`、`DEPLOYMENT-MODES.md`）；测试全部写在新文件中，不修改任何上游测试文件。

### 运行时服务（ECS 上的 Docker Compose）

4 个常驻服务 + 1 个一次性任务：

| 服务 | 作用 | 对外端口 | 持久化 |
|---|---|---|---|
| `caddy` | 反向代理；自动申请、续期 HTTPS 证书；按域名分流 | **80、443（唯一对外的服务）** | `caddy-data` |
| `paperclip` | Paperclip 平台（界面 + API）；**数字员工作为子进程在此容器内运行**（research R16） | 无，只经 Caddy 访问 | `paperclip-data:/paperclip` |
| `keycloak` | 单点登录服务 | 无，只经 Caddy 访问；管理后台按 IP 限制；9000 不暴露 | 无（数据在 PostgreSQL） |
| `postgres` | 数据库，`paperclip`、`keycloak` 两个库，各自独立账号 | 无 | `pgdata` |
| `keycloak-config` | **一次性任务**：每次部署时自动配置 realm、组织、客户端，完成即退出 | 无 | 无 |

备份不单独起容器：宿主机 cron 每天 03:00 执行 `backup.sh`。

```text
                     ┌──────────────── ECS（单台） ────────────────┐
  用户浏览器 ──443──▶│ caddy ──APP_DOMAIN──▶ paperclip ──▶ postgres │
                     │   │                     └─ claude 子进程 ×N   │
                     │   └──SSO_DOMAIN──▶ keycloak ──▶ postgres     │
                     │ keycloak-config（部署时运行一次）──▶ keycloak │
                     │ cron ──▶ backup.sh ──▶ OSS                   │
                     └──────────────────────────────────────────────┘
```

### ECS 运行目录

```text
/opt/paperclip/
├── .env                 密钥（权限 600，由 bootstrap.sh 生成，不入仓库）
├── deploy/              deploy/aliyun/ 的副本
└── state/
    ├── current          当前版本号
    └── previous         上一个版本号（回滚用）

Docker 数据卷：paperclip-data（附件、工作区、密钥主密钥）、pgdata、caddy-data
```

**Structure Decision**: 沿用现有 monorepo 结构。上游代码的改动只落在 7 个文件（`better-auth.ts`、`config.ts`、`health.ts`、`ui/src/api/health.ts`、`ui/src/api/auth.ts`、`Auth.tsx`、`DEPLOYMENT-MODES.md`），其余全部是新文件（`server/src/auth/oidc.ts`、测试、`deploy/aliyun/`、新工作流），以满足 FR-023 / SC-009。这 7 个文件即"文档列明的定制点"，记录在 `deploy/aliyun/README.md` 的"上游同步"一节。

## Implementation Phases（供 /speckit-tasks 拆解）

1. **验证先行（spike）**：确认 `validateUserInfo` / `user.create.after` 中可用字段；确认 Keycloak `organization` 声明格式；确认三家模型 Anthropic 兼容端点、模型名、工具调用兼容性，以及 Claude Code CLI 在大陆可用、是否需要 `ANTHROPIC_SMALL_FAST_MODEL`（R8）；确认 bwrap 文件沙箱能否在容器内使用（R16）；确认 Keycloak 初始化方式（T031 结论：config-cli 不支持组织，改用 kcadm）。
2. **登录接入（US1、US3）**：`oidc.ts` + `config.ts` + `better-auth.ts` + 单元测试。
3. **登录页（US1）**：health 字段 + UI 按钮 + 密码表单折叠 + token gates。
4. **本地全栈冒烟**：在本机用 `deploy/aliyun/docker-compose.yml` 起全栈（Caddy 用本地证书），跑通 quickstart 场景 1~4。
5. **阿里云部署（US4）**：bootstrap/deploy/backup/restore 脚本 + keycloak/provision.sh + 工作流 + README。
6. **生产验收**：按 quickstart 场景 5~8 在真实 ECS 上验收；配置三家模型的数字员工（SC-002a）。
7. **收尾**：文档、`pnpm -r typecheck && pnpm test:run && pnpm build`。

## Complexity Tracking

无违例，不需要登记。
