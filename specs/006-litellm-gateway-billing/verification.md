# 验证记录：模型网关统一接入与按运行计费

本地测试环境 `~/paperclip-local`（Paperclip 镜像 `bad8191bc`，LiteLLM 1.105.1）。

## 2026-10-17 T018：网关进入本地部署

- 用新的部署文件重新部署：`deploy.sh` 为已有服务器补齐 4 个网关密钥（`LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY`、`LITELLM_DB_PASSWORD`、`PAPERCLIP_READONLY_DB_PASSWORD`），在已有数据库上创建 `litellm` 库与 `paperclip_readonly` 角色，发布成功（健康检查含网关）。
- Paperclip 容器内访问 `https://llm.127.0.0.1.nip.io/health/liveliness`：curl 200、证书校验通过；Node `fetch` 200（与 agent 进程同样的信任方式）。
- 本机浏览器地址 `https://llm.127.0.0.1.nip.io/ui/` 可打开管理界面。

## 2026-10-17 T042：本地全流程（`deploy/aliyun/experiments/litellm-verify/e2e-006.mjs`）

按管理员实际操作的方式（经与界面相同的接口）：网关中添加 `deepseek-chat`、`kimi-for-coding`（真实上游 Key、测试单价）；Paperclip 中建共享连接"模型网关"（所有 agent 可用）；新建项目并设 $0.05 月度硬上限；新建三个 agent 并选用"模型网关"：两个 ACP 启动命令留空，一个填写自定义命令；两个默认 agent 各在项目中同时执行两个任务。

| 检查 | 结果 |
|---|---|
| 自动补齐启动命令（US5） | ✅ 约 30 秒内两个默认 agent 被补上 `/usr/local/bin/claude-agent-acp-tagged`；自定义命令的 agent 未被修改，列入"不经网关" |
| 经网关运行（US1） | ✅ DeepSeek 两个任务成功 |
| 花费按运行写回（US3） | ✅ 网关中带运行标识的调用 21 条，Paperclip 中写回 21 条（DeepSeek 9 条 / 2 个运行，Kimi 12 条 / 2 个运行），全部带项目 |
| 重复扫描不重复计费 | ✅ 写回程序多轮重扫，条数保持 21 |
| 项目预算执行 | ✅ 项目花费 $0.15 超过 $0.05：Paperclip 暂停项目（`pause_reason=budget`），硬上限事件待处理，Kimi 两个进行中的运行被取消（"Cancelled due to budget pause"） |
| 未归属 | ✅ 无运行标识的调用 18 条 / $0.19（测试单价）——Paperclip 绑定连接时在 agent 环境中做的连接检查；未写回，日志中汇总 |
| 网关停止时的运行 | ⚠️ 与 spec 不同：运行没有失败，Claude Code 持续重试；网关 5 分钟后恢复，运行随即成功完成。不会改为直连上游 |

过程中修正：
- 写回程序按名称找"模型网关"时跳过已撤销的同名连接（新增测试）。
- "缺少网关连接"日志从每轮一次改为每家公司一次。
- 共享连接需授权"所有 agent"，否则选用时报 "This connection is not permitted for this agent"（手册 2.3 已写明）。
- agent 填写不存在的 ACP 启动命令时，Paperclip 在选用连接时校验运行环境并拒绝（`adapter_engine_unavailable`）。

测试：`deploy/aliyun/tests/run.sh`（shellcheck、actionlint、全部 node 测试）通过；`litellm-hooks-test.sh`、`postgres-roles-test.sh` 通过。

## 2026-10-19 网关接入自动完成（plan-auto-setup，`experiments/litellm-verify/e2e-auto.mjs`）

| 检查 | 结果 |
|---|---|
| 按地址识别网关连接 | ✅ 新连接名为"网关-自动-…"（不叫"模型网关"），地址末尾带 `/`，仍被识别 |
| 只选连接和模型，启动命令自动设置 | ✅ 选用后约 1 分钟，`adapterConfig.agentCommand` 被设为 `/usr/local/bin/claude-agent-acp-tagged`（日志 `launcher-set`） |
| 花费写回 | ✅ 一次任务：4 条、$0.0345，全部带项目 |
| 写回程序状态 | ✅ 正常时 `{"status":"ok",…}`，发布日志无警告 |
| 缺少写回账号时 | ✅ 发布成功，日志出现 `warning: gateway-sync cannot write gateway spend to Paperclip: no account. Set PAPERCLIP_SYNC_EMAIL and PAPERCLIP_SYNC_PASSWORD …`；补回后再发布无警告 |

测试：`deploy/aliyun/tests/run.sh` 通过。
