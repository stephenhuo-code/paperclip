# Plan：网关接入自动完成（用户无感）

**Date**: 2026-10-19 | **属于**: [spec 006](./spec.md) | **起因**：生产上 agent 选了网关连接后，带运行标识的启动命令没有被自动设置，花费没有写回；排查发现自动补齐依赖连接名"模型网关"和手工配置的写回账号，都不可靠。

## 目标

在 Paperclip 中只需：**运行方式选 Claude Code → 连接选指向网关的连接 → 选模型**。其余全部自动：

- 只要连接的地址等于**配置的网关地址**（本次为 `https://llm.ai-datum.net`），就视为网关连接，不管连接叫什么名字、有几个。
- 启动命令（带运行 / 任务标识）由 gateway-sync 自动设置；用户不需要也看不到这一项。
- 写回 Paperclip 用的账号由管理员在服务器 `.env` 中设置一次（两行），手册写明。
- 写回程序不能工作时，在发布日志中明确提示，而不是悄悄失效。

不改 Paperclip 代码。

## 方案

### 1. 网关地址可配置，按地址识别连接

- 新增配置 `PAPERCLIP_GATEWAY_URL`（`environments/<env>.env`，非密钥），生产为 `https://llm.ai-datum.net`；gateway-sync 从环境变量读取。取代 `PAPERCLIP_GATEWAY_CONNECTION_NAME`（删除）。
- 识别规则：AI 连接的 `routing.baseUrl` 与 `PAPERCLIP_GATEWAY_URL` **规范化后相等**（协议与主机名不区分大小写，去掉末尾 `/`，忽略末尾的 `/v1`），且状态不是已撤销。同一公司可以有多个匹配的连接，都算网关连接。
- 未配置 `PAPERCLIP_GATEWAY_URL` 时 gateway-sync 只写回、不补齐，并记录一次提示。

### 2. 自动补齐的条件

对每个 agent，满足以下全部条件即自动设置启动命令 `/usr/local/bin/claude-agent-acp-tagged`：

| 条件 | 说明 |
|---|---|
| 运行方式为 Claude Code | `adapterType = claude_local` |
| 选用的连接是网关连接 | 按上面的地址规则 |
| 执行引擎不是 "Claude CLI" | Default（ACP）和 ACP 都可以；CLI 不使用 ACP 启动命令 |
| ACP 启动命令为空 | 已填写的自定义命令一律不改 |

不满足的 agent 不改，按原因列入"不经网关"日志（每小时一次）。用户把 agent 从网关连接切走时，自动设置的启动命令保持不变（它对非网关连接无害，只是加了请求头）。

### 3. 写回账号由管理员设置

管理员在服务器 `/opt/paperclip/.env` 中加入 `PAPERCLIP_SYNC_EMAIL`、`PAPERCLIP_SYNC_PASSWORD`（应急管理员），重新发布一次。不改 `first-run.sh`（2026-10-19 与用户确认：管理员配置更简单）。漏配由下面第 4 点在发布日志中提示。

### 4. 写回程序状态可见

- gateway-sync 每轮把状态写入状态文件：`ok`、`account-missing`、`login-failed`、`gateway-url-missing`，以及上一轮写回条数。
- `deploy.sh` 在健康检查通过后读取该状态：不是 `ok` 时在发布日志（GitHub Actions 中可见）打印明确的警告和处理办法。**不使发布失败**，避免写回问题阻塞发布。
- 健康检查本身仍只要求循环在运行（现有行为）。

## 要改的文件

| | 文件 | 改动 |
|---|---|---|
| ✏️ | `deploy/aliyun/gateway-sync/lib.mjs` | 地址规范化与匹配；补齐条件改为按地址、排除 CLI 引擎；支持多个网关连接 |
| ✏️ | `deploy/aliyun/gateway-sync/sync.mjs` | 读取 `PAPERCLIP_GATEWAY_URL`；写状态文件 |
| ✏️ | `deploy/aliyun/tests/gateway-sync.test.mjs` | 地址匹配（大小写、末尾 `/`、`/v1`、不同主机不匹配）、改名 / 多个连接、已撤销不算、CLI 引擎不补、未配置地址不补齐、状态文件内容 |
| ✏️ | `deploy/aliyun/docker-compose.yml` | gateway-sync 加 `PAPERCLIP_GATEWAY_URL`，去掉 `PAPERCLIP_GATEWAY_CONNECTION_NAME` |
| ✏️ | `deploy/aliyun/environments/production.env`、`tests/fixtures/production.env` | `PAPERCLIP_GATEWAY_URL=https://llm.ai-datum.net`；删除连接名配置 |
| ✏️ | `deploy/aliyun/tests/compose.test.mjs` | 新变量断言 |
| ✏️ | `deploy/aliyun/tests/helpers/sandbox.mjs` | 假 `docker` 回应 gateway-sync 状态读取 |
| ✏️ | `deploy/aliyun/scripts/deploy.sh`（或 `lib.sh`） | 健康检查后读取 gateway-sync 状态并打印警告 |
| ✏️ | `deploy/aliyun/tests/deploy.test.mjs` | 状态非 ok 时打印警告且发布仍成功；ok 时不打印 |
| ✏️ | `deploy/aliyun/docs/manual.md`、`README.md` | 第二章改为：建一个指向网关地址的连接（名字随意）→ agent 选它和模型 → 完成；写回账号由管理员在 `.env` 设置；去掉"连接命名""填 ACP server command" |
| ✏️ | `specs/006-litellm-gateway-billing/tasks.md` | 追加本计划的任务 |

不改：Paperclip 代码（`server/`、`ui/`、`packages/`）、LiteLLM 配置与钩子、启动脚本。

## 测试与验证（TDD，只跑相关测试）

1. 先写 `gateway-sync.test.mjs`、`deploy.test.mjs`、`compose.test.mjs` 的新用例并确认失败 → 实现 → 通过。
2. `deploy/aliyun/tests/run.sh`。
3. 本地 `~/paperclip-local`：把本地连接改成随意名称；新建一个 agent 只选 Claude Code + 网关连接 + 模型 → 30 秒内启动命令被自动设置 → 运行后花费按项目写回；去掉 `.env` 中的写回账号后发布，发布日志出现警告；补回后再发布，警告消失。
4. 提交后由你推送发布；若发布日志提示写回账号问题，按提示在服务器 `.env` 中设置后再发布一次。

## 不在本次范围

- 上游额度用完时改为"稍后重试"、避免整个连接被停用（方案 B，另行处理）。
- 在 Paperclip / LiteLLM 界面中显示写回状态。
- Paperclip 的"应用被归档后连接不显示"缺陷。
