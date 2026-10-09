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

## T053 上游同步核对（2026-10-09）

- `git diff --diff-filter=M` 对比与 `upstream/master` 的分叉点：被修改的上游文件**恰好是** `deploy/aliyun/README.md`"上游同步"表中的 7 个，**全部为纯追加（删除行数均为 0）**：

  | 文件 | 新增 | 删除 |
  |---|---|---|
  | `doc/DEPLOYMENT-MODES.md` | 38 | 0 |
  | `server/src/auth/better-auth.ts` | 7 | 0 |
  | `server/src/config.ts` | 6 | 0 |
  | `server/src/routes/health.ts` | 4 | 0 |
  | `ui/src/api/auth.ts` | 7 | 0 |
  | `ui/src/api/health.ts` | 4 | 0 |
  | `ui/src/pages/Auth.tsx` | 68 | 0 |

- 演练时 `upstream/master` 没有新提交（落后 0 个），`git rebase upstream/master` 无事可做。由于上游文件只有追加，未来冲突只可能出现在这 7 个文件中上游恰好改动的相同位置，属 SC-009 允许范围。

## T043 本地全栈冒烟（2026-10-09）

- 命令：`deploy/aliyun/tests/stack-smoke/stack-smoke.sh 0cb6bca2ac19ca262fd29a6a15e8a424d6b60def`
- 镜像：用仓库 `Dockerfile`（`--target production`，`PAPERCLIP_BUILD_COMMIT` 为同一提交）本地构建，9.25 GB。
- 环境：真实的 `deploy/aliyun/docker-compose.yml`、`deploy.sh`、`bootstrap.sh`、`bootstrap-invite.sh`、`keycloak/provision.sh`；Caddy 使用内部证书；域名 `agents.127.0.0.1.nip.io`、`sso.127.0.0.1.nip.io`；exposure 为 `public`（与生产相同）。
- 结果：**45/45 通过**。

| 阶段 | 检查 | 结果 |
|---|---|---|
| 首次部署 | `deploy.sh` 成功（健康检查比对 commit、Keycloak 就绪） | ✅ |
| 边缘 | Paperclip 走 HTTPS 且 `auth.oidc.enabled`；Keycloak 发现文档公开；管理后台在 `ADMIN_ALLOWED_CIDRS` 之外返回 403；9000 端口未发布 | ✅ 4/4 |
| 首个管理员 | `bootstrap-invite.sh` 输出一次性邀请链接；应急管理员注册并接受邀请（202）；创建公司；无映射时 fail closed | ✅ 7/7 |
| 重新部署 | 填入组织映射后同版本重新发布成功 | ✅ |
| 端到端 | 与 `sso-e2e` 相同的 29 项（单点登录、入公司与权限、私有任务隔离、角色保持、资料同步、退出、移出组织、24 小时会话、账号关联等） | ✅ 29/29 |
| 回滚 | 部署不存在的镜像：退出码 2、版本记录不变、上一版本继续服务 | ✅ 3/3 |

实测中发现并修正的问题：

1. **CLI 在生产容器里不可用**：容器只用环境变量配置，`paperclipai auth bootstrap-ceo` 找不到 `config.json`；且 `pnpm` 会在运行时通过 Corepack 从 npmjs.org 下载自身（国内不可靠）。新增 `scripts/bootstrap-invite.sh`：只给这次 CLI 调用在 `/tmp` 生成最小配置（数据库地址与公网地址取自容器环境），直接用 node 运行 CLI，用完即删（node:test 4 项）。
2. **Caddy 数据卷挂进了 paperclip 容器**（为本地信任内部 CA 而加）：该卷含 TLS 私钥，而数字员工运行在 paperclip 容器里。已移除挂载，并加测试禁止任何其他服务挂载 Caddy 的卷；本地冒烟改为只把根证书（公钥）复制进 paperclip 数据卷。
3. **realm 开启 `verifyEmail` 后**，邮箱未验证的用户会停在 Keycloak 的"验证邮箱"页，不会回到 Paperclip，也就不会发生账号关联；e2e 检查已兼容这种结果。

修改后重跑：`sso-e2e/run-all.sh` 仍为 38/38，`deploy/aliyun/tests/run.sh`（shellcheck、actionlint、node:test 40 项）通过。
