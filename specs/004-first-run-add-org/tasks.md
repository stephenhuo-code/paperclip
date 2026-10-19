# Tasks: 引导脚本新增组织

**Input**: [spec.md](./spec.md)、[plan.md](./plan.md)（2026-10-19 修订）

**TDD**：每组先写测试并确认失败，再实现。只跑相关测试，不跑全量。不改 Paperclip 代码。

## Phase 1: Setup

- [X] T001 运行基线 `deploy/aliyun/tests/run.sh` 并记录结果（应全部通过）

## Phase 2: Foundational（测试沙箱）

- [X] T002 扩展 `deploy/aliyun/tests/helpers/sandbox.mjs` 的假 `kcadm.sh`：`get organizations` 输出 `FAKE_KC_ORGS`（换行分隔的 `id,alias`，默认 `org-1,acme`）加上本次已创建的组织；`create organizations` 记录名称、别名、域名、启用到 `$FAKE_STATE/kc-orgs` 并输出新 id；`FAKE_KC_ORG_DOMAIN_TAKEN=1` 时以非 0 退出并输出域名冲突信息
- [X] T003 扩展假 `curl`：`POST …/api/auth/sign-in/email` 读取请求体（写入 `$FAKE_STATE/curl-body-*`，不进调用记录），`FAKE_SIGNIN_FAIL=1` 时返回 401，否则 200 并写会话 cookie；`POST …/api/companies` 记录公司名并返回 `{"id":"company-new-<n>"}`（`FAKE_COMPANY_CREATE_FAIL=1` 时 500，沿用现有）

## Phase 3: User Story 1 - 新增一个组织及其公司 (P1) 🎯 MVP

**独立验证**：已完成首次初始化的实例上运行 `first-run.sh production --add-org`，输入组织名称、别名、域名、公司名称并确认后：Keycloak 新建组织；用 `.env` 写回账号登录、不提示密码；新建公司；映射表追加一条且原条目不变；重新部署；结束说明包含新公司建网关连接的步骤和网关地址。

### 测试（先写，确认失败）

- [X] T004 [US1] `deploy/aliyun/tests/first-run.test.mjs` 新增 describe "--add-org"：`.env` 含 `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={"acme":"c-1"}` 和写回账号，输入 `Beta Inc`、`beta`、`beta.example.cn`、`Beta` 和 `y`：调用 `kcadm.sh create organizations` 带 `name=Beta Inc`、`alias=beta`、`enabled=true`、域名 `beta.example.cn`；`sign-in/email` 的请求体为写回账号（不在输出和调用记录中）；`POST /api/companies` 名称 `Beta`；`.env` 映射为 `{"acme":"c-1","beta":"company-new-1"}`、权限 600、其他行不变；调用 `remote-deploy.sh production <current>`；输出包含 `Connectors`、`Messages API` 和 `PAPERCLIP_GATEWAY_URL` 的值；退出码 0
- [X] T005 [US1] 同文件：确认时回答 `n` → 无任何创建、登录、`.env` 修改、重新部署；退出码 0
- [X] T006 [US1] 同文件：别名不合法（如 `Beta_1`、空）→ 提示后重新输入；别名与映射中**其他**公司已用的别名相同时提示"将替换"并在确认汇总中显示
- [X] T007 [US1] 同文件：`.env` 无写回账号 → 提示输入应急密码（邮箱取自数据库中的实例管理员）后登录；`FAKE_SIGNIN_FAIL=1` 时提示重输，3 次后退出 1，且无建组织以外的改动；密码不出现在输出和调用记录
- [X] T008 [US1] 同文件：写回账号登录失败（`FAKE_SIGNIN_FAIL=1` 仅对写回账号生效）→ 改为提示输入应急密码继续
- [X] T009 [US1] 同文件：前置检查——Keycloak 未就绪、Paperclip 不健康、没有实例管理员、首个组织尚未映射、映射内容无法解析（如 `{"acme":}`）→ 退出 1、提示原因、无改动

### 实现

- [X] T010 [US1] `deploy/aliyun/scripts/first-run.sh`：参数解析 `first-run.sh <env> [--add-org]`（其他参数报用法）；抽出映射读写函数 `map_get`、`map_set`（按 `"key":"value"` 解析，别名 `^[a-z0-9-]+$`、值 UUID 或现有测试值；无法解析时 `die` 且不写文件），`set_secret` 写回
- [X] T011 [US1] `first-run.sh` 的 `--add-org` 流程：前置检查 → 输入（组织名称、别名校验、域名、公司名称）→ 汇总确认 → 建组织（`kc create organizations -r <realm> -s name=… -s alias=… -s enabled=true -s 'domains=[{"name":"…"}]'`，失败时说明原因退出）→ 登录（写回账号优先，失败或缺失时提示应急密码，最多 3 次）→ 建公司 → `map_set` 合并 → `remote-deploy.sh` → 结束说明（员工入组织、提升负责人、新公司建网关连接 + `PAPERCLIP_GATEWAY_URL`）
- [X] T012 [US1] 运行 `node --test deploy/aliyun/tests/first-run.test.mjs`，T004–T009 通过，003 原有用例保持通过

## Phase 4: User Story 2 - 重复执行与已有数据 (P2)

### 测试（先写，确认失败）

- [X] T013 [US2] `first-run.test.mjs`：Keycloak 已有别名 `beta`（`FAKE_KC_ORGS` 含 `org-2,beta`）→ 不调用 `create organizations`，直接使用
- [X] T014 [US2] 同文件：已有同名公司 `Beta`（`FAKE_PC_COMPANIES` 含 `c-2|Beta`）→ 列出并让运维人员选择"使用已有"（映射指向 `c-2`，不调用 `POST /api/companies`）或"新建"
- [X] T015 [US2] 同文件：映射中 `beta` 已指向所选公司 → 输出"已完成"，不重新部署，退出码 0
- [X] T016 [US2] 同文件：建公司失败（`FAKE_COMPANY_CREATE_FAIL=1`）→ 退出 1，已建的 Keycloak 组织保留；再次运行时识别已有组织，只建公司并完成后续
- [X] T017 [US2] 同文件：Keycloak 报域名冲突（`FAKE_KC_ORG_DOMAIN_TAKEN=1`）→ 退出 1，提示域名已被其他组织使用，无其他改动

### 实现

- [X] T018 [US2] `first-run.sh` 各步"已完成"检查：组织按别名查；公司按名称查并选择；映射已一致时跳过重新部署
- [X] T019 [US2] 运行 `first-run.test.mjs`，全部通过

## Phase 5: User Story 3 - 首次初始化不再覆盖其他组织 (P2)

### 测试（先写，确认失败）

- [X] T020 [US3] `first-run.test.mjs`：`.env` 映射为 `{"acme":"c-1","beta":"c-2"}` 时不带参数运行首次初始化 → 只增改 `acme`，`beta` 保留；`acme` 已指向所选公司且注册已关闭时输出"Nothing to do"
- [X] T021 [US3] 同文件：003 的"全部已完成"用例在映射含多个组织时仍判定为已完成

### 实现

- [X] T022 [US3] `first-run.sh` 首次初始化第 5 步改用 `map_set`；"是否已完成"改为 `map_get acme` 等于所选公司且注册已关闭
- [X] T023 [US3] 运行 `first-run.test.mjs`，全部通过

## Phase 6: Polish

- [X] T024 [P] `deploy/aliyun/tests/keycloak-provision-test.sh`：真实 Keycloak 上用脚本相同的参数再建一个组织（名称、别名、域名）成功；用已被占用的域名再建一个失败（先写检查，确认失败后再调整脚本参数）
- [X] T025 [P] `deploy/aliyun/docs/manual.md`：新增 1.4"新增组织"——运行 `first-run.sh production --add-org`、各输入项、之后三件事（Keycloak 加员工、Paperclip 提升负责人、新公司建模型网关连接，链到 2.3）
- [X] T026 [P] `deploy/aliyun/README.md`："首个管理员与组织映射"补一句新增组织的命令
- [X] T027 运行 `deploy/aliyun/tests/run.sh` 与 `keycloak-provision-test.sh`，全部通过
- [X] T028 本地 `~/paperclip-local` 实际运行 `first-run.sh local --add-org`（plan"测试与验证"第 4 步），记录到 `specs/004-first-run-add-org/verification.md`
- [X] T029 更新 `spec.md` 状态，提交；由用户推送并在生产按手册 1.4 运行

## 实施记录（2026-10-19）

- 输入顺序改为**先问别名**：Keycloak 已有该别名的组织时不再询问名称和域名（US2）。别名等于首个组织的别名时拒绝并提示用首次初始化修改。
- 登录（写回账号 / 应急密码）放在确认之后、**任何改动之前**：应急密码 3 次错误时完全不改动（spec 边界情况"不做改动"），比 T007 原写的"无建组织以外的改动"更严。
- 结束说明的网关步骤与手册 2.3 一致：`Connectors → Browse → Messages API → Connect, Provider URL <PAPERCLIP_GATEWAY_URL>`。
- 假 `curl` 用 `FAKE_SIGNIN_PASSWORD`（只接受该密码）模拟"写回账号失败、应急密码正确"；新建公司 id 为 `company-new-<n>`，003 用例相应改为 `company-new-1`。
- 真实 Keycloak 26.8.0 的域名冲突报错为 `Domain <d> is already linked to organization <name> in realm <realm>`，脚本据此提示。

## 依赖与并行

- T002–T003 是所有测试的前提。
- US1（T004–T012）→ US2（T013–T019）→ US3（T020–T023）：都改同一个脚本和测试文件，依次进行。
- T024–T026 可并行，在 US3 之后。

## 实施策略

先完成 US1（新增组织全流程），再加 US2（重复执行与已有数据）和 US3（首次初始化保留其他映射），最后真实 Keycloak 回归、文档和本地实测。
