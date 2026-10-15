# Tasks: 首次部署初始化引导

**Input**: [spec.md](./spec.md)、[plan.md](./plan.md)、[research.md](./research.md)、[contracts/first-run.md](./contracts/first-run.md)、[quickstart.md](./quickstart.md)

**TDD**：每组先写测试并确认失败，再实现。只跑相关测试，不跑全量。不改 Paperclip 代码。

## Phase 1: Setup

- [X] T001 运行基线 `deploy/aliyun/tests/run.sh` 并记录结果（shellcheck + 部署测试应全部通过）

## Phase 2: Foundational（测试沙箱）

- [X] T002 扩展 `deploy/aliyun/tests/helpers/sandbox.mjs`：`run(script, args, env, input)` 支持把 `input` 作为标准输入传给脚本（`spawnSync` 的 `input`）；沙箱创建假的 `$PAPERCLIP_ROOT/bin/remote-deploy.sh`（只把参数写入 `$FAKE_LOG`，退出码取 `FAKE_REDEPLOY_EXIT`，默认 0）和 `$PAPERCLIP_ROOT/state/current`（固定 40 位版本号）
- [X] T003 扩展 `deploy/aliyun/tests/helpers/sandbox.mjs` 的假 `docker`，按 `FAKE_*` 变量回应：`exec -T keycloak /opt/keycloak/bin/kcadm.sh config credentials`（成功）、`get users -r master -q username=<名>`（`FAKE_KC_MASTER_ADMIN` 存在时输出其 id）、`get users -r <realm> -q email=<邮箱>`（`FAKE_KC_REALM_USER`）、`get organizations`（输出 `org-1,<alias>`）、`create users`（输出新 id）、`update users/<id>/reset-password -f -`（读走标准输入，内容写入 `$FAKE_STATE/kc-password-<id>` 供断言，不进调用记录）、`add-roles`、`create organizations/<id>/members`；`exec -T postgres psql`：`instance_user_roles` 查询按 `FAKE_PC_ADMIN_EMAIL`（`email|name`）返回，`companies` 查询按 `FAKE_PC_COMPANIES`（换行分隔的 `id|name`）返回。所有调用照常写入 `$FAKE_LOG`
- [X] T004 扩展假 `curl`：`/api/health` 返回 `FAKE_HEALTH`（默认 `{"status":"ok"}`）；`POST .../api/auth/sign-up/email`（`FAKE_SIGNUP_EMAIL_TAKEN=1` 时返回 422 与 `USER_ALREADY_EXISTS`）、`POST .../api/invites/<token>/accept` 返回 200 并在 `--cookie-jar` 文件写入会话；`POST .../api/companies` 读取请求体（`--data @-`），返回 `{"id":"company-new","name":<名>}` 状态 201（`FAKE_COMPANY_CREATE_FAIL=1` 时返回 500）；请求体写入 `$FAKE_STATE/curl-body-<n>`，不进调用记录。假 `docker` 对 `bootstrap-invite` 用到的 `compose exec ... paperclip` 输出 `Invite URL: https://agents.example.cn/invite/pcp_bootstrap_test`

## Phase 3: User Story 1 - 一次完成首次初始化 (P1) 🎯 MVP

**独立验证**：全新实例（无管理员、无公司、Keycloak 无管理员）运行脚本并输入全部信息后，五步都执行，`.env` 已关联且关闭注册，调用了重新部署；任何输出和调用记录里都没有密码。

### 测试（先写，确认失败）

- [X] T005 [US1] 新建 `deploy/aliyun/tests/first-run.test.mjs`，用例"全新实例走完五步"：输入 Keycloak 管理员 `ops-admin`/密码、公司名 `FiveGuys`、管理员 `Ops Lead`/`ops@example.cn`/应急密码/企业账号密码、确认 `y`；断言：master realm 创建 `ops-admin` 并 `add-roles ... --rolename admin`；注册、接受邀请、`POST /api/companies` 依次调用且请求带 `Origin: https://agents.example.cn` 和 `--resolve agents.example.cn:443:127.0.0.1`；realm 创建用户名和邮箱都为 `ops@example.cn` 的用户（`emailVerified=true`）并加入组织 `org-1`；`.env` 中 `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={"acme":"company-new"}`、`PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`，其他行不变、权限 600；调用了 `remote-deploy.sh <env> <current>`；退出码 0
- [X] T006 [US1] 同文件用例"密码不留痕"：脚本 stdout/stderr 和 `$FAKE_LOG` 均不含三个密码；密码只出现在 `$FAKE_STATE/kc-password-*` 和 `curl-body-*` 中
- [X] T007 [US1] 同文件用例"两个密码相同被拒"：企业账号密码与应急密码相同时提示并要求重新输入，第二次输入不同密码后继续
- [X] T008 [US1] 同文件用例"确认时回答 n"：退出码 0，`$FAKE_LOG` 中没有任何创建、注册、修改 `.env` 或重新部署的调用
- [X] T009 [US1] 同文件用例"前置检查失败"：`FAKE_KEYCLOAK_READY=0` 或 `FAKE_HEALTH` 非 ok 时退出码 1、提示原因、没有任何改动
- [X] T009a [US1] 同文件用例"管理员邮箱已被占用"：`FAKE_SIGNUP_EMAIL_TAKEN=1` 时提示换邮箱，重新输入另一个邮箱后继续（测试中第二次注册不再返回占用）

### 实现

- [X] T010 [US1] 新建 `deploy/aliyun/scripts/first-run.sh`（`set -euo pipefail`，`source lib.sh`，`load_environment "$1"`，从 `$ENV_FILE` 读 `KEYCLOAK_REALM`、`KEYCLOAK_ORG_ALIAS`）：前置检查（`keycloak_ready`；`curl --resolve` 访问 `/api/health`）；输入函数 `ask`、`ask_secret`（`read -rs`，两次一致、长度至少 12）；`kc()` 封装 `compose exec -T keycloak /opt/keycloak/bin/kcadm.sh`，先用 `provisioner` 和 `.env` 中 `KC_BOOTSTRAP_ADMIN_PASSWORD` 执行 `config credentials`；`kc_set_password <realm> <id>` 通过 `update users/<id>/reset-password -f -` 从标准输入传入 JSON；`pg()` 封装 `compose exec -T postgres psql -U postgres -d paperclip -tA -c`；`api()` 封装 `curl -sS --resolve "$APP_DOMAIN:443:127.0.0.1" -H "Origin: https://$APP_DOMAIN" --cookie-jar/--cookie <临时文件> --data @-`，临时文件 `mktemp` 且 `trap` 删除
- [X] T011 [US1] `first-run.sh` 收集输入 → 汇总并 `确认执行？[y/N]` → 依次执行五步（research R2–R6）：master realm 建管理员并赋 `admin`；注册 → 调用 `"$(dirname "$0")/bootstrap-invite.sh" "$ENV_NAME"` 取邀请 token → 接受邀请（注册返回邮箱已存在时提示换邮箱并重新注册）；`POST /api/companies` 取公司 id；realm 建用户（用户名和邮箱都用管理员邮箱）、设密码、加入组织（`get organizations` 中 alias 匹配的 id）；用 `env_value` 读现值，按行替换 `.env` 两个键（保持 600），再执行 `/opt/paperclip/bin/remote-deploy.sh "$ENV_NAME" "$(cat "$STATE_DIR/current")"`（路径用 `$PAPERCLIP_ROOT/bin/`）；最后打印 Paperclip 与 Keycloak 管理台地址和"员工请在 Keycloak 中添加并加入组织 <alias>"
- [X] T012 [US1] 运行 `node --test deploy/aliyun/tests/first-run.test.mjs`，T005–T009a 通过

## Phase 4: User Story 2 - 重复执行与已有数据 (P2)

**独立验证**：已有管理员和公司时只做剩余步骤；全部完成时只报告已完成、不重新部署。

### 测试（先写，确认失败）

- [X] T013 [US2] `first-run.test.mjs` 用例"已有管理员和一家公司"（`FAKE_PC_ADMIN_EMAIL=ops@example.cn|Ops Lead`、`FAKE_PC_COMPANIES=c-1|FiveGuys`）：不调用注册、邀请和建公司；第 4 步使用该邮箱；映射指向 `c-1`
- [X] T014 [US2] 用例"多家公司"：列出编号，输入 `2` 后映射指向第二家
- [X] T015 [US2] 用例"Keycloak 管理员和企业账号已存在"：不创建、不调用 `reset-password`；企业账号确保在组织中
- [X] T016 [US2] 用例"全部已完成"（`.env` 已是目标值）：输出已完成，不调用 `remote-deploy.sh`，退出码 0
- [X] T017 [US2] 用例"邮箱注册已关闭且没有管理员"：退出码 1，提示需先把 `PAPERCLIP_AUTH_DISABLE_SIGN_UP` 改回 `false` 并重新部署，不做改动
- [X] T017a [US2] 用例"中途失败后继续"：第一次运行 `FAKE_COMPANY_CREATE_FAIL=1`，退出码 1 且已建好的 Keycloak 管理员和 Paperclip 管理员保留；第二次运行（模拟管理员已存在、无公司）跳过这两步，只建公司并完成后续步骤

### 实现

- [X] T018 [US2] `first-run.sh` 各步加"已完成"检查（research R5）：master realm 按用户名查；`select u.email, u.name from instance_user_roles r join "user" u on u.id=r.user_id where r.role='instance_admin' limit 1`；`select id, name from companies order by created_at`，多家时编号选择；realm 按邮箱查并确保组织成员；`.env` 两键已为目标值时跳过重新部署；注册已关闭且无管理员时报错退出
- [X] T019 [US2] 运行 `node --test deploy/aliyun/tests/first-run.test.mjs`，全部通过

## Phase 5: Polish

- [X] T020 [P] `deploy/aliyun/README.md`："首个管理员与组织映射"改为运行 `first-run.sh production`，原手动步骤移到"备用：手动初始化"；"在 Keycloak 中管理用户"的首次登录改为用脚本创建的管理员
- [X] T021 [P] `deploy/aliyun/env.example`：`PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP`、`PAPERCLIP_AUTH_DISABLE_SIGN_UP` 的注释改为"由 first-run.sh 设置"
- [X] T022 运行 `deploy/aliyun/tests/run.sh`（shellcheck + 全部部署测试）通过
- [X] T022a 在 `deploy/aliyun/tests/keycloak-provision-test.sh` 中加真实 Keycloak 检查：用 `kcadm.sh update users/<id>/reset-password -f -` 从标准输入设置密码后，可用新密码登录（research R2 已手工验证一次，此处固化为回归测试）
- [X] T023 按 [quickstart](./quickstart.md) 在本地全新实例实际运行一次（先备份 `~/paperclip-local` 数据卷，结束后恢复），记录结果到 `specs/003-first-run-setup/verification.md`

## 依赖与并行

- T002–T004 是所有测试的前提。
- US1（T005–T012）→ US2（T013–T019）：US2 在同一个脚本里加检查，依赖 US1 的结构。
- T005–T009a、T013–T017a 同一文件，依次写；T020、T021 可并行。
- T023 在发布前；生产上运行在你推送发布之后。

## 实施策略

先完成 US1（MVP：全新实例一次初始化），再加 US2（重复执行与已有数据，当前生产需要），最后文档和本地实测。
