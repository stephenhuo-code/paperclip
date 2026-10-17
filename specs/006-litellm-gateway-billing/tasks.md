# Tasks: 模型网关统一接入与按运行计费

**Input**: [spec.md](./spec.md)、[plan.md](./plan.md)、验证记录 [REPORT.md](../../deploy/aliyun/experiments/litellm-verify/REPORT.md)

**TDD**：每组先写测试并确认失败，再实现。只跑相关测试，不跑全量。不改 Paperclip 代码（`server/`、`ui/`、`packages/`）。

## Phase 1: Setup

- [X] T001 运行基线 `deploy/aliyun/tests/run.sh`，记录结果（shellcheck + 部署测试应全部通过）
- [X] T002 验证 R2：在实验环境 `deploy/aliyun/experiments/litellm-verify/` 以 `STORE_MODEL_IN_DB=True` 启动 LiteLLM，用管理界面（`/ui`，主密钥登录）添加一个指向假上游 `capture` 的模型并填四个单价；调用一次，花费与单价一致；在界面改输出单价后再调用一次，新单价生效。结论写入 `REPORT.md`；不通过则停下来与用户确认方案
- [X] T003 验证 R5：在实验环境加载 `forward_user_agent.py` 钩子（并增加"未设单价拒绝"逻辑的草稿），用假上游确认 ①上游收到的 User-Agent 等于调用方的 `claude-cli/…`；②未设单价的模型返回 400 且不发往上游。结论写入 `REPORT.md`；不通过则停下来与用户确认

## Phase 2: Foundational（网关服务进入部署）

**目的**：litellm 服务、数据库、域名、密钥进入 `deploy/aliyun`，后续所有用户故事依赖它。

### 测试（先写，确认失败）

- [X] T004 [P] `deploy/aliyun/tests/compose.test.mjs`：用 `tests/fixtures/production.env` 渲染 compose，断言存在 `litellm` 服务（镜像来自 ACR 的 `litellm:<LITELLM_VERSION>`，挂载 `litellm/config.yaml`、`litellm/hooks.py`，环境含 `LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY`、`DATABASE_URL` 指向 `postgres/litellm`、`STORE_MODEL_IN_DB=True`，无对外端口）；caddy 在默认网络上有别名 `${LLM_DOMAIN}`
- [X] T005 [P] `deploy/aliyun/tests/compose.test.mjs`：Caddyfile 中 `{$LLM_DOMAIN}` 站点整站限制为 `{$ADMIN_ALLOWED_CIDRS}` 和 `private_ranges`，其余 403，反代 `litellm:4000`（`caddy validate` 通过）
- [X] T006 [P] 部署沙箱测试（另加真实 PostgreSQL 测试 `tests/postgres-roles-test.sh`，角色脚本为 `postgres/ensure-roles.sh`）（`deploy/aliyun/tests/deploy.test.mjs` 或现有对应文件 + `tests/helpers/sandbox.mjs` 假 `docker`/`psql`）：`deploy.sh` 在启动应用前幂等执行建库 SQL——`litellm` 角色与库、`paperclip_readonly` 只读角色（已存在时不报错、不改密码）；`.env` 缺少 `LITELLM_DB_PASSWORD` 等时报错退出
- [X] T007 [P] 健康检查测试：`lib.sh` 的 `wait_healthy` 在 litellm 未就绪时不通过、就绪后通过（沙箱假 `docker compose exec litellm …`）

### 实现

- [X] T008 新建 `deploy/aliyun/litellm/config.yaml`：`general_settings.master_key`、`database_url` 取环境变量；`litellm_settings.callbacks: hooks.proxy_handler_instance`；不在文件中定义模型
- [X] T009 `deploy/aliyun/docker-compose.yml`：新增 `litellm` 服务（同 T004）；caddy 网络别名 `${LLM_DOMAIN}`
- [X] T010 `deploy/aliyun/Caddyfile`：新增 `{$LLM_DOMAIN}` 站点（同 T005）
- [X] T011 `deploy/aliyun/scripts/deploy.sh`：启动前执行幂等建库 / 建角色（同 T006）；`deploy/aliyun/postgres/init.sh` 全新部署时同样创建
- [X] T012 `deploy/aliyun/scripts/lib.sh`：`litellm_ready`（`/health/liveliness`）加入 `wait_healthy`
- [X] T013 `deploy/aliyun/env.example`：`LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY`、`LITELLM_DB_PASSWORD`、`PAPERCLIP_READONLY_DB_PASSWORD`、`PAPERCLIP_SYNC_EMAIL`、`PAPERCLIP_SYNC_PASSWORD`（注明来源和"盐不可更改"）；`deploy/aliyun/environments/production.env` 与 `tests/fixtures/production.env`：`LLM_DOMAIN`、`LITELLM_VERSION`、`PAPERCLIP_GATEWAY_CONNECTION_NAME`
- [X] T014 （实现：新服务器由 `bootstrap.sh` 按 `env.example` 生成；已有服务器由 `deploy.sh` 在发布时补齐，见 `deploy.test.mjs`）缺少时生成 `LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY`、两个数据库密码写入 `.env`，已有则不动；对应测试先写
- [X] T015 `.github/workflows/deploy-aliyun.yml`：镜像同步加入 `ghcr.io/berriai/litellm:<LITELLM_VERSION>`（单平台、无 attestation，同现有 mirror）
- [X] T016 运行 T004–T007 及相关测试，全部通过

## Phase 3: User Story 1 - 所有模型经网关统一接入 (P1) 🎯 MVP

**独立验证**：本地部署后，在网关界面接入 DeepSeek，Paperclip 中建网关连接（Base URL `https://<LLM_DOMAIN>`），agent 选网关后任务完成；网关停止时运行失败并给出原因。

- [X] T017 [US1] `compose.test.mjs`：paperclip 服务能解析 `LLM_DOMAIN` 到 caddy（别名断言已在 T004），并且 paperclip 不持有任何上游 Key 变量（断言环境中无 `DEEPSEEK_*`、`KIMI_*`、`MINIMAX_*`）
- [X] T018 [US1] 本地 `~/paperclip-local` 部署（构建 gateway 相关部署资产，按记忆中的本地部署命令），在 Paperclip 容器内 `curl https://<LLM_DOMAIN>/health/liveliness` 返回 200 且证书校验通过；结果记入 `specs/006-litellm-gateway-billing/verification.md`

## Phase 4: User Story 2 - 在网关界面设置模型与单价 (P1)

**独立验证**：管理员网段内打开 `https://<LLM_DOMAIN>/ui` 登录，添加模型和单价；网段外 403；未设单价的模型被拒绝调用。

### 测试（先写，确认失败）

- [X] T019 [US2] 新建 `deploy/aliyun/tests/litellm-hooks-test.sh`（真实 LiteLLM 容器 + 假上游，方式同 `keycloak-provision-test.sh`）：①经接口添加一个有四个单价的模型，调用一次，花费等于按单价计算值；②添加一个没有单价的模型，调用返回 400，假上游未收到请求；③修改单价后新调用按新单价
- [X] T020 [P] [US2] `compose.test.mjs`：网段外访问 `LLM_DOMAIN` 的任意路径返回 403 的 Caddy 规则（T005 覆盖整站规则，此处补 `/ui` 路径用例）

### 实现

- [X] T021 [US2] 新建 `deploy/aliyun/litellm/hooks.py`：`async_pre_call_hook` 中查当前模型部署的单价，缺少输入或输出单价时抛出 400"模型未设单价：<模型>"
- [X] T022 [US2] 运行 `litellm-hooks-test.sh`、`compose.test.mjs`，通过

## Phase 5: User Story 3 - 花费按运行写回 Paperclip 并执行预算 (P1)

**独立验证**：两个 agent 同时在同一项目执行任务，几分钟内 Paperclip 费用页按项目显示网关金额；项目超预算后被暂停；重复写回不重复计费。

### 测试（先写，确认失败）

- [X] T023 [P] [US3] 新建 `deploy/aliyun/tests/gateway-sync.test.mjs`，针对 `gateway-sync/lib.mjs` 纯函数：花费行（带 `paperclip-run:`、`paperclip-task:` 标签）+ 运行信息 → 费用记录（agent、运行、任务、项目、模型、输入 = 提示 − 缓存命中、缓存命中、输出、金额美分精确到 7 位、`billingType=metered_api`、`costStatus=estimated`、`provider=biller=litellm`、幂等键 `litellm:<请求号>`、`occurredAt`）
- [X] T024 [P] [US3] 同文件：无运行标签、运行不存在的行归入"未归属"，不产生费用记录；每小时汇总一次金额和条数
- [X] T025 [P] [US3] 同文件：主循环用假 LiteLLM 库查询和假 Paperclip 接口——扫描窗口为最近 2 小时；Paperclip 返回"已存在"（幂等）时计为重复而非错误；Paperclip 会话失效（401）时重新登录一次再重试；Paperclip 不可用时本轮跳过、下轮继续

### 实现

- [X] T026 [US3] 新建 `deploy/aliyun/gateway-sync/lib.mjs`（T023、T024 的纯逻辑）
- [X] T027 [US3] 新建 `deploy/aliyun/gateway-sync/sync.mjs`：每 30 秒一轮；只读查询 litellm 库 `LiteLLM_SpendLogs` 和 Paperclip 库 `heartbeat_runs`/`issues`（`paperclip_readonly`）；用 `PAPERCLIP_SYNC_EMAIL/PASSWORD` 登录后 `POST /api/companies/:id/cost-events`；结构化日志（写回条数、重复、未归属、错误）
- [X] T028 [US3] 新建 `deploy/aliyun/gateway-sync/Dockerfile`（`node:24-alpine` + `postgresql-client`，非 root 运行）；`docker-compose.yml` 新增 `gateway-sync` 服务；`compose.test.mjs` 增加对应断言（先写）；`.github/workflows/deploy-aliyun.yml` 构建并推送该镜像
- [X] T029 [US3] `lib.sh`：健康检查加入 gateway-sync（容器运行且最近一轮成功的时间戳文件不超过 2 分钟）；测试先写
- [X] T030 [US3] 运行 `gateway-sync.test.mjs`、`compose.test.mjs` 及健康检查测试，通过

## Phase 6: User Story 4 - 上游看到真实调用方 (P2)

- [X] T031 [US4] `litellm-hooks-test.sh` 增加用例（先写）：带 `User-Agent: claude-cli/x.y.z` 调用，假上游收到的 User-Agent 完全相同；不带 User-Agent 时不编造（保持 LiteLLM 默认）
- [X] T032 [US4] `deploy/aliyun/litellm/hooks.py`：把请求元数据中的调用方 User-Agent 写入上游请求头；运行 T031 通过

## Phase 7: User Story 5 - agent 自动接入网关 (P2)

### 测试（先写，确认失败）

- [X] T033 [P] [US5] `gateway-sync.test.mjs`：补齐判断——`adapterType=claude_local` 且 `runtimeConfig.aiConnection.connectionId` 为网关连接（按 `PAPERCLIP_GATEWAY_CONNECTION_NAME` 找到）且 `adapterConfig.agentCommand` 为空 → 补齐；`agentCommand` 已填写、连接不是网关、或不是 `claude_local` → 不改并列入"不经网关"；补齐时只设置 `agentCommand`，保留 `adapterConfig` 其他字段
- [X] T034 [P] [US5] `compose.test.mjs`：paperclip 服务以只读方式挂载 `litellm/claude-agent-acp-tagged.sh` 到 `/usr/local/bin/claude-agent-acp-tagged`

### 实现

- [X] T035 [US5] 新建 `deploy/aliyun/litellm/claude-agent-acp-tagged.sh`（实验版定稿，shellcheck 通过）；`docker-compose.yml` 挂载（同 T034）
- [X] T036 [US5] `gateway-sync/lib.mjs`、`sync.mjs`：每轮先补齐再写回；网关连接不存在时只记日志、不补齐；"不经网关"清单每小时记一次日志
- [X] T037 [US5] 运行 T033、T034，通过

## Phase 8: Polish

- [X] T038 [P] `deploy/aliyun/scripts/backup.sh`、`restore.sh`：备份 / 恢复加入 `litellm` 库；对应测试先写（现有备份测试文件）
- [X] T039 [P] `deploy/aliyun/docs/manual.md`：新章节"模型网关"——登录网关界面、添加模型和单价（会员 / 套餐填等价单价）、在 Paperclip 中建网关连接（名称须为 `PAPERCLIP_GATEWAY_CONNECTION_NAME`）、agent 选网关、查看"不经网关"和"未归属"、上游 Key 只在网关录入
- [X] T040 [P] `deploy/aliyun/README.md`：架构、服务表、密钥表、域名与 DNS、首次部署步骤加入网关；`deploy/aliyun/docs/architecture.svg` 加入 litellm 与 gateway-sync
- [X] T041 运行 `deploy/aliyun/tests/run.sh`、`litellm-hooks-test.sh`、`keycloak-provision-test.sh`，全部通过
- [X] T042 本地 `~/paperclip-local` 全流程验证（plan"测试与验证"第 4 步），包括：两个 agent 同时运行时花费 100% 归到项目、项目超预算被暂停、重复写回不重复、自定义启动命令的 agent 不被修改、网关停止时运行失败并给出原因；结果写入 `specs/006-litellm-gateway-billing/verification.md`
- [X] T043 提交（实验目录 `deploy/aliyun/experiments/litellm-verify/` 一并提交为验证记录，不含 Key）；由用户推送发布

## 依赖与并行

- T002、T003（关键验证）通过后才进入 Phase 2。
- Phase 2 是所有用户故事的前提。
- US1（T017–T018）→ US2（T019–T022）→ US3（T023–T030）；US4、US5 依赖 Phase 2，可在 US3 之后并行。
- 标 [P] 的任务改不同文件，可并行；同一测试文件内的用例依次写。

## 实施策略

先完成 Phase 2 + US1 + US2 + US3（MVP：模型经网关、界面定价、按项目执行预算），再做 US4（标识转发）和 US5（自动补齐），最后文档与本地全流程验证。
