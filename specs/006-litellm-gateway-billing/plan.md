# Implementation Plan: 模型网关统一接入与按运行计费

**Branch**: `feat/keycloak-sso` | **Date**: 2026-10-17 | **Spec**: [spec.md](./spec.md) | **验证记录**: [REPORT.md](../../deploy/aliyun/experiments/litellm-verify/REPORT.md)

## 方案

在阿里云部署（`deploy/aliyun`）中增加两个服务，**不改 Paperclip 代码**：

```text
                         ┌─────────────── ECS ───────────────┐
 管理员浏览器 ─443─▶ caddy ─LLM_DOMAIN─▶ litellm（管理界面 /ui，仅管理员网段）
                     │                       ▲   │
 paperclip ─(HTTPS, 经 caddy)────────────────┘   └─▶ DeepSeek / Kimi / MiniMax
   └─ agent 进程：启动脚本给每个请求加 x-litellm-tags: paperclip-run / paperclip-task
 gateway-sync（每 30 秒）：
   ① 补齐：选了网关连接、启动命令为空的 Claude Code agent → 补上启动脚本
   ② 写回：litellm 花费记录（带运行标签）→ 查运行的任务 / 项目 → Paperclip 费用接口
 postgres：新增 litellm 库
                         └───────────────────────────────────┘
```

1. **litellm**：固定版本镜像（同步到 ACR）。模型和单价存在它自己的数据库，在管理界面中编辑（`STORE_MODEL_IN_DB=True`），上游 Key 在界面中录入并由 LiteLLM 加密保存（`LITELLM_SALT_KEY`）。自带钩子 `hooks.py`：
   - 原样转发调用方的 User-Agent（FR-005）；
   - 拒绝调用未设单价的模型（FR-004b）。
2. **访问地址**：新域名 `LLM_DOMAIN`（如 `llm.ai-datum.net`），Caddy 签发证书。**整个域名**只允许 `ADMIN_ALLOWED_CIDRS` 和容器内网访问（FR-002）。Paperclip 容器通过 Docker 网络别名把 `LLM_DOMAIN` 解析到 caddy，走内网 HTTPS，不经公网（满足 Paperclip"网关必须 HTTPS"的要求）。
3. **启动脚本** `claude-agent-acp-tagged`：由 docker-compose 挂载进 paperclip 容器，不改镜像（FR-004）。
4. **gateway-sync**：一个小的 Node 服务，每 30 秒执行补齐和写回（FR-004a、FR-007）：
   - 读：litellm 库的花费表（直接只读查询），Paperclip 库的运行 → 任务 / 项目（只读角色）；
   - 写：只通过 Paperclip 现有接口——`PATCH /api/agents/:id`（补启动命令）、`POST /api/companies/:id/cost-events`（写回花费，幂等键 `litellm:<请求号>`），这样 Paperclip 自己的预算判断、暂停、事件照常触发（FR-008）；
   - 每次扫描最近 2 小时的记录，靠幂等键去重，中断后自动补齐。
5. **部署脚本**：发布时确保 litellm 库和角色存在；健康检查加入 litellm 和 gateway-sync；每日备份加入 litellm 库（FR-009、FR-010）。

## 已确认的调整

没有运行标识的调用（连接检查、补齐前的运行）无法确定所属 agent，**不写回 Paperclip**：金额在网关界面可见，gateway-sync 每小时在日志中汇总"未归属"金额。spec 已同步修改（2026-10-17）。

## Technical Context

- **新增服务**：LiteLLM 1.105.1（`ghcr.io/berriai/litellm`，固定摘要，经 ACR 镜像）；gateway-sync（`node:24-alpine`，无 npm 依赖，只用 Node 内置模块 + `psql`/`pg` 协议——见 R6）
- **语言**：Bash（部署脚本，shellcheck）、Node.js ESM（gateway-sync）、Python（LiteLLM 钩子，LiteLLM 插件接口）
- **测试**：`node:test`（compose 配置、gateway-sync 逻辑用假 LiteLLM / 假 Paperclip）、现有部署沙箱测试；真实环境在 `~/paperclip-local` 验证
- **约束**：不改 Paperclip 代码（`server/`、`ui/`、`packages/`）；上游 Key 不进仓库；可重复部署

## Research（决定与依据）

| # | 问题 | 决定 | 依据 |
|---|---|---|---|
| R1 | LiteLLM 数据库 | 复用现有 postgres，新增 `litellm` 库和同名角色（密码 `LITELLM_DB_PASSWORD`）。`postgres/init.sh` 只在空库时运行，所以由 `deploy.sh` 在启动前幂等创建 | 现有 init.sh 注释；生产库已存在 |
| R2 | 管理界面与单价编辑 | `STORE_MODEL_IN_DB=True`，模型在界面中添加；`config.yaml` 只放全局设置和钩子 | 实验中模型写在 config 文件里，界面无法编辑——**实现前先验证**界面可编辑单价并即时生效 |
| R3 | Paperclip 访问网关 | Paperclip 只接受 HTTPS 网关（或回环 HTTP）。caddy 加网络别名 `${LLM_DOMAIN}`，paperclip 容器内解析到 caddy，证书即 Caddy 为该域名签发的正式证书 | `packages/shared/src/ai-provider-routing.ts:56-75`；实验第二阶段 |
| R4 | 访问限制 | `LLM_DOMAIN` 整站 `remote_ip {$ADMIN_ALLOWED_CIDRS} private_ranges`，其余 403 | 与 Keycloak 管理台同样方式（Caddyfile:19-29） |
| R5 | User-Agent 与未设单价 | LiteLLM 钩子 `async_pre_call_hook`：从请求元数据取调用方 User-Agent 写入上游请求头；模型的单价字段缺失时返回 400"模型未设单价" | 源码：LiteLLM 只转发 `x-*` 头，默认 UA 为 `litellm/<版本>`，元数据中保留了原始 UA——**实现前先验证**钩子能覆盖上游 UA |
| R6 | gateway-sync 读数据 | 直接只读查询 litellm 的花费表（`LiteLLM_SpendLogs`）和 Paperclip 的 `heartbeat_runs`/`issues`/`agents`（新建只读角色 `paperclip_readonly`）；镜像内装 `postgresql-client` 用 `psql` | 实验中 `/spend/logs` 接口偶有连接中断；SQL 可按时间范围增量读 |
| R7 | gateway-sync 写 Paperclip 的凭证 | 用应急管理员邮箱和密码登录取会话（`PAPERCLIP_SYNC_EMAIL`/`_PASSWORD`，在服务器 `.env`）。Paperclip 的 board API Key 30 天过期（`server/src/services/board-auth.ts:14`），不适合常驻服务 | 写入必须走接口才能触发预算；应急管理员是现有唯一的长期凭证 |
| R8 | 补齐规则 | 只处理 `adapterType=claude_local`、`runtimeConfig.aiConnection.connectionId` 等于网关连接、`adapterConfig.agentCommand` 为空的 agent；其余列入"不经网关"日志 | spec Clarifications Q2 |
| R9 | 网关连接如何识别 | 在 `.env` 中写入 `PAPERCLIP_GATEWAY_CONNECTION_NAME`（默认"模型网关"），gateway-sync 按名称找连接；连接由管理员在 Paperclip 界面创建一次（手册写明步骤） | 不改 Paperclip；连接需要 Paperclip 加密保存 Key |
| R10 | 写回字段 | 每条花费：agent、运行、任务、项目、模型、输入（含缓存写入）、缓存命中、输出、金额（LiteLLM 计算）、`billingType=metered_api`、`costStatus=estimated`、`provider=biller=litellm` | 实验第三阶段已验证预算生效与幂等 |

## Constitution Check

`.specify/memory/constitution.md` 仍是空模板，按 `AGENTS.md` 检查：

| 规则 | 结论 |
|---|---|
| 尽量少改上游 | ✅ 不改 Paperclip 代码；只改 `deploy/aliyun` 和发布工作流 |
| 测试先行 | ✅ 每个部件先写失败测试 |
| 变更写活动日志 | ✅ 补齐和写回都走 Paperclip 接口，服务端照常记录 |
| 密钥不入仓库 | ✅ 上游 Key 存在 LiteLLM 库（加密）；LiteLLM 主密钥、盐、数据库密码、同步凭证只在服务器 `.env` |

## 要改的文件

| | 文件 | 改动 |
|---|---|---|
| 🆕 | `deploy/aliyun/litellm/config.yaml` | 全局设置：主密钥、数据库、`STORE_MODEL_IN_DB`、加载钩子 |
| 🆕 | `deploy/aliyun/litellm/hooks.py` | 转发调用方 User-Agent；拒绝未设单价的模型 |
| 🆕 | `deploy/aliyun/litellm/claude-agent-acp-tagged.sh` | 启动脚本（实验版定稿） |
| 🆕 | `deploy/aliyun/gateway-sync/sync.mjs` | 补齐 + 写回主循环 |
| 🆕 | `deploy/aliyun/gateway-sync/lib.mjs` | 纯逻辑：补齐判断、花费行 → 费用记录、未归属汇总（便于测试） |
| 🆕 | `deploy/aliyun/gateway-sync/Dockerfile` | `node:24-alpine` + `postgresql-client` |
| 🆕 | `deploy/aliyun/tests/gateway-sync.test.mjs` | 补齐规则、字段映射、幂等、未归属、Paperclip 登录失效重登 |
| 🆕 | `deploy/aliyun/tests/litellm-hooks-test.sh` | 真实 LiteLLM + 假上游：UA 原样转发、未设单价被拒（同 keycloak-provision-test 的方式） |
| ✏️ | `deploy/aliyun/docker-compose.yml` | 新增 `litellm`、`gateway-sync`；caddy 网络别名 `${LLM_DOMAIN}`；paperclip 挂载启动脚本 |
| ✏️ | `deploy/aliyun/Caddyfile` | `{$LLM_DOMAIN}` 站点：整站限管理员网段 + 内网，反代 `litellm:4000` |
| ✏️ | `deploy/aliyun/scripts/deploy.sh` | 启动前幂等创建 `litellm` 库 / 角色和 `paperclip_readonly` 角色 |
| ✏️ | `deploy/aliyun/scripts/lib.sh` | 健康检查加入 litellm、gateway-sync |
| ✏️ | `deploy/aliyun/scripts/backup.sh`、`restore.sh` | 备份 / 恢复加入 `litellm` 库 |
| ✏️ | `deploy/aliyun/postgres/init.sh` | 全新部署时同时创建 `litellm` 库和只读角色 |
| ✏️ | `deploy/aliyun/env.example` | `LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY`、`LITELLM_DB_PASSWORD`、`PAPERCLIP_READONLY_DB_PASSWORD`、`PAPERCLIP_SYNC_EMAIL`/`_PASSWORD` |
| ✏️ | `deploy/aliyun/environments/production.env` | `LLM_DOMAIN`、`LITELLM_IMAGE`（版本）、`PAPERCLIP_GATEWAY_CONNECTION_NAME` |
| ✏️ | `deploy/aliyun/scripts/bootstrap.sh` 或 `first-run.sh` | 首次生成上述密钥写入 `.env`（已有则跳过） |
| ✏️ | `.github/workflows/deploy-aliyun.yml` | 镜像同步加入 LiteLLM；构建并推送 gateway-sync 镜像 |
| ✏️ | `deploy/aliyun/tests/compose.test.mjs`、`tests/fixtures/production.env` | 新服务、挂载、别名、环境变量 |
| ✏️ | `deploy/aliyun/tests/helpers/sandbox.mjs` | deploy.sh 新步骤用到的假命令 |
| ✏️ | `deploy/aliyun/docs/manual.md` | 新章节：网关登录、添加模型与单价、在 Paperclip 中建网关连接、agent 选网关、查看"不经网关"和"未归属" |
| ✏️ | `deploy/aliyun/README.md` | 架构图与服务表加入两个服务；域名与 DNS |
| ✏️ | `deploy/aliyun/docs/architecture.svg` | 加入网关和同步服务 |
| 📁 保留 | `deploy/aliyun/experiments/litellm-verify/` | 作为验证记录提交，不参与部署 |

不改：`server/`、`ui/`、`packages/`、`Dockerfile`（Paperclip 镜像）、`keycloak/provision.sh`。

## 测试与验证（TDD，只跑相关测试）

1. **先做两个小验证**（R2、R5），不通过则回来调整方案：LiteLLM 界面编辑单价即时生效；钩子能覆盖上游 UA 并拒绝未设单价的模型。
2. `gateway-sync.test.mjs`、`litellm-hooks-test.sh`、`compose.test.mjs` 先写失败用例 → 实现 → 通过。
3. `deploy/aliyun/tests/run.sh`（shellcheck + 部署测试）。
4. 本地 `~/paperclip-local` 全流程：部署 → 网关界面加模型和单价 → Paperclip 建网关连接 → agent 选网关 → 运行 → 费用页按项目显示 → 项目超预算被暂停；一个自定义启动命令的 agent 保持不变。
5. 提交后由你推送发布；生产前需要你：在阿里云 DNS 添加 `LLM_DOMAIN` 解析到 ECS，确认 `ADMIN_ALLOWED_CIDRS`。
