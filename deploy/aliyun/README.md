# 阿里云部署（Keycloak SSO 数字员工平台）

在**一台阿里云 ECS（中国大陆地域）**上运行 Paperclip + Keycloak 单点登录，推送代码即自动发布。设计依据见 `specs/001-keycloak-sso-aliyun/`（规格、方案、调研、契约）。

- [架构](#架构)
- [首次部署](#首次部署)
- [首个管理员与组织映射](#首个管理员与组织映射)
- [在 Keycloak 中管理用户](#在-keycloak-中管理用户)
- [日常发布与回滚](#日常发布与回滚)
- [备份与恢复](#备份与恢复)
- [Keycloak 升级与受管配置](#keycloak-升级与受管配置)
- [配置数字员工](#配置数字员工)
- [已知风险](#已知风险)
- [测试](#测试)
- [上游同步](#上游同步)

## 架构

```text
                     ┌──────────────── ECS（单台） ────────────────┐
  用户浏览器 ──443──▶│ caddy ──APP_DOMAIN──▶ paperclip ──▶ postgres │
                     │   │                     └─ 数字员工子进程      │
                     │   ├──SSO_DOMAIN──▶ keycloak ──▶ postgres     │
                     │   └──LLM_DOMAIN──▶ litellm ──▶ 上游模型服务  │
                     │ gateway-sync：网关花费按运行写回 paperclip   │
                     │ keycloak-config（每次部署运行一次）──▶ keycloak │
                     │ cron 03:00 ──▶ backup.sh ──▶ OSS              │
                     └──────────────────────────────────────────────┘
```

| 服务 | 作用 | 对外端口 |
|---|---|---|
| `caddy` | 反向代理、自动 HTTPS（Let's Encrypt）、Keycloak 管理后台按 IP 限制 | 80、443（唯一对外） |
| `paperclip` | Paperclip 平台；数字员工作为子进程在此运行 | 无 |
| `keycloak` | 单点登录（Keycloak 26.8.0） | 无 |
| `postgres` | `paperclip`、`keycloak` 两个库，各自独立账号 | 无 |
| `litellm` | 模型网关（LiteLLM）：所有模型统一接入，上游 Key 与单价在其管理界面设置；拒绝未设单价的模型；管理界面与接口仅管理员网段和容器内网可访问（specs/006） | 无（经 Caddy 的 `LLM_DOMAIN`） |
| `gateway-sync` | 每 30 秒把网关花费按运行写回 Paperclip（agent / 任务 / 项目），并为选用网关连接（地址为 `PAPERCLIP_GATEWAY_URL`）的 Claude Code agent 自动设置带运行标识的启动命令 | 无 |
| `keycloak-config` | 一次性任务：运行 `keycloak/provision.sh` 初始化 realm、组织、客户端 | 无 |

文件：

| 位置 | 内容 | 是否入仓库 |
|---|---|---|
| `environments/<env>.env` | 非敏感参数：域名、地域、镜像仓库、OSS | 是 |
| ECS `/opt/paperclip/.env` | 密钥和每台服务器自己的状态（模板见 `env.example`） | **否**，权限 600 |
| ECS `/opt/paperclip/deploy/` | 当前版本的部署资产（每次发布从 ACR 的 `paperclip-deploy:<sha>` 更新） | — |
| ECS `/opt/paperclip/state/{current,previous}` | 当前与上一个版本号，回滚用 | — |

## 首次部署

预计 2 小时内完成（SC-005）。

### 1. 准备阿里云资源

| 资源 | 要求 |
|---|---|
| ECS | 中国大陆地域；4 vCPU / 16 GB；系统盘 100 GB ESSD；**开启自动快照**（每日）；Alibaba Cloud Linux 3 或 Ubuntu 22.04+ |
| 安全组 | 入方向只开放 80、443；SSH 仅限运维 IP（日常发布不需要 SSH） |
| 域名 | 已 ICP 备案；两个子域名（如 `agents.<域名>`、`sso.<域名>`）A 记录指向 ECS 公网 IP |
| 容器镜像服务 ACR | 个人版即可；与 ECS 同地域；建一个命名空间（如 `digital-workforce`） |
| OSS | 一个备份桶，与 ECS 同地域；**生命周期规则：30 天后删除** |
| RAM 角色（给 ECS） | 授予备份桶的写权限，绑定到 ECS；名字填到 `OSS_RAM_ROLE` |
| RAM 用户（给 CI） | **只授权**云助手的 `ecs:RunCommand`、`ecs:DescribeInvocationResults`、`ecs:DescribeInvocations`，生成 AccessKey |
| 云助手 | ECS 默认已安装云助手客户端 |

### 2. 填写环境参数

编辑 `environments/production.env`（入仓库，不含密钥）：ECS 实例 ID、地域、ACR 地址与命名空间、两个子域名、Keycloak 组织（名称、别名、邮箱域名）、OSS 桶与内网 endpoint、`OSS_RAM_ROLE`、ACME 邮箱、允许访问 Keycloak 管理后台的网段 `ADMIN_ALLOWED_CIDRS`。

### 3. 配置 GitHub

在你的 fork 中：

1. **Settings → Actions**：启用 Actions（fork 默认禁用），并停用与本部署无关的上游工作流（例如 `docker.yml`、`release*.yml`），避免推送时误触发。
2. **Settings → Environments** 新建 `production`，添加 Secrets：

   | Secret | 用途 |
   |---|---|
   | `ACR_USERNAME` / `ACR_PASSWORD` | 推送镜像到 ACR |
   | `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` | 第 1 步 CI 专用 RAM 用户的 AccessKey |

### 4. 初始化服务器（只做一次）

把 `deploy/aliyun` 复制到服务器（`scp -r` 或 `git clone` 后进入该目录），以 root 执行：

```sh
ACR_USERNAME=<ACR 用户名> ACR_PASSWORD=<ACR 密码> ./scripts/bootstrap.sh production
```

它会：安装 Docker 并设为开机自启；生成 `/opt/paperclip/.env`（随机密钥，已有的键不覆盖）；安装部署资产和 `/opt/paperclip/bin/remote-deploy.sh`；登录 ACR 的 VPC 地址；安装 ossutil；设置每天 03:00 的备份任务。可重复执行。

### 5. 首次发布

把要上线的提交推送到 `deploy/production` 分支，或在 GitHub Actions 里手动运行 **Deploy to Aliyun**。工作流会：运行部署资产测试 → 构建 `paperclip:<sha>`（amd64，带构建缓存）和 `paperclip-deploy:<sha>` → 把 Keycloak、PostgreSQL、Caddy 镜像同步到 ACR → 通过云助手在 ECS 上执行 `remote-deploy.sh` → 等待健康检查。

首次发布完成后：`https://<APP_DOMAIN>` 是 Paperclip 登录页，`https://<SSO_DOMAIN>` 是 Keycloak，证书由 Caddy 自动申请。

> 面向管理员的操作手册见 [docs/manual.md](docs/manual.md)（开通、添加员工、开通 agent）。

## 首个管理员与组织映射

首次发布后，在服务器上以 root 运行引导脚本，按提示输入即可（只做一次，可重复运行）：

```sh
/opt/paperclip/deploy/scripts/first-run.sh production
```

它依次完成（已完成的步骤自动跳过，执行前汇总并要求确认）：

1. 创建你自己的 **Keycloak 管理员**（master realm，权限与 `provisioner` 相同）；
2. 创建 **Paperclip 管理员**（邮箱密码登录的应急管理员，成为实例管理员）；
3. 创建**公司**，管理员为 owner；已有公司时直接选用；
4. 在 Keycloak 组织中创建管理员**同邮箱的企业账号**（密码须与应急密码不同），管理员用企业账号登录即为同一个 owner；
5. 把公司关联到 Keycloak 组织、关闭邮箱注册，并重新部署当前版本。

密码输入不回显，不会出现在屏幕、日志和命令历史里。员工之后统一在 Keycloak 管理台添加（见下一节）。

### 备用：手动初始化

公网部署不允许在浏览器里直接认领实例。不用脚本时按以下步骤（FR-022）：

1. 在服务器上生成一次性邀请链接：

   ```sh
   /opt/paperclip/deploy/scripts/bootstrap-invite.sh production
   ```

   脚本只输出一行邀请链接。容器完全通过环境变量配置，脚本会给 CLI 临时生成一个最小配置文件，用完即删，不影响服务本身；它直接用 node 运行 CLI，不经过 pnpm（pnpm 会在运行时通过 Corepack 从 npmjs.org 下载自身）。

2. 打开登录页，展开 **管理员应急登录**，用邮箱密码注册**应急管理员**（建议使用与日常账号不同的邮箱），然后打开第 1 步的邀请链接并接受。应急管理员成为实例管理员。
3. 应急管理员创建第一个公司，在公司设置里复制公司 ID。
4. 编辑服务器上的 `/opt/paperclip/.env`：

   ```sh
   PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={"<KEYCLOAK_ORG_ALIAS>":"<公司 ID>"}
   PAPERCLIP_AUTH_DISABLE_SIGN_UP=true
   ```

5. 重新发布一次（重新运行工作流，或在服务器上执行 `/opt/paperclip/bin/remote-deploy.sh production <当前 sha>`）。之后组织成员用企业账号登录会自动以普通成员（`operator`）身份加入该公司；邮箱密码注册关闭，只有应急管理员持有密码。

在映射填写之前，所有企业账号登录都会被拒绝（fail closed）。

## 在 Keycloak 中管理用户

用管理员网段内的电脑打开 `https://<SSO_DOMAIN>/admin/`：

- **登录**：用 `first-run.sh` 创建的 Keycloak 管理员。部署自带的 `provisioner`（口令是 `/opt/paperclip/.env` 里的 `KC_BOOTSTRAP_ADMIN_PASSWORD`）只作备用，**不要删除**：每次部署的 Keycloak 初始化要用它。
- **新增员工**：在 realm 中创建用户，**勾选"邮箱已验证"**，设置初始密码，再在 **Organizations → <组织> → Members** 中把用户加入组织。用户第一次登录 Paperclip 时自动建号并加入公司，无需在 Paperclip 中邀请。
- **员工离职**：在 Keycloak 中停用用户或将其移出组织。下次登录即被拒绝；已有会话最长 24 小时内失效（SC-004）。
- **管理员角色**在 Paperclip 中设置（公司设置 → 成员），登录不会覆盖（FR-006）。
- **谁能新建 agent**：在 **Clients → paperclip → Roles** 中有角色 `agent-creator`（部署自动创建）。在用户的 **Role mapping → Assign role → Client roles** 中分配给员工，这名普通员工（operator）就能新建 agent、在开启审批时提交新建申请；没有这个角色就不能。修改 agent 配置由 Paperclip 的 owner/admin 负责；普通员工每次登录都会被收回修改所有 agent 的权限，但仍有 `agent-creator` 的员工可以修改**自己创建的** agent（不需要审批，审批通过后也能改）。员工**下次企业账号登录时生效**。owner/admin 不受影响（specs/002-agent-governance）。
- 用户自助注册已关闭（realm 设置由部署管理）。

## 日常发布与回滚

- **发布**：推送到 `deploy/production`（或手动运行工作流）。目标是 20 分钟内上线（SC-006）。
- **健康检查**：`deploy.sh` 等待 `https://<APP_DOMAIN>/api/health` 返回 `status=ok` 且 `commit` 等于本次提交，同时 Keycloak `/health/ready` 就绪，最长 10 分钟。
- **自动回滚**：检查失败时自动启动上一个版本，工作流以失败结束（GitHub 会发通知），退出码 2。
- **手动回滚**：在服务器上执行 `/opt/paperclip/bin/remote-deploy.sh production <上一个 sha>`（见 `/opt/paperclip/state/previous`）。
- 数据库迁移在 Paperclip 启动时自动执行。包含 specs/002 新增的 `agents.created_by_user_id`：升级时自动加列，并从活动日志为已有 agent 补上创建人。
- `deploy.sh` 发现 `/opt/paperclip/.env` 中有 `ANTHROPIC_` 开头的变量会直接拒绝发布（见[配置数字员工](#配置数字员工)）。

## 模型网关

所有模型经 LiteLLM 统一接入并计费，花费写回 Paperclip 后由公司 / agent / 项目预算控制（[specs/006](../../specs/006-litellm-gateway-billing/spec.md)，验证记录见 `experiments/litellm-verify/REPORT.md`）。操作步骤见[手册第二章](docs/manual.md)。

- **DNS**：首次启用前在阿里云 DNS 添加 `LLM_DOMAIN`（`environments/production.env`）解析到 ECS；Caddy 自动签发证书。
- **密钥**：`LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY`、`LITELLM_DB_PASSWORD`、`PAPERCLIP_READONLY_DB_PASSWORD` 在首次发布时自动生成到 `/opt/paperclip/.env`。**`LITELLM_SALT_KEY` 永远不要修改**，否则网关中保存的上游 Key 无法解密。
- **网关地址**：`environments/<env>.env` 中的 `PAPERCLIP_GATEWAY_URL`（生产为 `https://llm.ai-datum.net`）。Paperclip 中地址为此值的 AI 连接即网关连接，名称随意；gateway-sync 为选用它的 Claude Code agent 自动设置带运行标识的启动命令。
- **写回账号**：管理员在 `.env` 中设置 `PAPERCLIP_SYNC_EMAIL`、`PAPERCLIP_SYNC_PASSWORD`（应急管理员）并重新发布；未设置或登录失败时网关照常工作、花费不写回，发布日志会出现 `warning: gateway-sync …`。
- **启动脚本**：`litellm/claude-agent-acp-tagged.sh` 挂载到 paperclip 容器，给每次模型调用加上运行和任务标识。
- **备份**：`litellm` 库随每日备份一起导出、恢复。

## 备份与恢复

- **每天 03:00** `backup.sh`：备份 `paperclip`、`keycloak` 两个库（`pg_dump -Fc`）和 Paperclip 的附件与密钥主密钥（`data/storage`、`secrets`），通过 OSS 内网上传到 `<桶>/<YYYY-MM-DD>/`；同时检查两个域名的证书，**剩余不足 7 天会以失败退出**并写入 `/var/log/paperclip-backup.log`（请在云监控中对该日志设置告警）。
- **云盘快照**：每日自动快照作为第二道保障。
- **恢复**：`/opt/paperclip/deploy/scripts/restore.sh production <YYYY-MM-DD>`。脚本先下载备份，确认完整后才停服务，恢复两个库和数据卷，再启动并做健康检查。
- **演练**：每季度在一台临时 ECS 上做一次恢复演练（FR-019a）。

## 登录页名称和 logo

`environments/production.env` 中的 `PAPERCLIP_BRAND_NAME`、`PAPERCLIP_BRAND_LOGO_URL` 决定 Paperclip 和 Keycloak 登录页显示的平台名称和 logo；logo 文件放在 `branding/`，由 Caddy 在 `https://<APP_DOMAIN>/brand/` 下提供（见 `branding/README.md`）。两项都留空时保持 Paperclip 原样。修改后提交并发布即生效。

## Keycloak 升级与受管配置

- **升级**（FR-028）：修改 `environments/production.env` 中的 `KEYCLOAK_VERSION`，提交并发布。工作流会把新版本同步到 ACR，Keycloak 启动时自动升级自身的数据库结构。升级前确认当天的备份已完成。
- **受管配置**（FR-025）：`keycloak/provision.sh` 在每次部署时创建或更新下列字段，**在控制台对它们的手工修改会在下次部署时被恢复**：
  - realm：启用、`organizationsEnabled`、禁止自助注册、要求验证邮箱、允许邮箱登录、禁止重复邮箱；设置了 `PAPERCLIP_BRAND_NAME` 时还有显示名称和页头（含 logo）
  - 客户端 `paperclip`：机密客户端、仅标准授权码流程、PKCE S256、client secret、回调地址 `https://<APP_DOMAIN>/api/auth/callback/keycloak`、Web Origin、登出回调
  - 组织：名称、别名、启用、邮箱域名
  - 客户端角色 `agent-creator`（缺少时创建），映射规则 `paperclip-roles`（把 `paperclip` 客户端角色放进 ID 令牌的 `paperclip_roles`）

  用户、角色分配、组织成员、其他客户端以及其余所有设置都不受影响。

## 配置数字员工

数字员工就是 Paperclip 里的 agent。三家国内模型都通过 Paperclip 现有的 `claude_local`（Claude Code CLI，已装在镜像里）接入各自的 **Anthropic 兼容接口**，不需要新的 adapter（调研见 research.md R8）。

| 模型 | Adapter | `ANTHROPIC_BASE_URL` | 模型名（示例） |
|---|---|---|---|
| DeepSeek | Claude Code（`claude_local`） | `https://api.deepseek.com/anthropic` | `deepseek-chat` |
| MiniMax | Claude Code（`claude_local`） | `https://api.minimaxi.com/anthropic` | `MiniMax-M2` |
| Kimi | Claude Code（`claude_local`） | `https://api.moonshot.cn/anthropic` | `kimi-k2` 系列 |

> ⚠️ 上表的接口地址和模型名来自各家公开文档，**尚未在生产环境实测**（任务 T021，需要三家的 API Key）。实测后以实测结果为准并更新本表。Kimi 也可以改用原生的 `kimi_local`（Kimi Code CLI），配置 `KIMI_MODEL_NAME` 与 `KIMI_MODEL_API_KEY`。

**新建审批**：owner/admin 在 **公司设置** 打开"新建 agent 需要审批"后，有 `agent-creator` 的员工新建时会提交申请，由 owner/admin 在 **审批（Approvals）** 页面批准或驳回。只有 owner/admin 能处理这些申请（包括终止待审批的 agent），也只有他们能改这个开关。

### 创建一个数字员工

1. 管理员在公司设置里把该模型的 API Key 保存为**公司密钥**（例如 `deepseek-api-key`）。
2. 新建 agent，Adapter 选 **Claude Code**。
3. 模型下拉框选 **Enter custom model…**，填入上表的模型名。
4. 在 agent 的环境变量中添加：

   | 变量 | 值 |
   |---|---|
   | `ANTHROPIC_BASE_URL` | 上表对应的地址 |
   | `ANTHROPIC_AUTH_TOKEN` | 引用第 1 步保存的公司密钥 |
   | `ANTHROPIC_SMALL_FAST_MODEL` | 同一家的模型名（避免 Claude Code 的辅助调用去请求不存在的 Claude 模型） |
   | `DISABLE_AUTOUPDATER` | `1` |
   | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |

5. 给它分派一个简单任务验证可用。思考强度（effort）首期不设置，第三方接口不一定支持。

### 三条约束（必须遵守）

1. **每个数字员工自己配置**地址、密钥、模型名，密钥一律引用公司密钥，不写明文。
2. **服务器容器环境里不设置任何 `ANTHROPIC_*` 变量**。否则它会成为所有 agent 的默认值，漏配的 agent 会静默调错模型、扣错账户。`deploy.sh` 启动前会检查 `.env`，发现 `ANTHROPIC_` 开头的变量直接失败退出。
3. **共享的 `/paperclip/.claude/settings.json` 里不写 `ANTHROPIC_*`**，服务器上也不要执行 `claude login`。所有 `claude_local` agent 共用这个配置目录（research.md R8.3）。

### 切换模型

把某个数字员工从一家模型换到另一家后，旧的会话可能无法续接，在 agent 页面重置会话即可。

### 预装的 agent CLI

生产镜像只预装 Claude Code、Codex、Kimi Code，并且不包含 Paperclip runner 的远程沙箱工具包（provider pack），镜像约小 2.4 GB。OpenCode、Gemini 类 agent 和 runner 远程沙箱因此不可用；需要时去掉 `.github/workflows/deploy-aliyun.yml` 中的 `CLI_TOOLS`、`PAPERCLIP_SKIP_PROVIDER_PACK` 两个构建参数。原因见 [ADR 0001](docs/adr/0001-slim-production-image.md)。

### 运行隔离

三类数字员工都作为 Paperclip 容器里的子进程运行，各有独立的工作区 `/paperclip/workspaces/<agentId>`，但**文件系统不隔离**（research.md R16）。`claude_local` 自带的 bubblewrap 文件沙箱实测可用，但需要派生镜像并放宽容器的两项安全加固（`seccomp=unconfined`、`systempaths=unconfined`），首期不开启。

## 已知风险

- **单机**：平台、Keycloak、数据库在同一台 ECS 上，服务器故障时一起不可用。所有常驻服务都设置了 `restart: unless-stopped`，Docker 开机自启，服务器恢复后自动恢复；数据靠每日 OSS 备份和云盘快照保障。
- **退出登录不退出 Keycloak**：在 Paperclip 退出后，如果浏览器里的 Keycloak 会话还在，再点企业登录可能不用输入密码（单点登出不在本期范围内）。
- **数字员工不做文件隔离**：见[配置数字员工 → 运行隔离](#运行隔离)。

## 测试

| 命令 | 内容 | 需要 |
|---|---|---|
| `deploy/aliyun/tests/run.sh` | shellcheck、actionlint、部署脚本与 Compose 配置的 node:test 用例 | Docker、Node |
| `deploy/aliyun/tests/keycloak-provision-test.sh` | 对真实 Keycloak 连续初始化两次，验证幂等与受管字段 | Docker |
| `deploy/aliyun/tests/sso-e2e/run-all.sh` | 真实 Keycloak + 独立 Paperclip 实例的单点登录端到端检查 | Docker、Node、本仓库依赖 |
| `deploy/aliyun/tests/stack-smoke/stack-smoke.sh <tag>` | 本机跑完整 Compose 栈（Caddy 内部证书），端到端检查、同版本重发、失败回滚 | Docker、本地构建的 `local/dw/paperclip:<tag>` 镜像、80/443 端口 |

## 上游同步

本平台基于 Paperclip 开源仓库的 fork。定制尽量集中在新文件里；**被修改的上游文件只有下面 7 个，且全部是追加代码**（FR-023、SC-009）：

| 文件 | 改动 |
|---|---|
| `server/src/auth/better-auth.ts` | 追加一次 `applyOidcAuthOptions(...)` 调用（Keycloak 插件、准入与入公司钩子、会话有效期、账号关联） |
| `server/src/config.ts` | 读取 `PAPERCLIP_AUTH_OIDC_*`、`PAPERCLIP_AUTH_SESSION_TTL_SECONDS` |
| `server/src/routes/health.ts` | 响应中追加公开的 `auth.oidc` |
| `ui/src/api/health.ts` | 健康检查类型追加 `auth` |
| `ui/src/api/auth.ts` | 追加 `signInSocial()` |
| `ui/src/pages/Auth.tsx` | 企业登录按钮、错误提示、应急登录折叠区 |
| `doc/DEPLOYMENT-MODES.md` | 追加 "OIDC single sign-on" 小节 |

其余都是新增文件：`server/src/auth/oidc.ts`、`ui/src/lib/sso-redirect.ts`、新的测试文件、`deploy/aliyun/`、`.github/workflows/deploy-aliyun.yml`、`specs/`。

同步步骤：

```sh
git fetch upstream
git rebase upstream/master          # 冲突只应出现在上表文件中
pnpm install
pnpm test -- server/src/__tests__/auth-oidc.test.ts server/src/__tests__/better-auth-oidc.test.ts \
  server/src/__tests__/health-oidc.test.ts ui/src/pages/Auth.oidc.test.tsx
deploy/aliyun/tests/run.sh
deploy/aliyun/tests/sso-e2e/run-all.sh
git diff upstream/master --stat -- server ui doc   # 被修改的上游文件应仍是上表 7 个
```
