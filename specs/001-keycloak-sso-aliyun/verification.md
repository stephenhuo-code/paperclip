# 验证记录

供 PR 描述（T058）汇总使用。

## T020 本地真实 Keycloak 端到端（2026-10-09）

- 环境：Keycloak 26.8.0（`start-dev`）、PostgreSQL 17、Paperclip `feat/keycloak-sso` @ 39ab1a554，authenticated / private 模式，独立实例目录。
- 脚本：`deploy/aliyun/tests/sso-e2e/`（无浏览器，Node 脚本模拟完整的 OIDC 浏览器流程）。
- 结果：setup 阶段 4/4，verify 阶段 **17/17** 通过（在清空 A、B 平台数据后的干净运行）。

| 检查 | 需求 | 结果 |
|---|---|---|
| 应急管理员用邮箱密码注册、认领实例、创建公司 | FR-009、FR-022 | ✅ |
| 未配置组织映射时所有 SSO 登录被拒绝，且不建用户 | FR-002（fail closed） | ✅ |
| A、B 单点登录成功 | FR-001、FR-003 | ✅ |
| 登录耗时 138–281 ms | SC-001（≤30 秒） | ✅ |
| A、B 以 `operator`/`active` 加入映射公司，写入 14 条默认权限 | FR-004 | ✅ |
| A 通过 API 能看到公司 | FR-011 | ✅ |
| 每个新成员一条 `company_membership.sso_joined` 活动日志 | AGENTS.md §5.3 | ✅ |
| 组织外的 C 被拒绝（`error=org_not_allowed`），无平台账号 | FR-002、SC-003 | ✅ |
| B 在 Paperclip 中被设为 admin，再次登录仍为 admin，不重复写日志 | FR-006 | ✅ |
| Keycloak 中修改姓名，下次登录同步 | FR-005 | ✅ |
| 退出登录返回 200，会话失效 | FR-007 | ✅ |
| A 被移出组织后再次登录被拒绝 | FR-008 | ✅ |
| 应急管理员仍可用密码登录 | FR-009 | ✅ |

实测发现：脚本在短时间内多次登录会触发 better-auth 的登录频率限制（429），测试环境用 `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false` 关闭，生产环境保持开启。

## T030 US3 验收（2026-10-09，同一套脚本扩展后从零完整运行）

- 命令：`deploy/aliyun/tests/sso-e2e/run-all.sh`（自动创建并清理容器）。
- 结果：phase 1 **6/6**、phase 2 **22/22**、phase 3 **3/3**，共 **31/31** 通过。

新增检查：

| 检查 | 需求 | 结果 |
|---|---|---|
| 会话有效期 86400 秒 | SC-004 | ✅ |
| Keycloak 中与应急管理员同邮箱且已验证的账号，登录后就是应急管理员本人（同一个 user id，未新建账号） | FR-010 | ✅ |
| Keycloak 邮箱未验证时不关联已有本地账号（`error=account_not_linked`），本地账号上没有 Keycloak 关联 | FR-010 | ✅ |
| 打开 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` 后邮箱注册返回 400 | FR-009 | ✅ |
| 关闭注册后，新的组织成员仍可通过 SSO 建号进入 | FR-003 | ✅ |
| 关闭注册后，应急管理员仍可密码登录 | FR-009 | ✅ |

US3 的单元测试（会话有效期、账号关联配置、应急登录折叠）见 `server/src/__tests__/better-auth-oidc.test.ts`、`ui/src/pages/Auth.oidc.test.tsx`。

## T024 共享数字员工与私有任务（2026-10-09，`run-all.sh` phase 2 新增 7 项，全套 38/38 通过）

| 检查 | 需求 | 结果 |
|---|---|---|
| A 在共享公司中创建公开任务与私有任务 | FR-011 | ✅ |
| 任务的 `createdByUserId` 为 A | FR-012 | ✅ |
| B 在列表中能看到 A 的公开任务 | US2 场景 1 | ✅ |
| B 在列表中看不到 A 的私有任务 | US2 场景 3 | ✅ |
| B 直接访问 A 的私有任务返回 404 | US2 场景 3 | ✅ |
| A 能打开自己的私有任务 | US2 场景 3 | ✅ |
| 活动日志 `issue.created` 的 actor 为 A | FR-012、US2 场景 2 | ✅ |
