# Implementation Plan: 首次部署初始化引导

**Branch**: `feat/keycloak-sso` | **Date**: 2026-10-15 | **Spec**: [spec.md](./spec.md)

## 方案

新增一个交互式脚本 `deploy/aliyun/scripts/first-run.sh <env>`，在 ECS 上以 root 运行，按顺序完成五步，每步先检查是否已完成（[research](./research.md) R5）：

1. **Keycloak 全局管理员**：在 `keycloak` 容器内用 `kcadm.sh`（以 `provisioner` 登录）在 master realm 建用户并赋 `admin` 角色（R2）。
2. **Paperclip 管理员**：沿用已验证的流程，在宿主机用 `curl` 经本机 Caddy 调用现有接口：注册 → `bootstrap-invite.sh` 生成邀请 → 接受邀请，成为实例管理员（R3）。
3. **公司**：`POST /api/companies`，创建者自动成为 owner（R3）。
4. **管理员企业账号**：在 `digital-workforce` realm 建同邮箱、邮箱已验证的用户，设密码，加入组织（R4）。
5. **关联与关闭注册**：改 `/opt/paperclip/.env` 两行，用 `remote-deploy.sh` 重新部署当前版本（R6）。

所有密码交互输入、不回显，经标准输入传给 `kcadm.sh -f -` 和 `curl --data @-`，不进命令行参数和日志。不改 Paperclip 代码、数据库和界面；只新增部署脚本。

交互、输出和退出码见 [contracts/first-run.md](./contracts/first-run.md)。没有新的数据实体，不需要 data-model.md。

## Technical Context

- **语言**: Bash（与 `deploy/aliyun/scripts/*.sh` 一致，通过 shellcheck）
- **依赖**: 宿主机 `docker compose`、`curl`（`bootstrap.sh` 已在 ECS 上安装 Docker）；容器内 `kcadm.sh`、`psql`。不依赖 `jq`，见下
- **测试**: `node:test` + 现有沙箱（假 `docker`、`curl`）
- **约束**: 不改上游；可重复执行；密码不留痕

**jq**：`ci-run-command.sh` 只在 CI 上用 jq。ECS（Ubuntu 24.04）默认不一定有。决定：脚本不依赖 jq，JSON 解析用 `psql -tA` 查询结果和 `kcadm.sh --fields ... --format csv` 输出；HTTP 响应只判断状态码，邀请 token 用 `bootstrap-invite.sh` 的输出。

## Constitution Check

`.specify/memory/constitution.md` 仍是空模板，按 `AGENTS.md` 检查：

| 规则 | 结论 |
|---|---|
| 尽量少改上游 | ✅ 只新增部署脚本，不改 Paperclip 代码 |
| 测试先行 | ✅ 先写 `first-run.test.mjs` 失败用例 |
| 变更写活动日志 | ✅ 走 Paperclip 现有接口，注册、邀请、建公司由服务端照常记录 |
| 密钥不入仓库 | ✅ 只读写服务器上的 `/opt/paperclip/.env` |

## 要改的文件

| | 文件 | 改动 |
|---|---|---|
| 🆕 新增 | `deploy/aliyun/scripts/first-run.sh` | 引导脚本：前置检查、五个步骤、汇总确认、结果输出 |
| 🆕 新增 | `deploy/aliyun/tests/first-run.test.mjs` | 全新实例走完五步；已有管理员和公司时跳过；多家公司选择；取消不改动；密码不出现在输出和假命令的调用记录里；两个密码相同被拒；配置已完成时不重新部署；前置检查失败直接退出 |
| ✏️ 我们已有 | `deploy/aliyun/tests/helpers/sandbox.mjs` | 假 `docker` 回应 `kcadm.sh`、`psql` 查询；假 `curl` 回应注册、接受邀请、建公司、健康检查；`run()` 支持传入标准输入 |
| ✏️ 我们已有 | `deploy/aliyun/README.md` | "首个管理员与组织映射"改为运行 `first-run.sh`；"在 Keycloak 中管理用户"首次登录改用脚本创建的管理员；原手动步骤保留为备用 |
| ✏️ 我们已有 | `deploy/aliyun/env.example` | `PAPERCLIP_AUTH_DISABLE_SIGN_UP`、`PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP` 的注释改为"由 first-run.sh 设置" |

不改：Paperclip 代码（`server/`、`ui/`、`packages/`）、`docker-compose.yml`、发布工作流、`provision.sh`。

## 测试顺序（TDD）

1. 扩展沙箱的假命令和 `run()` 输入（先让新测试能跑起来并失败）。
2. `first-run.test.mjs` 全部用例先失败 → 实现 `first-run.sh` → 通过。
3. `deploy/aliyun/tests/run.sh`（shellcheck + 全部部署测试）。
4. 本地全新实例实际运行一次（[quickstart](./quickstart.md)）。
5. 由你推送发布后，在生产上运行。
