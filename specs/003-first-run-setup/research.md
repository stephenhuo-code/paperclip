# Research: 首次部署初始化引导

## R1. 脚本放在哪里、怎么到服务器上

- **决定**: 新增 `deploy/aliyun/scripts/first-run.sh`，复用 `scripts/lib.sh` 的 `load_environment`、`compose`、`env_value`、`die`。部署资产镜像（`paperclip-deploy`）每次发布都会带上 `deploy/aliyun/`，`remote-deploy.sh` 把它装到 `/opt/paperclip/deploy/scripts/`，无需改发布流程。
- **调用**: `/opt/paperclip/deploy/scripts/first-run.sh production`，以 root 在 ECS 上运行。

## R2. 创建 Keycloak 全局管理员（FR-002）

- **发现**: `keycloak` 容器内有 `kcadm.sh`，可用 `provisioner`（口令在 `.env` 的 `KC_BOOTSTRAP_ADMIN_PASSWORD`）登录 master realm（`http://localhost:8080`，`KC_HTTP_ENABLED=true`）。`provision.sh`、`sso-e2e/keycloak-setup.sh` 已这样用。
- **决定**: `compose exec -T keycloak kcadm.sh`：按用户名查 master realm 用户，不存在则 `create users -r master`，赋予 master realm 角色 `admin`。
- **密码不进命令行**: 用 `kcadm.sh update users/<id>/reset-password -r master -f -`，JSON 从标准输入传入（`{"type":"password","value":…,"temporary":false}`），不用 `--new-password`。
- **已验证**（2026-10-15，Keycloak 26.8.0 临时容器）：该命令以默认方式执行成功（退出码 0），之后用新密码登录成功；容器进程列表中不出现密码。

## R3. 创建 Paperclip 管理员和公司（FR-003、FR-004）

- **发现**: 公网部署关闭浏览器认领，现有流程是 `bootstrap-invite.sh` 生成一次性邀请 → 注册（`POST /api/auth/sign-up/email`）→ 带会话接受邀请（`POST /api/invites/<token>/accept`），由 `sso-e2e/e2e.mjs setup` 和 stack-smoke 验证过。创建公司 `POST /api/companies` 要求实例管理员，创建者自动成为 owner（`server/src/routes/companies.ts:1206-1216`）。
- **决定**: 脚本在宿主机用 `curl` 按同一流程调用这些接口：`--resolve <APP_DOMAIN>:443:127.0.0.1` 经本机 Caddy 访问，带 `Origin: https://<APP_DOMAIN>`，会话存在临时 cookie 文件（权限 600，结束即删）。邀请链接直接调用 `bootstrap-invite.sh`。JSON 请求体从标准输入传给 `curl --data @-`，密码不进命令行。
- **前提**: 注册时邮箱注册必须开启（首次部署 `.env` 默认 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=false`）。若已关闭且还没有管理员，脚本报错并说明如何处理，不擅自改配置。
- **邮箱已被占用**: 注册接口返回邮箱已存在时，提示运维人员换一个邮箱重新输入；不尝试接管已有账号（已有实例管理员的情况由 R5 处理）。
- **不改上游**: 只调用现有接口，不改 Paperclip 代码。

## R4. 管理员的企业账号（FR-004a）

- **发现**: 001 FR-010 已实现：Keycloak 报告邮箱已验证时，企业登录关联到同邮箱的已有本地账号。
- **决定**: 在 `digital-workforce` realm 中按邮箱查用户；不存在则创建（用户名直接使用完整邮箱，避免与已有用户名冲突；`emailVerified=true`，姓名同 Paperclip 管理员），用 R2 的方式设置密码，加入 `KEYCLOAK_ORG_ALIAS` 对应的组织。不分配 `agent-creator`（owner 本来就有全部权限）。

## R5. 检查已完成的步骤（FR-006，US2）

| 步骤 | 判断已完成的依据 |
|---|---|
| Keycloak 全局管理员 | master realm 中存在该用户名 |
| Paperclip 管理员 | `instance_user_roles` 中有 `instance_admin`（经 `compose exec -T postgres psql` 查询） |
| 公司 | `companies` 中已有公司；多于一家时列出供选择 |
| 管理员企业账号 | realm 中存在该邮箱的用户，且是组织成员 |
| 关联与关闭注册 | `.env` 中映射已指向所选公司，且 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` |

已有 Paperclip 管理员时，从数据库读出其邮箱和姓名，用于第 4 步。

## R6. 关联与重新部署（FR-005）

- **决定**: 修改 `/opt/paperclip/.env` 的 `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP={"<alias>":"<公司 ID>"}` 和 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`（逐行替换，保留其他行与权限 600），然后执行 `/opt/paperclip/bin/remote-deploy.sh <env> "$(cat state/current)"`，复用已有的健康检查与回滚。配置未变时不重新部署。

## R7. 测试方式

- **决定**: `deploy/aliyun/tests/first-run.test.mjs`，用现有沙箱（`tests/helpers/sandbox.mjs` 的假 `docker`、`curl`）。扩展假命令以回应 `kcadm.sh`、`psql` 查询和 Paperclip 接口；沙箱 `run()` 增加标准输入参数以模拟交互输入。
- 真实环境验证：在本地测试环境（`~/paperclip-local`，需先清空数据卷的全新实例）实际运行一次。
