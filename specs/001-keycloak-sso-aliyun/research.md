# Research: Keycloak SSO + 阿里云自动化部署

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-09

所有结论基于当前分支（`feat/keycloak-sso`，better-auth 1.7.2）的代码阅读与外部文档。标注"待实测"的项必须在实施的第一个任务中验证。

---

## R1. 用什么方式把 Keycloak 接进 Paperclip 的登录

- **Decision**: 使用 better-auth 1.7.2 自带的 `genericOAuth` 插件及其内置的 `keycloak({ clientId, clientSecret, issuer })` 助手，在 `server/src/auth/better-auth.ts` 的 `plugins` 数组中按配置条件启用。
- **Rationale**:
  - 版本已锁定为 `better-auth@1.7.2`（`server/package.json:82`），插件随包发布，无需新增依赖。
  - `account` 表已具备 OAuth 所需字段（`issuer`、`accountId`、`providerId`、`idToken`、`refreshToken` 等，`packages/db/src/schema/auth.ts:37-60`），**无需数据库迁移**。
  - 1.7 起 genericOAuth 的 provider 注册为一等 social provider：登录走 `POST /api/auth/sign-in/social {provider:"keycloak"}`，回调为 `/api/auth/callback/keycloak`（旧文档里的 `/sign-in/oauth2`、`/oauth2/callback/:id` 已不适用）。
  - 现有 `plugins` 只在托管工作区时条件注入（`better-auth.ts:287-305`），改成合并数组即可；`loopbackAuth`（`:323`）展开 `authConfig`，会自动继承。
- **Alternatives considered**:
  - 反向代理（oauth2-proxy）做门禁：用户要登录两次，不是真正的单点登录。
  - 借用 Cloud trusted-header 路径（`server/src/middleware/auth.ts:572`）：为 Paperclip Cloud 设计，依赖 stack/tenant 语义，强行复用风险高。
  - 手写 OIDC 客户端：重复造轮子，与上游差异大。

## R2. 如何只允许指定组织的用户登录（FR-002、FR-004a、FR-008）

- **Decision**: Keycloak 端启用 Organizations，平台客户端默认带 `organization` client scope；Paperclip 端在 better-auth 的 `user.validateUserInfo` 中检查 `source.oauth.profile.organization` 是否包含映射表里的组织别名，不包含则返回错误拒绝。
- **Rationale**:
  - `validateUserInfo` 在 **create-user、link-account 和每一次 OAuth sign-in** 时都会执行，并拿到最新的 ID token 声明，所以"移出组织后下次登录被拒"（FR-008）天然成立。
  - Keycloak 26 起 Organizations 正式可用；`organization` scope 的声明默认是组织别名列表（如 `["acme"]`）——**待实测**确认具体形态，代码需同时兼容"列表"和"以别名为 key 的对象"两种格式。
- **Alternatives considered**:
  - Groups + Group Membership mapper：可行，但语义上"组织"更贴近需求，且 Keycloak 原生支持多组织扩展。保留为降级方案。
  - `databaseHooks.user.create.before`：只在首次创建时执行，无法覆盖后续登录。

## R3. 首次登录自动加入工作空间（FR-003、FR-004）

- **Decision**: 新增配置 `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP`（JSON，形如 `{"acme":"<companyId>"}`）。用户每次 OIDC 登录成功后，对其组织对应的每个公司调用现有的 `access.ensureMembership(companyId, "user", userId, "member", "active")`（`server/src/services/access.ts:871`），并写一条活动日志。
- **Rationale**:
  - 仓库里**没有**自动入公司的机制，新用户只能走邀请（`server/src/routes/access.ts:3320-3643`）；`ensureMembership` 是邀请流程内部使用的幂等函数，直接复用。
  - "幂等 + 只增不改"：已存在的成员关系和角色保持不变，满足 FR-006"不覆盖 Paperclip 中已设置的角色"。
  - 映射的键集合同时作为准入白名单，一处配置同时满足 FR-002 和 FR-004a。
- **Hook 位置（待实测）**: 优先在 `validateUserInfo` 内（sign-in 时 `user.id` 可用）；create-user 时 `user.id` 尚未生成，则用 `databaseHooks.user.create.after` 补一次（组织列表通过 `mapProfileToUser` 暂存到请求上下文）。实施首个任务用一个最小测试确认两种来源下拿得到的字段。
- **Alternatives considered**: 映射存数据库并提供管理界面——属于"加戏"，与"尽量少改动"冲突；首期一条映射、写在环境配置里即可。

### R2/R3 实测结果（T007，2026-10-09，读 better-auth 1.7.2 源码）

- **原始声明在哪里**：OAuth 回调里，`validateUserInfo` 收到的 `source.oauth.profile` 是 `providerResult.data`；genericOAuth 有 ID token 时就用**解码后的 ID token 声明**，没有才去请求 userinfo 端点（`plugins/generic-oauth/index.mjs:37-47,215-225`）。因此 Keycloak 的 Organization Membership mapper 必须勾选"Add to ID token"（默认就是勾选的），realm.yaml 里要显式写明。
- **各来源下 `user.id` 是否可用**：
  - `sign-in`（已有用户再次登录）：✅ 有 `user.id`（`oauth2/link-account.mjs:137-147`）
  - `link-account`（按已验证邮箱关联已有本地账号）：✅ 有 `user.id`（`:92-102`）
  - `create-user`（首次建号）：❌ 只有待写入的 `data`，还没有 id（`db/internal-adapter.mjs:149-167`）
- **自动入公司的落点（定稿）**：sign-in、link-account 来源在 `validateUserInfo` 内直接执行；create-user 来源先在进程内按小写邮箱暂存组织列表，由 `databaseHooks.user.create.after` 取出并执行，执行后清除暂存（单实例部署，进程内暂存足够）。
- **准入失败的效果**：`validateUserInfo` 返回 `{ error }` 时，better-auth 抛出 403；浏览器流程重定向到错误地址并带 `error=<code>`（`utils/validate-user-info.mjs`、`api/routes/callback.mjs:154-171`）。回调抛出的异常同样按 403 拒绝（fail closed）。
- **每次登录同步资料**：genericOAuth 的 `overrideUserInfo: true` 会被映射成 `overrideUserInfoOnSignIn`（`index.mjs:260`），`keycloak()` 助手会透传这个选项（`providers/keycloak.mjs:46`）。
- **`ensureMembership` 会改写既有角色**：已存在的成员关系角色或状态不同时，它会**直接更新**（`server/src/services/access.ts:871-890`）。因此自动入公司必须先 `getMembership`，已存在就跳过，否则会把管理员降级（违反 FR-006）。
- **默认角色与权限**：Paperclip 人类成员的角色是 `owner | admin | operator | viewer`，`"member"` 会被归一化为 `operator`；邀请的默认角色是 `operator`（`server/src/services/company-member-roles.ts:11-19,79-88`）。邀请流程在加成员后还会调用 `setPrincipalGrants` 写入 `grantsForHumanRole(role)` 默认权限（`server/src/routes/access.ts:3127-3160`）。SSO 自动入公司**照搬这一行为**：角色 `operator` + `grantsForHumanRole("operator")`，与"接受一个默认邀请"完全一致。
- **R2 风险核查（OAuth 用户能否自设密码）**：`/set-password` 是 `createAuthEndpoint.serverOnly`，不对外开放（`api/routes/update-user.mjs:196`）；`/request-password-reset` 要求配置 `emailAndPassword.sendResetPassword`，Paperclip 没有配置（`server/src` 中无此配置）。因此**通过 Keycloak 建立的账号无法自行设置密码**，FR-009 无需额外代码。
- **真实 Keycloak 验证（T020，Keycloak 26.8.0）**：ID token 中的声明为**列表形态** `"organization": ["acme"]`，`email_verified` 正确传递。另外两点实测发现：
  - 启用 Organizations 的 realm 默认使用**两步登录**（先输用户名，再输密码）。
  - 内置的 `organization` scope 是客户端的**可选** scope；Paperclip 登录时会显式申请它，所以 realm.yaml 不需要把它设为默认 scope。

## R4. 角色、首个管理员和应急登录（FR-006、FR-009、FR-022）

- **Decision**:
  - 角色完全沿用 Paperclip 现有的成员管理；登录流程只调用 `ensureMembership`（默认 `member`），不读取 Keycloak 角色。
  - 首个管理员：公网模式下浏览器认领被关闭，使用现有 CLI `paperclipai auth bootstrap-ceo` 生成一次性邀请链接（`cli/src/commands/auth-bootstrap-ceo.ts:54`）。
  - 应急登录：首次部署时先用邮箱+密码注册一个**应急管理员**并接受 bootstrap 邀请，然后打开 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`。之后普通用户只能通过 Keycloak 登录（他们没有密码），应急管理员仍可用密码登录。
- **Rationale**: `PAPERCLIP_AUTH_DISABLE_SIGN_UP` 只影响邮箱密码注册（`better-auth.ts:273-277`），不影响 OAuth 自动建号，正好满足"密码登录仅限管理员"，**零代码**。
- **Alternatives considered**: 把 `emailAndPassword.enabled` 做成可配置并彻底关闭——会失去应急通道，与 FR-009 冲突。

## R5. 登录页和退出登录（FR-001、FR-007）

- **Decision**:
  - `/api/health` 响应新增 `auth.oidc: { enabled, providerId, label }`（仅公开非敏感信息），`ui/src/pages/Auth.tsx` 据此显示"使用企业账号登录"主按钮；启用 OIDC 时密码表单折叠到"管理员应急登录"下。
  - 按钮调用 `POST /api/auth/sign-in/social {provider:"keycloak", callbackURL}`，然后跳转到返回的 `url`（复用 `ui/src/api/auth.ts:139` 的 `authPost`）。
  - 退出登录沿用 better-auth 的 `/api/auth/sign-out`（authenticated 模式下可用，之前的 404 只发生在 `local_trusted`）。**不做**单点登出跳转（Out of Scope），因此退出后再点企业登录可能无需再次输入密码——属预期行为，写入文档。
- **Rationale**: UI 目前不知道启用了哪些登录方式（`health.ts:283-308` 是现成的公开配置出口）；改动集中在一个页面和一个 API 字段。
- **Alternatives considered**: 新增独立的 `/api/auth/providers` 路由——多一个端点，没有必要。

## R6. 会话有效期（SC-004）

- **Decision**: better-auth 默认会话 7 天，与 SC-004（停用后 ≤24 小时失效）冲突。新增 `PAPERCLIP_AUTH_SESSION_TTL_SECONDS`（默认不设置时保持上游默认），部署配置中设为 `86400`。
- **Rationale**: 一个可选配置项，不改变上游默认行为。

## R7. 账号关联（FR-010）

- **Decision**: 配置 `account.accountLinking.trustedProviders: ["keycloak"]`，仅当 Keycloak 返回 `email_verified=true` 时允许与已有本地账号关联；Keycloak 中由管理员创建的用户统一勾选"邮箱已验证"。
- **Rationale**: 避免应急管理员与其 Keycloak 账号成为两个人；better-auth 原生支持。

## R8. 数字员工使用的模型（FR-011a）

- **Decision**: 不新增 adapter，三家模型统一用 `claude_local`（Claude Code CLI）指向各自的 Anthropic 兼容接口；Kimi 也可选用原生的 `kimi_local`。

  | 模型 | Adapter | 关键配置（agent 的 env，密钥用 `secret_ref`） |
  |---|---|---|
  | DeepSeek | `claude_local` | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，`ANTHROPIC_AUTH_TOKEN`，model 如 `deepseek-chat` |
  | MiniMax | `claude_local` | `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`，`ANTHROPIC_AUTH_TOKEN`，model 如 `MiniMax-M2` |
  | Kimi | `claude_local` 或 `kimi_local` | `ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic`；或 `kimi_local` + `KIMI_MODEL_NAME`/`KIMI_MODEL_API_KEY` |

- **Rationale**:
  - 零代码、零派生镜像：Claude Code、Kimi Code、OpenCode 的 CLI 在镜像构建时已安装（`Dockerfile:175`），运行时不需要联网安装。
  - 三家都官方提供面向 Claude Code 的 Anthropic 兼容接口，是三家共同覆盖的路径，三个 agent 的配置方式完全一致。
  - agent 的 `env` 支持任意键和 `secret_ref`（`packages/shared/src/validators/agent.ts:52-63`），模型密钥由 Paperclip 公司密钥统一管理。

### R8.1 为什么不选 Hermes 或 Codex

| | `claude_local` | `hermes_local` | `codex_local` |
|---|---|---|---|
| 镜像内是否已安装 | ✅（`Dockerfile:175`） | ❌ 需 `pip install hermes-agent`，要做派生镜像 | ✅ |
| 三家接口匹配 | 三家都有 Anthropic 兼容接口 | MiniMax、Kimi 有内置 provider；DeepSeek 无，只能 `auto` + 自定义地址 | 三家主要提供 Chat Completions；Codex CLI 新版本以 Responses 协议为主，协议可能不匹配 |
| 配置由谁管 | 每个 agent 3 个环境变量，Paperclip 管理 | 地址和密钥在 Hermes 自己的 `~/.hermes/config.yaml`，Paperclip 管不到 | 支持自定义 provider（`PAPERCLIP_CODEX_PROVIDERS`，`packages/adapters/codex-local/src/server/runtime-config.ts:54-70`），但为服务器全局配置 |
| 主要风险 | 第三方 Anthropic 兼容程度参差（工具调用、思考模式）；CLI 可能访问 Anthropic 遥测 | 多一套 Python 运行时与分散配置 | 若 CLI 不再支持 `wire_api = "chat"`，需加协议转换网关 |

- **备选顺序**：某家 Anthropic 兼容接口实测不稳时，改用 `opencode_local` + `PAPERCLIP_OPENCODE_PROVIDERS`（OpenAI 兼容 Chat Completions，三家原生支持，CLI 已在镜像中）；只有实测确认 Codex CLI 能直连三家接口时才考虑 `codex_local`。

### R8.2 模型名的指定方式

- `claude_local` 的模型名不限于 Claude 自家模型。取值顺序：agent 配置的 `model` → agent env 中的 `ANTHROPIC_MODEL` → 默认 `claude-opus-5`（`packages/adapters/claude-local/src/index.ts:4-22`）。
- 配置了模型即以 `--model <模型名>` 原样传给 CLI，不做校验（仅 Bedrock 认证例外，`server/execute.ts:846-868`）。
- 界面的模型下拉框提供"Enter custom model…"，可手填第三方模型名（`ui/src/components/AgentConfigForm.tsx:3902`）。
- 非 Claude 模型的思考强度选项为 low/medium/high，第三方接口不一定支持，首期不设置。
- 同时设置 `ANTHROPIC_SMALL_FAST_MODEL` 为同一家的模型名，避免 Claude Code 的辅助调用请求不存在的 Claude 模型。

### R8.3 三个 agent 的环境变量是否冲突

- **不冲突**：每次运行启动独立子进程，环境变量 = 服务器进程 env + agent 自己的 env，同名以 agent 为准（`packages/adapters/claude-local/src/server/execute.ts:315,493`）。三个 agent 同时运行时互不可见。
- **约束 1：服务器容器不设任何 `ANTHROPIC_*` 变量**。否则它会成为所有 agent 的默认值，漏配的 agent 会静默调错模型、扣错账户；不设则漏配会直接报错。
- **约束 2：共享的 Claude 配置目录不放 `ANTHROPIC_*`**。未开文件沙箱时，所有 `claude_local` agent 共用 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`，即 `/paperclip/.claude`，`claude-config.ts:123-128`）。其中 `settings.json` 的 `env` 字段对所有 agent 生效，不得写入 `ANTHROPIC_*`；服务器上不执行 `claude login`，避免残留 Anthropic 登录凭据。
- **会话续接**：把某个 agent 从一家模型切换到另一家后，旧会话可能续接失败，需在界面上重置该 agent 的会话。

- **待实测**:
  - 三家 Anthropic 兼容端点的准确 URL 与模型名。
  - Claude Code CLI 在大陆 ECS 上不因访问 Anthropic 的遥测、更新而卡住——统一设置 `DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。
  - 是否必须设置 `ANTHROPIC_SMALL_FAST_MODEL`。
  - 三家对 Claude Code 工具调用的兼容程度（用一个读写文件的任务验证）。

## R9. 部署形态与镜像来源（FR-014 ~ FR-020a）

- **Decision**: 单台 ECS（建议 4 vCPU / 16 GB / 100 GB ESSD，开启自动快照），Docker Compose 运行：
  - `caddy`（反向代理 + 自动 HTTPS）
  - `paperclip`（仓库现有 `Dockerfile`，`--target production`）
  - `keycloak`（`quay.io/keycloak/keycloak:26.x`，固定补丁版本）
  - `postgres`（`postgres:17-alpine`，两个库：`paperclip`、`keycloak`，各自独立账号）
  - `keycloak-config`（`adorsys/keycloak-config-cli`，一次性任务）
- **镜像来源**: 在 GitHub Actions（境外 runner）构建 Paperclip 镜像，并把所有基础镜像（keycloak、postgres、caddy、config-cli）同步到阿里云 ACR 个人版；ECS 通过同地域 VPC 地址 `registry-vpc.cn-<region>.aliyuncs.com` 拉取。
- **Rationale**: 大陆访问 Docker Hub、quay.io、ghcr.io 均不稳定；在境外构建避开 npm、apt、Rust 工具链（`Dockerfile:54-123`）的镜像源问题。
- **Alternatives considered**: 在 ECS 本地构建（需配置 npm/apt/crates 三套镜像源，构建慢且易失败）；云效流水线（可行，但与上游现有 `.github/workflows/docker.yml` 不一致）。

## R10. 发布、健康检查与回滚（FR-015、FR-016、SC-006、SC-007）

- **Decision**:
  - GitHub Actions 工作流 `deploy-aliyun.yml`：推送到 `deploy/production` 分支或手动触发 → 构建并推送 `paperclip:<sha>` 到 ACR → 通过**阿里云云助手** `RunCommand` 在 ECS 上执行 `deploy.sh <sha>` → 轮询执行结果。
  - `deploy.sh`：记录当前版本 → 拉取新镜像 → `docker compose up -d` → 轮询 `GET /api/health` 直到 `status=="ok"` 且 `commit==<sha>`（`server/src/routes/health.ts:233,310-333`）；超时则切回上一版本并以非零码退出，工作流失败即通知（GitHub 失败通知邮件）。
  - 数据库迁移在 Paperclip 启动时自动执行（`server/src/index.ts:268-324`，无 TTY 时自动应用），无需单独步骤。
- **Rationale**: 云助手走阿里云 API，不需要对公网开放 SSH，比境外 runner 直连 SSH 稳定。
- **Alternatives considered**: `appleboy/ssh-action`（跨境 SSH 易断）；蓝绿部署（单机首期不做，SC-007 允许 5 分钟内中断）。

## R11. 密钥管理（FR-018、FR-027）

- **Decision**:
  - 服务端密钥（`BETTER_AUTH_SECRET`、`PAPERCLIP_AGENT_JWT_SECRET`、`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`、数据库口令、Keycloak 管理员口令、OIDC client secret）由 `bootstrap.sh` 在 ECS 上首次生成，写入 `/opt/paperclip/.env`（权限 600），**不经过 CI、不进仓库、不打印日志**。
  - CI 只持有两类凭据（GitHub Secrets）：ACR 推送凭据、仅限 `ecs:RunCommand`/`DescribeInvocationResults` 的 RAM AccessKey。
  - 模型 API Key 由管理员在 Paperclip 界面中以公司密钥（`secret_ref`）保存，不属于部署配置。
- **Rationale**: 简单、可审计；云助手命令内容只含版本号，不含密钥。
- **Alternatives considered**: 阿里云 KMS 凭据管家——更规范，但首期单机规模下增加复杂度，列为后续改进。

## R12. HTTPS 证书（FR-014）

- **Decision**: Caddy 自动 HTTPS（Let's Encrypt，HTTP-01）。域名已 ICP 备案、80/443 开放即可工作；证书到期前 7 天未续期则由宿主机定时执行的 `backup.sh` 附带检查并报警（写日志 + 失败退出码，由云监控采集）。
- **Alternatives considered**: DNS-01（需自编译 Caddy + alidns 插件，作为 HTTP-01 不稳定时的备选）；阿里云免费证书（3 个月手工续期，不选）。

## R13. Keycloak 初始配置的幂等性（FR-025）

- **Decision**: 使用 `keycloak-config-cli` 一次性任务导入 `deploy/aliyun/keycloak/realm.yaml`（realm、启用 Organizations、组织、平台客户端、redirect URI），开启 `IMPORT_VARSUBSTITUTION_ENABLED=true`，并设置 `import.managed.*=no-delete`，保证重复执行不删除管理员手工创建的用户和配置。
- **Rationale**: v6.5.0 起支持 Organizations 导入。
- **待实测**: config-cli 6.5.x 与所选 Keycloak 26.x 补丁版本的兼容性；若不兼容，降级为 Keycloak 自带的 `start --import-realm`（只在 realm 不存在时导入）。

## R14. 备份与恢复（FR-019、FR-019a、FR-026）

- **Decision**: 宿主机 cron 每天 03:00 执行 `backup.sh`（通过 `docker compose exec postgres` 调用 `pg_dump -Fc`，不单独起备份容器），备份两个库 + 打包 Paperclip 数据卷中的 `instances/default/data/storage`（附件）和 secrets master key，上传到 OSS（内网 endpoint），OSS 生命周期规则保留 30 天；ECS 云盘每日自动快照；`restore.sh` 提供恢复步骤，每季度演练一次。
- **Rationale**: Paperclip 的附件、密钥主密钥都在数据卷（`/paperclip/instances/default/`），只备份数据库不足以恢复。

## R15. 大陆网络下的运行时外联

- **Decision**: 部署配置中设置：
  - `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false`（默认访问 `pages.paperclip.ing`，`server/src/config.ts:367-368`）
  - `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com`（插件安装在运行时执行 `npm install`，`server/src/services/plugin-loader.ts:1241-1259`）
  - 关闭 Paperclip 第一方遥测（具体变量名实施时确认；按 AGENTS.md，仅改配置不改遥测代码，无需隐私评审）
- **Rationale**: 避免启动或运行时因境外服务超时导致卡顿。

## R16. agent 运行隔离

- **Decision**: 首期三类数字员工都作为 **Paperclip 服务容器内的子进程**运行，不为每个 agent 单独起容器。

  ```text
  ECS
  └── paperclip 容器
      ├── Paperclip 服务进程（Node）
      ├── claude 子进程 ← DeepSeek 员工运行时启动，任务结束退出
      ├── claude 子进程 ← MiniMax 员工
      └── claude 子进程 ← Kimi 员工
  ```

  | 层面 | 默认隔离情况 |
  |---|---|
  | 进程与环境变量 | ✅ 每次运行独立子进程（见 R8.3） |
  | 工作目录 | ✅ 每个 agent 独立工作区 `/paperclip/workspaces/<agentId>`（`server/src/home-paths.ts:55`） |
  | 文件系统 | ⚠️ 不隔离：子进程可读写整个容器，包括其他 agent 的工作区与 `/paperclip` 数据目录 |
  | CPU、内存 | ⚠️ 共用容器资源（compose 设置 `pids_limit: 2048`） |
  | 网络 | ⚠️ 不限制 |

- **Rationale**:
  - 数字员工均由组织自己配置，属可信 agent，没有运行外部不可信代码的场景。
  - 公司、任务层面的权限隔离（私有任务、公司边界）由 Paperclip 控制面负责，与 agent 运行位置无关。
  - 改动最少、资源利用率最高，符合单台 ECS 的部署形态。
  - 已知残留风险：agent 可能把处理私有任务时获得的内容写入共享位置（`doc/ISSUE-PRIVACY.md` 中的 trusted-agent 风险），首期接受。

- **配套措施**:
  - ECS 规格按同时运行的员工数估算：每个 Claude Code 进程约占几百 MB 到 1 GB 内存，4 vCPU / 16 GB 可支撑同时运行数个。
  - **待实测**：`claude_local` 自带的轻量沙箱——`filesystemScope` / `networkScope` 使用 bubblewrap（`bwrap`）把子进程的文件访问限制在自身工作区、网络按白名单放行（`packages/adapters/claude-local/src/server/execute.ts:574-600`）。bwrap 在 Docker 内通常需要额外权限（允许用户命名空间等）；若可用，给处理敏感内容的员工开启 `filesystemScope`。

- **Alternatives considered**:
  - **SSH 执行目标**：让 agent 在另一台 ECS 上运行，隔离最彻底，但多一台机器的成本与运维，首期不选。
  - **沙箱插件（每次运行一个独立容器）**：Paperclip 已有 kubernetes、daytona、e2b、modal、cloudflare 等插件（`packages/plugins/sandbox-providers/`），配套镜像见 `docker/agent-runtime/`（如 `agent-runtime-claude`）。但没有"本机 Docker"插件；kubernetes 需要 ACK 集群，其余多为海外服务。留待迁移到 ACK 时采用 kubernetes 插件。

