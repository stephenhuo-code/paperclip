---

description: "Task list for 基于 Keycloak 单点登录的数字员工平台（阿里云自动化部署）"
---

# Tasks: 基于 Keycloak 单点登录的数字员工平台（阿里云自动化部署）

**Input**: Design documents from `specs/001-keycloak-sso-aliyun/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: **全程 TDD**（用户要求）。所有代码与脚本任务都遵循 红 → 绿 → 重构：

1. 先写测试任务，运行并**确认失败**（失败原因必须是"功能未实现"，而不是测试本身写错）；
2. 再做对应实现任务，直到测试通过；
3. 测试通过后才能重构，重构后测试仍须通过。

- 服务端、前端：Vitest（`pnpm test -- <文件>`）。
- 部署脚本与 Compose 配置：bats-core + shellcheck + actionlint，统一通过 `deploy/aliyun/tests/run.sh` 在容器中运行，不给仓库新增 npm 依赖。
- 每个实现任务描述末尾的"使 Txxx 通过"即其对应的红灯测试；没有对应测试的实现任务不得开始。
- 无法自动化的部分（真实 Keycloak 登录、阿里云生产验收）以 quickstart 场景作为验收测试。

**Organization**: 按用户故事分组；每个故事可独立实现和验收。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、不依赖未完成任务）
- **[Story]**: 所属用户故事（US1 ~ US5）

## Path Conventions

- 服务端：`server/src/`，测试：`server/src/__tests__/`
- 前端：`ui/src/`
- 部署资产：`deploy/aliyun/`
- CI：`.github/workflows/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 准备开发环境和部署目录骨架

- [X] T001 在仓库根目录运行 `pnpm install`，确认 `feat/keycloak-sso` 分支（已同步 upstream/master）可以通过 `pnpm -r typecheck`，记录基线结果
- [X] T002 [P] 创建部署目录骨架：`deploy/aliyun/{keycloak,scripts,environments}/` 以及空的 `deploy/aliyun/README.md`
- [X] T003 [P] 在 `deploy/aliyun/env.example` 中列出 contracts/deployment.md §1 的全部密钥键名（`BETTER_AUTH_SECRET`、`PAPERCLIP_AGENT_JWT_SECRET`、`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`、`POSTGRES_PASSWORD`、`PAPERCLIP_DB_PASSWORD`、`KEYCLOAK_DB_PASSWORD`、`KC_BOOTSTRAP_ADMIN_PASSWORD`、`PAPERCLIP_AUTH_OIDC_CLIENT_SECRET`、`PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP`），值全部留空，每个键附一行中文说明；文件中不得出现任何 `ANTHROPIC_` 前缀的键

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: OIDC 配置的读取与校验——US1、US3 都依赖它

**⚠️ CRITICAL**: 本阶段完成前不开始 US1、US3

- [X] T004 在 `server/src/__tests__/auth-oidc.test.ts` 中先写配置解析测试（此时应失败）：(a) `PAPERCLIP_AUTH_OIDC_ISSUER`、`PAPERCLIP_AUTH_OIDC_CLIENT_ID`、`PAPERCLIP_AUTH_OIDC_CLIENT_SECRET` 三项全部缺失时 OIDC 关闭；(b) 只配置了其中一部分时抛出明确错误（启动失败，不静默降级）；(c) `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP` "必须是合法 JSON 对象；值必须是 UUID 格式"，否则抛错；(d) 映射为空对象或缺失时 OIDC 仍可启用但准入白名单为空（fail closed）；(e) `PAPERCLIP_AUTH_OIDC_LABEL` 缺省为 `Sign in with SSO`；(f) `PAPERCLIP_AUTH_SESSION_TTL_SECONDS` 未设置时为 `undefined`，设置时解析为正整数
- [X] T005 在 `server/src/config.ts` 的 `Config` 类型（约 `:62-72`）中新增 `authOidc: { issuer, clientId, clientSecret, orgCompanyMap: Record<string,string>, label } | null` 和 `authSessionTtlSeconds?: number`；在 `PAPERCLIP_AUTH_DISABLE_SIGN_UP` 读取处（约 `:223`）附近读取上述环境变量，实现 T004 的校验规则，在返回对象（约 `:296-328`）中输出；解析逻辑放在新文件 `server/src/auth/oidc.ts` 的 `parseOidcConfig(env)` 中供 config.ts 调用，使 T004 通过。错误信息中不得包含 client secret
- [X] T006 在 `server/src/__tests__/auth-oidc.test.ts` 中补一条用例：未配置任何 OIDC 变量时 `parseOidcConfig` 返回 `{ authOidc: null, authSessionTtlSeconds: undefined }`，且 T005 修改后的 `loadConfig()` 其余字段与改动前一致（回归保护）；另断言 (b) 的错误信息中不包含 client secret 的值

**Checkpoint**: `pnpm test -- server/src/__tests__/auth-oidc.test.ts` 通过；OIDC 配置可读取

---

## Phase 3: User Story 1 - 组织成员通过 Keycloak 单点登录进入平台 (Priority: P1) 🎯 MVP

**Goal**: 组织用户点击"使用企业账号登录"，经 Keycloak 认证后自动建号、加入映射的公司；非组织用户被拒绝；退出登录不报错

**Independent Test**: quickstart.md 场景 3 的前两步与"C 被拒绝""退出登录成功"两条预期

### Spike for User Story 1

- [X] T007 [US1] 验证 better-auth 1.7.2 钩子可用字段（research R2、R3 的"待实测"）：在本地起一个 Keycloak 26.x 容器（realm 启用 Organizations，客户端带 `organization` scope），临时在 `server/src/auth/better-auth.ts` 中挂上 `keycloak()` 插件并打印 `user.validateUserInfo` 在 `create-user`、`sign-in`、`link-account` 三种来源下的 `user.id` 是否存在、`source.oauth.profile.organization` 的实际形态；同时检查 better-auth 1.7.2 是否对外开放可让已登录的 OAuth 用户自行设置或重置密码的 HTTP 接口（如 set-password、request-password-reset）；若开放，在 T015 中通过 `disabledPaths` 或等效配置关闭（FR-009）；结论（含截取的声明样例，去掉个人信息）追加到 `specs/001-keycloak-sso-aliyun/research.md` R2/R3 的"实测结果"小节；验证完删除临时打印代码

### Tests for User Story 1 ⚠️

> 先写测试，确认失败，再实现

- [X] T008 [P] [US1] 在 `server/src/__tests__/auth-oidc.test.ts` 中为 `extractOrganizations(profile)` 写测试：兼容列表形态 `["acme"]`、对象形态 `{"acme": {"id": "..."}}`（取键）、缺失或非法时返回空数组
- [X] T009 [P] [US1] 在 `server/src/__tests__/auth-oidc.test.ts` 中为准入校验 `validateOidcUserInfo` 写测试：组织 ∩ 映射键为空 → 返回 `{ error: "org_not_allowed" }`；缺少 email → 返回 `{ error: "email_required" }`；有交集 → 放行；非 OAuth 来源（邮箱密码）→ 一律放行（不影响应急管理员）
- [X] T010 [P] [US1] 在 `server/src/__tests__/auth-oidc.test.ts` 中为 `reconcileOidcMemberships` 写测试（mock `getMembership`、`ensureMembership`、`setPrincipalGrants` 与 `logActivity`）：对每个匹配且尚无成员关系的组织调用 `ensureMembership(companyId, "user", userId, "operator", "active")` 和 `setPrincipalGrants(companyId, "user", userId, grantsForHumanRole("operator"), null)`；"已存在时不修改"——已有成员关系时上述两个调用都不发生；仅在新建成员关系时写一条 `action = "company_membership.sso_joined"`、`actorType = "user"`、`details = { providerId: "keycloak", organization: "<alias>" }` 的活动日志
- [X] T011 [P] [US1] 在**新文件** `server/src/__tests__/health-oidc.test.ts` 中写测试（不修改上游的 `health.test.ts`）：启用 OIDC 时 `GET /api/health` 返回 `auth.oidc = { enabled: true, providerId: "keycloak", label }`，且响应中不包含 issuer、clientId、映射表；未启用时不返回 `auth` 字段
- [X] T012 [P] [US1] 在**新文件** `server/src/__tests__/better-auth-oidc.test.ts` 中写测试（不修改上游的 `better-auth.test.ts`）：`config.authOidc` 存在时 better-auth 配置的 `plugins` 包含 providerId 为 `keycloak` 的 genericOAuth 插件，且该 provider 设置了 `overrideUserInfo: true`（每次登录同步姓名、邮箱，FR-005）、`user.validateUserInfo` 已挂载；`config.authOidc` 为 null 时 `plugins` 与改动前完全一致（托管工作区 handoff 插件的条件注入保持不变）；`loopbackAuth` 与默认实例使用同一份插件配置
- [X] T013 [P] [US1] 在**新文件** `ui/src/pages/Auth.oidc.test.tsx` 中写测试（不修改上游的 `Auth.test.tsx`）：`auth.oidc.enabled` 为 true 时渲染企业登录主按钮并在点击时调用 `authApi.signInSocial`；URL 带 `error=org_not_allowed` 时显示"您的账号未被授权访问此平台，请联系管理员"；带其他 `error` 时显示"企业登录失败，请重试"；`signInSocial` 请求失败时显示"企业登录服务暂时不可用"；`enabled` 为 false 时页面与现状一致

### Implementation for User Story 1

- [X] T014 [US1] 在 `server/src/auth/oidc.ts` 中实现 `extractOrganizations`、`validateOidcUserInfo`、`reconcileOidcMemberships`（复用 `server/src/services/access.ts:871` 的 `ensureMembership` 和 `server/src/services/activity-log.ts:218` 的 `logActivity`），以及 `buildKeycloakPlugin(config.authOidc)`：使用 `better-auth/plugins/generic-oauth` 的 `keycloak({ clientId, clientSecret, issuer, scopes: ["openid","profile","email","organization"] })`；`mapProfileToUser` 中 `name` 取 Keycloak `name`、缺省回退 `preferred_username`，`email`、`emailVerified` 取自 `email`、`email_verified`；provider 设置 `overrideUserInfo: true`，使每次登录都用 Keycloak 最新资料覆盖平台用户的姓名、邮箱（FR-005）；使 T008–T010 及 T012 中 provider 配置相关断言通过
- [X] T015 [US1] 修改 `server/src/auth/better-auth.ts`（约 `:260-306`）：把现有条件 `plugins` 展开改为合并数组 `[...(handoff ? [workspaceLoginHandoffPlugin(...)] : []), ...(config.authOidc ? [buildKeycloakPlugin(config.authOidc)] : [])]`；当 `config.authOidc` 存在时设置 `user.validateUserInfo` 调用 `validateOidcUserInfo`，并按 T007 的实测结论在 `validateUserInfo`（sign-in 来源）和/或 `databaseHooks.user.create.after`（create-user 来源）中调用 `reconcileOidcMemberships`；确认 `loopbackAuth`（约 `:323`）继承同一配置；使 T012 通过
- [X] T016 [US1] 修改 `server/src/routes/health.ts`（公开配置段约 `:283-308`）输出 `auth.oidc`，使 T011 通过
- [X] T017 [P] [US1] 修改 `ui/src/api/health.ts`：响应类型新增 `auth?: { oidc: { enabled: boolean; providerId?: string; label?: string } }`（类型改动，由 T013 的编译与运行覆盖）
- [X] T018 [P] [US1] 修改 `ui/src/api/auth.ts`：新增 `signInSocial({ provider, callbackURL, errorCallbackURL })`，复用 `authPost`（约 `:139`）调用 `POST /api/auth/sign-in/social`，返回 `{ url }`；使 T013 中"点击调用 `authApi.signInSocial`"的用例通过
- [X] T019 [US1] 修改 `ui/src/pages/Auth.tsx`：读取 health 中的 `auth.oidc`，启用时显示以 `label` 为文案的主按钮，点击后 `window.location.href = url`（`callbackURL` 为登录前的目标路径，`errorCallbackURL` 为 `/auth?error=...`）；按 contracts/auth-oidc.md §3 显示三种错误提示，不出现空白页或无限加载；只用 `ui/src/index.css` 中的 token，不写硬编码颜色、px 或 Tailwind 方括号值；使 T013 通过
- [X] T020 [US1] 在本地 authenticated 模式下（`PAPERCLIP_DEPLOYMENT_MODE=authenticated`，连 T007 的 Keycloak 容器）手工验证 quickstart.md 场景 3 中"A、B 自动入公司""C 被拒绝且数据库无 C 的用户记录""退出登录返回成功"三条，并记录一次从点击企业登录到进入平台的耗时（SC-001 ≤30 秒），结果记录到 PR 描述草稿

**Checkpoint**: 组织用户可单点登录并自动进入公司；非组织用户被拒绝

---

## Phase 4: User Story 2 - 组织成员各自使用数字员工 (Priority: P1)

**Goal**: 多名 SSO 用户在同一公司内共享数字员工，操作归属到个人；三家国内模型可用

**Independent Test**: quickstart.md 场景 3 的第 3 步（公开/私有任务可见性）与场景 8（三家模型各完成一个任务）

### Spike for User Story 2

- [ ] T021 [US2] 验证三家模型经 `claude_local` 可用（research R8 "待实测"）：在本地为 DeepSeek、MiniMax、Kimi 各建一个 `claude_local` agent，分别设置 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（`secret_ref`）、自定义模型名、`ANTHROPIC_SMALL_FAST_MODEL`，以及 `DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`；各分派一个需要读写工作区文件的任务；记录准确的端点 URL、模型名、是否必须设置 `ANTHROPIC_SMALL_FAST_MODEL`、工具调用是否正常；不稳定的一家改用 `opencode_local` + `PAPERCLIP_OPENCODE_PROVIDERS` 复测；结论写入 `specs/001-keycloak-sso-aliyun/research.md` R8 的"实测结果"
- [ ] T022 [P] [US2] 验证 bwrap 文件沙箱能否在 Paperclip 容器内使用（research R16 "待实测"）：用仓库 `Dockerfile` 的 production 镜像运行，给一个 `claude_local` agent 开启 `filesystemScope`，确认能运行且无法读取其他 agent 的工作区；记录所需的容器权限（如 `security_opt`、`cap_add`）；结论写入 research.md R16

### Implementation for User Story 2

- [ ] T023 [US2] 在 `deploy/aliyun/README.md` 中新增"配置数字员工"一节：用表格给出三家模型的 adapter、环境变量、模型名（以 T021 实测为准）；写明三条约束——每个 agent 自配地址/密钥/模型名且密钥用公司密钥引用、服务器容器不设任何 `ANTHROPIC_*`、共享的 `/paperclip/.claude/settings.json` 不写 `ANTHROPIC_*` 且服务器上不执行 `claude login`；写明切换模型后需重置 agent 会话；若 T022 结论为可用，补充开启 `filesystemScope` 的方法
- [ ] T024 [US2] 按 quickstart.md 场景 3 第 3 步在本地验证：A 的公开任务 B 可见且创建者显示 A；A 的私有任务 B 在列表中不可见、直接访问返回 404；A、B 的活动记录分别归属本人；结果记录到 PR 描述草稿

**Checkpoint**: 两名 SSO 用户可共享数字员工、私有任务隔离生效；三家模型各有一个可用的数字员工配置

---

## Phase 5: User Story 3 - 平台管理员管理访问与权限 (Priority: P2)

**Goal**: 角色在 Paperclip 中维护且不被登录覆盖；移出组织后无法登录；会话 24 小时；应急管理员可用密码登录

**Independent Test**: quickstart.md 场景 2 与场景 4

### Tests for User Story 3 ⚠️

- [ ] T025 [P] [US3] 在 `server/src/__tests__/auth-oidc.test.ts` 中补测试：已是 `admin` 的成员再次 SSO 登录后角色仍为 `admin`（`ensureMembership` 不改既有角色，FR-006）；组织被移出后的 sign-in 来源校验返回 `org_not_allowed`（FR-008）
- [ ] T026 [P] [US3] 在 `server/src/__tests__/better-auth-oidc.test.ts` 中补测试：设置 `authSessionTtlSeconds = 86400` 时 better-auth 配置的 `session.expiresIn` 为 86400，未设置时不出现该字段（保持上游默认）；启用 OIDC 时 `account.accountLinking.trustedProviders` 为 `["keycloak"]`
- [ ] T027 [P] [US3] 在 `ui/src/pages/Auth.oidc.test.tsx` 中补测试：`auth.oidc.enabled` 为 true 时邮箱密码表单默认折叠在"管理员应急登录"展开区内、注册入口隐藏；展开后仍可用邮箱密码登录

### Implementation for User Story 3

- [ ] T028 [US3] 修改 `server/src/auth/better-auth.ts`：`config.authSessionTtlSeconds` 存在时设置 `session.expiresIn`；`config.authOidc` 存在时设置 `account.accountLinking = { enabled: true, trustedProviders: ["keycloak"] }`，仅在 Keycloak `email_verified=true` 时关联已有本地账号（FR-010）；使 T025、T026 通过
- [ ] T029 [US3] 修改 `ui/src/pages/Auth.tsx`：启用 OIDC 时把现有邮箱密码表单（约 `:123-205`）收进"管理员应急登录"可展开区，隐藏注册入口；未启用时不变；遵守 token 规则；使 T027 通过
- [ ] T030 [US3] 按 quickstart.md 场景 2、场景 4 在本地验证：bootstrap 邀请创建应急管理员 → 打开 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` 后注册入口消失、应急管理员仍能密码登录；B 被设为管理员后重新 SSO 登录仍为管理员；A 被移出 Keycloak 组织后重新登录被拒绝；结果记录到 PR 描述草稿

**Checkpoint**: US1、US2、US3 在本地全部可用，登录相关代码完成

---

## Phase 6: User Story 4 - 运维人员一键自动化部署到阿里云 (Priority: P2)

**Goal**: 从空阿里云账号按文档 2 小时内上线；推送即发布；失败自动回滚；每日备份到 OSS

**Independent Test**: quickstart.md 场景 1（本地全栈）、场景 5、6、7

### Spike for User Story 4

- [ ] T031 [US4] 验证 keycloak-config-cli 与 Keycloak 版本兼容（research R13 "待实测"）：选定 Keycloak 26.x 的固定补丁版本与对应的 `adorsys/keycloak-config-cli:6.5.x-26.x` 镜像，导入一个含 Organizations 的最小 realm，重复导入两次并在中间手工新增一个用户，确认用户未被删除；不兼容时改用 `start --import-realm`；把选定的版本号写入 research.md R13

### Tests for User Story 4 ⚠️

> 先写测试并确认失败，再写脚本和配置

- [ ] T032 [US4] 建立部署测试框架：`deploy/aliyun/tests/run.sh` 在容器中依次运行 shellcheck（`deploy/aliyun/scripts/*.sh`）、actionlint（`.github/workflows/deploy-aliyun.yml`）和 bats（`deploy/aliyun/tests/*.bats`）；`deploy/aliyun/tests/helpers/` 提供假的 `docker`、`curl`、`ossutil`、`pg_dump`、`openssl` 命令（放在 PATH 最前面，记录调用参数、按环境变量返回预设结果），以及临时目录形式的 `/opt/paperclip`；脚本通过 `PAPERCLIP_ROOT`、`DEPLOY_HEALTH_TIMEOUT_SECONDS`、`DEPLOY_HEALTH_INTERVAL_SECONDS` 环境变量允许测试覆盖路径与超时
- [ ] T033 [P] [US4] 在 `deploy/aliyun/tests/deploy.bats` 中写测试：(a) `.env` 含 `ANTHROPIC_` 前缀的键时以 1 退出且不调用 `docker compose up`；(b) 健康检查返回 200、`status=="ok"` 且 `commit` 等于传入 SHA 时，`state/previous` 为旧版本、`state/current` 为新版本，以 0 退出；(c) `commit` 不匹配或超时时回滚到 `state/previous` 的版本并以 2 退出；(d) Keycloak `/health/ready` 不通时同样回滚；(e) 任何情况下标准输出和标准错误都不包含 `.env` 中的任一值
- [ ] T034 [P] [US4] 在 `deploy/aliyun/tests/bootstrap.bats` 中写测试（只测密钥生成函数，安装 Docker 与挂盘步骤用假命令跳过）：生成 `env.example` 中列出的全部键；已存在的键值不被覆盖；文件权限为 600；输出中不出现生成的密钥值
- [ ] T035 [P] [US4] 在 `deploy/aliyun/tests/backup.bats` 中写测试：对 `paperclip`、`keycloak` 两个库各调用一次 `pg_dump -Fc`；上传目标为 `${OSS_BACKUP_BUCKET}/<当天日期>/`；证书剩余有效期小于 7 天时以非 0 退出，大于等于 7 天时以 0 退出
- [ ] T036 [P] [US4] 在 `deploy/aliyun/tests/restore.bats` 中写测试：调用顺序为 停止服务 → 下载 → 恢复两个库与数据卷 → 启动 → 健康检查；下载失败时以非 0 退出且不执行恢复
- [ ] T037 [P] [US4] 在 `deploy/aliyun/tests/compose.bats` 中写测试：用 `env.example`（填入假值）与 `environments/production.env` 执行 `docker compose config` 成功；只有 `caddy` 发布端口（80、443）；`keycloak` 不发布 9000；`paperclip` 服务的环境变量中没有任何 `ANTHROPIC_` 前缀的键，且包含 contracts/deployment.md §5 列出的全部键；`keycloak-config` 的 `restart` 为 `"no"`，`caddy`、`paperclip`、`keycloak`、`postgres` 的 `restart` 为 `unless-stopped`；`env.example` 中不含 `ANTHROPIC_` 前缀的键
- [ ] T038 [US4] 运行 `deploy/aliyun/tests/run.sh`，确认 T033–T037 全部因"脚本或配置不存在"而失败（红灯）

### Implementation for User Story 4

- [ ] T039 [P] [US4] 编写 `deploy/aliyun/keycloak/realm.yaml`（由 T031 的导入验证与 T043 本地全栈冒烟覆盖）（keycloak-config-cli 格式，开启变量替换）：realm `${KEYCLOAK_REALM}`、`organizationsEnabled: true`、组织别名 `${KEYCLOAK_ORG_ALIAS}`、confidential 客户端 `paperclip`（Standard Flow 开启、PKCE S256、Redirect URI `https://${APP_DOMAIN}/api/auth/callback/keycloak`、Web Origin `https://${APP_DOMAIN}`、secret 取 `${PAPERCLIP_AUTH_OIDC_CLIENT_SECRET}`、默认 scope 含 `openid profile email organization`）；realm 级设置 `registrationAllowed: false`、`verifyEmail: true`、`loginWithEmailAllowed: true`、`duplicateEmailsAllowed: false`（防止自助注册冒用邮箱）；不在文件中定义任何用户或管理员角色；Keycloak 补丁版本须包含 CVE-2025-1391 的修复
- [ ] T040 [P] [US4] 编写 `deploy/aliyun/Caddyfile`：`{$APP_DOMAIN}` 反代到 `paperclip:3100`，`{$SSO_DOMAIN}` 反代到 `keycloak:8080`；`{$SSO_DOMAIN}/admin*` 仅允许 `{$ADMIN_ALLOWED_CIDRS}` 访问（FR-027）；ACME 邮箱取 `{$ACME_EMAIL}`；本地测试时可通过 `local_certs` 使用内部证书
- [ ] T041 [US4] 编写 `deploy/aliyun/docker-compose.yml`（依赖 T039、T040）：服务 `caddy`、`paperclip`、`keycloak`、`postgres`、`keycloak-config`，镜像全部取自 `${ACR_REGISTRY_VPC}/${ACR_NAMESPACE}/...`（本地可用 `.env.local` 覆盖）；`postgres` 首次初始化时创建 `paperclip`、`keycloak` 两个库及各自账号（初始化 SQL 放 `deploy/aliyun/postgres/init.sh`）；`paperclip` 环境变量按 contracts/deployment.md §5 设置、挂载 `paperclip-data:/paperclip`、`pids_limit: 2048`、只通过 Caddy 暴露；`keycloak` 设置 `KC_DB`、`KC_HOSTNAME=https://${SSO_DOMAIN}`、`KC_PROXY_HEADERS=xforwarded`、`KC_HTTP_ENABLED=true`、`KC_HEALTH_ENABLED=true`，9000 端口不暴露；`keycloak-config` 为 `restart: "no"` 的一次性任务，其余四个常驻服务均为 `restart: unless-stopped`；若 T022 结论需要，为 `paperclip` 加上 bwrap 所需的容器权限；使 T037 通过
- [ ] T042 [P] [US4] 编写 `deploy/aliyun/environments/production.env`，填入 contracts/deployment.md §1 中全部非敏感参数的占位值（`ENV_NAME`、`ALIYUN_REGION`、`ECS_INSTANCE_ID`、`ACR_REGISTRY`、`ACR_REGISTRY_VPC`、`ACR_NAMESPACE`、`APP_DOMAIN`、`SSO_DOMAIN`、`KEYCLOAK_REALM`、`KEYCLOAK_ORG_ALIAS`、`OSS_BACKUP_BUCKET`、`OSS_ENDPOINT`、`ACME_EMAIL`、`ADMIN_ALLOWED_CIDRS`），不含任何密钥
- [ ] T043 [US4] 本地全栈冒烟（依赖 T041）：按 quickstart.md 场景 1 用 `agents.localhost`、`sso.localhost` 起全栈，确认 `/api/health` 的 `auth.oidc.enabled` 为 true、realm 与客户端已自动创建，并在全栈上重跑场景 3
- [ ] T044 [P] [US4] 编写 `deploy/aliyun/scripts/bootstrap.sh <env>`：安装 Docker 与 Compose 插件并执行 `systemctl enable --now docker`（服务器重启后自动恢复）；挂载并格式化数据盘（已挂载则跳过）；在 `/opt/paperclip/.env` 生成 env.example 中的全部密钥（已存在的键不覆盖，权限 600）；把 `deploy/aliyun/` 放到 `/opt/paperclip/deploy/`；用 VPC 地址 `docker login` ACR；安装每日 03:00 执行 `backup.sh` 的 cron；脚本 `set -euo pipefail`，禁止 `set -x`，不打印任何密钥值；使 T034 通过
- [ ] T045 [P] [US4] 编写 `deploy/aliyun/scripts/deploy.sh <env> <image-tag>`：启动前检查 `/opt/paperclip/.env` 中不含 `ANTHROPIC_` 前缀的键，否则以 1 退出；记录 `state/current` 到 `state/previous`；拉取镜像；运行 `keycloak-config` 一次性任务；`docker compose up -d`；10 分钟内轮询 `https://${APP_DOMAIN}/api/health` 直到 200、`status=="ok"` 且 `commit` 等于本次 SHA，并检查 Keycloak 容器内 `http://localhost:9000/health/ready`；成功写 `state/current` 并以 0 退出；失败回滚到 `state/previous` 并以 2 退出；其他错误以 1 退出；使 T033 通过
- [ ] T046 [P] [US4] 编写 `deploy/aliyun/scripts/backup.sh <env>`：对 `paperclip`、`keycloak` 两个库执行 `pg_dump -Fc`，打包 `/paperclip/instances/default/data/storage` 与 secrets 主密钥目录，经 OSS 内网 endpoint 上传到 `${OSS_BACKUP_BUCKET}/<日期>/`；检查 `APP_DOMAIN`、`SSO_DOMAIN` 证书剩余有效期，小于 7 天时以非 0 退出；README 中说明需配置 OSS 生命周期规则保留 30 天；使 T035 通过
- [ ] T047 [P] [US4] 编写 `deploy/aliyun/scripts/restore.sh <env> <backup-date>`：停止服务 → 从 OSS 下载指定日期备份 → 恢复两个库与数据卷 → 启动 → 健康检查；失败时以非 0 退出并保留现场；使 T036 通过
- [ ] T048 [US4] 编写 `.github/workflows/deploy-aliyun.yml`：触发条件为推送到 `deploy/production` 分支或 `workflow_dispatch`（输入 `env`，默认 `production`）；读取 `deploy/aliyun/environments/<env>.env`；用仓库 `Dockerfile` 构建 `--target production`，只构建 `linux/amd64`，启用 buildx 的 GitHub Actions 缓存（`cache-from: type=gha`、`cache-to: type=gha,mode=max`），并设置 `PAPERCLIP_BUILD_COMMIT=${{ github.sha }}`，推送 `paperclip:${{ github.sha }}` 到 ACR；把 keycloak、postgres、caddy、keycloak-config-cli 基础镜像同步到 ACR（已存在相同 tag 则跳过）；用 `ALIYUN_ACCESS_KEY_ID`/`ALIYUN_ACCESS_KEY_SECRET` 调用云助手 `RunCommand` 执行 `/opt/paperclip/deploy/scripts/deploy.sh <env> <sha>` 并轮询 `DescribeInvocationResults`；命令内容只含环境名与版本号；退出码非 0 时工作流失败；通过 T032 中的 actionlint 检查
- [ ] T049 [US4] 完成 `deploy/aliyun/README.md` 的部署手册：准备阿里云资源（ECS 规格 4 vCPU / 16 GB / 100 GB ESSD 并开启自动快照、ACR 个人版、OSS 桶与生命周期规则、只授权云助手三个动作的 RAM 用户、两个子域名的 DNS 解析、安全组只开 80/443）；GitHub Secrets 清单；执行 `bootstrap.sh`；首次触发工作流；首个管理员与应急管理员流程（bootstrap 邀请 → 创建公司 → 填写 `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP` → 打开 `PAPERCLIP_AUTH_DISABLE_SIGN_UP` → 重启）；在 Keycloak 中创建用户（勾选邮箱已验证并加入组织）；修改 Keycloak 初始管理员口令；备份恢复与每季度演练；已知风险（平台与 Keycloak 同机、退出后再次企业登录可能无需输入密码）；fork 的 GitHub Actions 设置（启用 Actions，并停用与本部署无关的上游工作流，如 `docker.yml`）；Keycloak 升级步骤（修改镜像版本 → 走同一发布流程 → 验证登录，FR-028）；列出 `realm.yaml` 管理的字段（这些字段的手工修改会在下次部署时恢复，FR-025）
- [ ] T050 [US4] 在真实阿里云环境按 quickstart.md 场景 5、6、7 验收：首次部署 2 小时内完成；推送小改动 20 分钟内上线且 `commit` 正确（记录构建与部署各自耗时，SC-006）；发布时保持一个数字员工任务正在运行，确认新版本启动后该任务被恢复或被明确标记为中断；推送一个启动即退出的版本，确认工作流失败、线上保持上一版本且中断不超过 5 分钟；执行备份并在临时 ECS 上恢复成功；结果记录到 PR 描述草稿
- [ ] T051 [US4] 在生产环境按 quickstart.md 场景 8 配置三家模型的数字员工并各完成一个任务（SC-002a）；故意填错一个 Key，确认该任务明确失败、其他两个不受影响

**Checkpoint**: 生产环境上线，发布、回滚、备份全部验证通过

---

## Phase 7: User Story 5 - 与上游 Paperclip 保持可同步 (Priority: P3)

**Goal**: 定制点集中且有文档，合并上游时冲突只出现在这些位置

**Independent Test**: spec.md US5 的验收场景——合并上游后冲突仅限文档列明的定制点，且验证通过

- [ ] T052 [US5] 在 `deploy/aliyun/README.md` 中新增"上游同步"一节：列出 7 个被修改的上游文件（`server/src/auth/better-auth.ts`、`server/src/config.ts`、`server/src/routes/health.ts`、`ui/src/api/health.ts`、`ui/src/api/auth.ts`、`ui/src/pages/Auth.tsx`、`doc/DEPLOYMENT-MODES.md`）及每处改动的目的；同步步骤 `git fetch upstream && git rebase upstream/master`，之后运行 `pnpm test -- server/src/__tests__/auth-oidc.test.ts` 与 quickstart 场景 1、3
- [ ] T053 [US5] 用 `git diff upstream/master --stat` 核对实际被修改的上游文件与 T052 清单完全一致；如有多出的文件，回收到新文件中或补进清单；做一次 `git rebase upstream/master` 演练并记录冲突情况

**Checkpoint**: 定制点清单与实际改动一致

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 文档、规范检查与交付前全量验证

- [ ] T054 [P] 在 `doc/DEPLOYMENT-MODES.md` 中新增 "OIDC single sign-on" 小节（追加，不重写原文）：说明 `PAPERCLIP_AUTH_OIDC_*`、`PAPERCLIP_AUTH_SESSION_TTL_SECONDS` 变量、Keycloak 回调地址 `/api/auth/callback/keycloak`、组织准入与自动入公司的行为、与 `PAPERCLIP_AUTH_DISABLE_SIGN_UP` 配合实现应急登录
- [ ] T055 [P] 确认并在 `deploy/aliyun/docker-compose.yml` 中加入关闭 Paperclip 第一方遥测的环境变量（research R15；只改部署配置，不改 `packages/shared/src/telemetry/` 代码），同时确认 `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false`、`NPM_CONFIG_REGISTRY=https://registry.npmmirror.com` 已设置
- [ ] T056 运行 `pnpm check:token-gates`，修复 `ui/src/pages/Auth.tsx` 中的任何违规
- [ ] T057 运行交付前全量检查 `pnpm -r typecheck`、`pnpm test:run`、`pnpm build`、`deploy/aliyun/tests/run.sh`，全部通过；无法运行的项在 PR 中说明原因
- [ ] T058 按 `.github/PULL_REQUEST_TEMPLATE.md` 填写全部章节（Thinking Path、What Changed、Verification、Risks、Model Used、Checklist），汇总 T020、T024、T030、T050、T051 的验证记录

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**：无依赖
- **Foundational (Phase 2)**：依赖 Phase 1；阻塞 US1、US3
- **US1 (Phase 3)**：依赖 Phase 2
- **US2 (Phase 4)**：T021、T022 可在 Phase 1 后随时开始；T024 依赖 US1 完成
- **US3 (Phase 5)**：依赖 Phase 2；T028 与 T015 改同一文件、T029 与 T019 改同一文件，须在 US1 对应任务之后
- **US4 (Phase 6)**：T031–T042、T044–T049 可在 Phase 1 后与 US1 并行开发；T043 依赖 US1、US3 完成；T050、T051 依赖全部前序故事
- **US5 (Phase 7)**：依赖所有代码改动完成
- **Polish (Phase 8)**：依赖所有故事完成

### User Story Dependencies

```text
Setup ─▶ Foundational ─▶ US1 ─▶ US3 ─┐
   │                      │          ├─▶ US4 验收(T043,T050,T051) ─▶ US5 ─▶ Polish
   │                      └─▶ US2(T024)
   ├─▶ US2 spike (T021, T022)
   └─▶ US4 资产开发 (T031–T042, T044–T049)
```

### Within Each User Story

- spike 先于实现；**测试先写并确认失败（红），再实现（绿），最后重构**
- `oidc.ts`（逻辑）→ `better-auth.ts`（接线）→ health → UI
- 每个故事结束时做一次本地手工验证并记录

### Parallel Opportunities

- Phase 1：T002、T003 并行
- US1：T008–T013 六个测试任务并行（T008–T010 同写 `auth-oidc.test.ts`，如需真正并行可先建好文件骨架）；T017、T018 并行
- US2：T021 与 T022 并行
- US3：T025–T027 并行
- US4：T033–T037 五个测试任务并行；T039、T040、T042、T044–T047 并行；整个 US4 资产开发可与 US1 并行
- Polish：T054、T055 并行

---

## Parallel Example: User Story 1

```bash
# 同时编写 US1 的测试：
Task: "T008 extractOrganizations 测试 in server/src/__tests__/auth-oidc.test.ts"
Task: "T011 health auth.oidc 测试 in server/src/__tests__/health-oidc.test.ts"
Task: "T013 登录页企业登录测试 in ui/src/pages/Auth.oidc.test.tsx"

# 同时修改前端 API 层：
Task: "T017 health 类型 in ui/src/api/health.ts"
Task: "T018 signInSocial in ui/src/api/auth.ts"
```

## Parallel Example: User Story 4

```bash
# 部署资产可与 US1 代码同时开发：
Task: "T039 realm.yaml in deploy/aliyun/keycloak/realm.yaml"
Task: "T040 Caddyfile in deploy/aliyun/Caddyfile"
Task: "T044 bootstrap.sh in deploy/aliyun/scripts/bootstrap.sh"
Task: "T045 deploy.sh in deploy/aliyun/scripts/deploy.sh"
Task: "T046 backup.sh in deploy/aliyun/scripts/backup.sh"
```

---

## Implementation Strategy

### MVP First（US1）

1. 完成 Phase 1、Phase 2
2. 完成 Phase 3（US1）
3. **停下验证**：本地 Keycloak + authenticated 模式下，组织用户能单点登录、非组织用户被拒绝
4. 演示

### Incremental Delivery

1. Setup + Foundational → 配置就绪
2. US1 → 单点登录可用（MVP）
3. US2 → 三家模型的数字员工可用、私有任务验证
4. US3 → 角色保持、会话 24 小时、应急登录
5. US4 → 本地全栈 → 阿里云生产上线
6. US5 → 定制点核对与上游同步演练
7. Polish → 全量检查 → PR

### Parallel Team Strategy

- 开发者 A：Phase 2 → US1 → US3（登录代码）
- 开发者 B：US2 spike → US4 部署资产（脚本、compose、工作流、README）
- 两条线在 T043（本地全栈冒烟）汇合

---

## Notes

- [P] = 不同文件、无未完成依赖
- 所有 spike 的结论都回写到 research.md 对应的"实测结果"小节，后续任务以实测为准
- 不新增数据表、不做迁移；如实施中发现需要，先回到 plan 阶段评估
- 任何脚本和日志中都不得出现密钥值；不得在容器环境或共享 `.claude/settings.json` 中设置 `ANTHROPIC_*`
- TDD：红灯测试与对应实现分开提交（先提交失败的测试，再提交让它通过的实现），便于审查
- 每完成一个任务或一组逻辑相关任务提交一次
