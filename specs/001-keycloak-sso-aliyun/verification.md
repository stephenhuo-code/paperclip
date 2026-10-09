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
