# Verification: 数字员工的管控

日期：2026-10-12。分支 `feat/keycloak-sso`，基于 `4ef77754c` 的未提交工作区。

## TDD

每组测试先写好并确认失败，再实现。

| 组 | 先失败 | 实现后 |
|---|---|---|
| `company-admin.test.ts` | 模块不存在 | 8/8 |
| `agent-hire-approval-admin.test.ts` | 6 个"operator 应被拒绝"用例失败，其余 11 个通过 | 17/17 |
| `auth-oidc.test.ts`、`better-auth-oidc.test.ts`、`oidc-backfill-skip.test.ts` | 17 个新用例失败 | 3 个文件 66/66 |
| `keycloak-provision-test.sh` | 12 项新检查失败 | 29/29 |

## 结果

- 相关 server 测试（agent、审批、公司、权限、认证、启动）：64 个文件中 1757 通过、2 失败（`company-skills.test.ts`，不含本次改动时同样失败）；44 个文件 700/700。
- `deploy/aliyun/tests/run.sh`（shellcheck、actionlint、40 个 node:test）：通过。
- `deploy/aliyun/tests/sso-e2e/run-all.sh`（真实 Keycloak 26.8.0）：57/57。新增 19 项：A（有 `agent-creator`）能建 agent、B 不能；两人都不能改 agent 配置，管理员能；operator 不能关审批开关、不能批准/驳回申请、不能终止待审批 agent，管理员能批准；去掉 A 的角色并重新登录后 A 不能建；服务重启后 A 仍没有两项权限；权限变化写活动日志。
- `deploy/aliyun/tests/stack-smoke/stack-smoke.sh d58a47c4…`（真实 compose、`deploy.sh`、`provision.sh`、Caddy TLS，镜像由本工作区构建）：64 项 PASS，包括 e2e 47/47 和"重启 paperclip 容器后权限不恢复"。
- `pnpm -r typecheck`：通过。
- `pnpm test:run`、`pnpm build`：未运行。改动相关测试已全部通过；全量检查留到提 PR 前，经确认后再跑。

## US3：创建人修改自己创建的 agent（2026-10-14）

| 组 | 先失败 | 实现后 |
|---|---|---|
| `agent-created-by.test.ts`（内嵌 Postgres：写入创建人、迁移补值） | 字段不存在；补值前创建人未写入 | 3/3 |
| `agent-owner.test.ts` | 模块不存在 | 5/5 |
| `agent-owner-edit-routes.test.ts` | 3 个"创建人应放行"用例 403 | 7/7 |

- agent 相关 server 测试 48 个文件：1010/1010。
- 本地测试发现创建人保存 `AGENTS.md` 仍 403（指令文件在服务层检查）。补测试（先失败，报错与界面一致）后修复（T034）：`agent-created-by.test.ts` 5/5；agent、指令相关 50 个文件 1054/1054。
- `@paperclipai/db` 测试：167/168；`backup-lib.test.ts` 一个用例偶发失败，单独重跑 2 次均通过，与本次改动无关。
- `deploy/aliyun/tests/sso-e2e/run-all.sh`：62/62。新增：agent 记录 A 为创建人；A 改自己直接创建的、审批通过的 agent 成功；A 改管理员创建的 agent 403；去掉角色并重新登录后 A 改自己的也 403。
- `pnpm -r typecheck`：通过。
- 未运行：全量 `pnpm test:run`、`pnpm build`（留到提 PR 前，经确认后再跑）。

## 说明

- 上游测试 `approval-routes-idempotency.test.ts` 的 mock 加了 `getMembership`（测试用户为 owner），否则其 hire 审批用例被新规则拦截。
- 跑 stack-smoke 前停掉了本地测试环境（同为 compose 项目 `paperclip`），数据卷备份为 `pcbak_*`，跑完后恢复并重启，数据完整。
