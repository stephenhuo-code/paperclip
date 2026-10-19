# Implementation Plan: 引导脚本新增组织

**Branch**: `feat/keycloak-sso` | **Date**: 2026-10-16（2026-10-19 按 spec 006 上线后的状态修订） | **Spec**: [spec.md](./spec.md)

## 方案

在现有 `deploy/aliyun/scripts/first-run.sh` 上加一个参数，不新建脚本：

```
first-run.sh <env>             # 首次初始化（003，行为不变，只修映射合并）
first-run.sh <env> --add-org   # 新增一个组织及其公司
```

**`--add-org` 流程**（每步先检查是否已完成）：

1. **前置检查**：Keycloak、Paperclip 健康；已有实例管理员；映射表能解析。否则报错退出，不改动。
2. **输入**：组织名称、别名（`^[a-z0-9-]+$`）、邮箱域名、公司名称。
   - 别名已在 Keycloak 中存在：直接使用该组织，不改其设置。
   - 别名已在映射表中：提示将替换为所选公司。
   - 已有同名公司：列出，选"使用已有"或"新建"。
3. **确认**：汇总将要做的事，`Proceed? [y/N]`。
4. **建组织**：`kcadm.sh create organizations`（名称、别名、启用、域名）。域名被占用时 Keycloak 报错，脚本说明原因退出。
5. **建公司**：需要时，经本机 Caddy 调 `POST /api/auth/sign-in/email` 以实例管理员登录，再 `POST /api/companies`，创建者即 owner。登录凭据优先用 `.env` 中的写回账号 `PAPERCLIP_SYNC_EMAIL` / `PAPERCLIP_SYNC_PASSWORD`（spec 006，即应急管理员），**不提示输入**；该账号缺失或登录失败时，才提示输入实例管理员的应急密码（邮箱从数据库读），错误可重输，最多 3 次。
6. **映射与发布**：把 `"别名":"公司ID"` 合并进 `/opt/paperclip/.env` 的 `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP`，其他条目原样保留；有变化才执行 `remote-deploy.sh` 重新部署当前版本。
7. **结束说明**：① 在 Keycloak 把员工加入新组织；② 负责人首次登录后，在 Paperclip"公司设置 → 成员"提升为管理员；③ **在新公司的 Connectors 中建一个模型网关连接**（Messages API，地址为部署配置的 `PAPERCLIP_GATEWAY_URL`，可与其他公司共用网关 Key）——AI 连接按公司隔离，新公司看不到原公司的网关连接；建好后 gateway-sync 自动识别并为该公司的 agent 设置计费（spec 006，无需改程序）。脚本输出这三条，网关地址取自 `environments/<env>.env`。

**首次初始化的修正**：第 5 步写映射时改为同样的"合并"，只增改首个组织那一条；"是否已完成"的判断改为"映射中首个组织已指向所选公司"，不再要求整张表完全相等。

**映射合并**：映射表的格式固定，是一层 JSON 对象，别名受限、值为 UUID。在 bash 里按 `"key":"value"` 逐条解析和重组，不依赖 jq（ECS 上不保证有，同 003）。遇到无法解析的内容时报错退出，不覆盖原配置。

密码处理沿用 003：交互输入不回显，经标准输入传给 `curl --data @-`，不进命令行和日志。

## Technical Context

- **语言**: Bash，通过 shellcheck
- **依赖**: 宿主机 `docker compose`、`curl`；容器内 `kcadm.sh`、`psql`；不依赖 `jq`
- **测试**: `node:test` + 现有沙箱（假 `docker`、`curl`）；真实 Keycloak 回归测试
- **约束**: 不改 Paperclip 代码；可重复执行；密码不留痕

## Constitution Check

| 规则 | 结论 |
|---|---|
| 尽量少改上游 | ✅ 只改部署脚本、测试和文档 |
| 测试先行 | ✅ 先写失败用例 |
| 变更写活动日志 | ✅ 登录、建公司走 Paperclip 现有接口，由服务端记录 |
| 密钥不入仓库 | ✅ 只读写服务器上的 `/opt/paperclip/.env` |

## 要改的文件

| | 文件 | 改动 |
|---|---|---|
| ✏️ 我们已有 | `deploy/aliyun/scripts/first-run.sh` | 加 `--add-org` 流程；映射改为合并写入；首次初始化的"已完成"判断改为只看首个组织那一条 |
| ✏️ 我们已有 | `deploy/aliyun/tests/first-run.test.mjs` | 新增组织走完全程（建组织、用 `.env` 写回账号登录且不提示密码、建公司、追加映射、重新部署、结束说明含新公司网关连接与网关地址）；缺少写回账号或其登录失败时提示应急密码；已有组织 / 已有公司 / 已映射时跳过；映射已有别名时替换并提示；别名不合法、应急密码 3 次错误、未完成首次初始化、映射损坏时退出且不改动；取消不改动；密码不出现在输出和调用记录；首次初始化重跑时保留其他组织映射 |
| ✏️ 我们已有 | `deploy/aliyun/tests/helpers/sandbox.mjs` | 假 `docker`：`get organizations` 按 `FAKE_KC_ORGS` 返回多条、`create organizations` 记录参数并可模拟域名冲突；假 `curl`：`/api/auth/sign-in/email` 按 `FAKE_SIGNIN_FAIL` 返回成功或 401，`/api/companies` 记录 |
| ✏️ 我们已有 | `deploy/aliyun/tests/keycloak-provision-test.sh` | 真实 Keycloak 回归：用脚本相同的参数创建第二个组织（名称、别名、域名）成功；同域名再建一个失败 |
| ✏️ 我们已有 | `deploy/aliyun/docs/manual.md` | 新增 1.4"新增组织"：运行命令、输入项、之后在 Keycloak 加员工、在 Paperclip 提升负责人、在新公司建模型网关连接（链到第二章 2.3） |
| ✏️ 我们已有 | `deploy/aliyun/README.md` | "首个管理员与组织映射"一节补一句：新增组织用 `first-run.sh production --add-org` |
| 🆕 新增 | `specs/004-first-run-add-org/tasks.md` | 任务清单（plan 确认后生成） |

不改：Paperclip 代码（`server/`、`ui/`、`packages/`）、`docker-compose.yml`、`provision.sh`、发布工作流。

## 测试与验证（TDD，只跑相关测试）

1. 扩展沙箱假命令 → 写 `first-run.test.mjs` 新用例并确认失败 → 实现 → 通过。
2. 003 原有用例全部保持通过。
3. `deploy/aliyun/tests/run.sh`（shellcheck + 部署测试）；`keycloak-provision-test.sh`（真实 Keycloak）。
4. 本地 `~/paperclip-local` 实际运行一次 `--add-org`：不提示应急密码；新组织员工企业登录进入新公司，原组织员工仍进入原公司；在新公司建网关连接后，新 agent 自动设置计费且花费写回到新公司。
5. 提交后由你推送；生产上按手册 1.4 运行。
