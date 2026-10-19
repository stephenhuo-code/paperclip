# LiteLLM 验证记录

目标：判断方案 B（LiteLLM 统一接入并计价，同步到 Paperclip，支持按 agent / 项目预算）是否可行，重点是 Kimi 会员与 MiniMax 编程套餐能否接入。

环境：LiteLLM 1.105.1（`ghcr.io/berriai/litellm@sha256:b7b9e2c3…`，main-stable 2026-10-13）；Claude Code 2.1.300；本机 Docker。

## 2026-10-17 第一轮：假上游（无真实 Key）

结果文件：`results/run-2026-10-17T05-04-28-097Z.md`

| 检查 | 结果 | 说明 |
|---|---|---|
| 缓存分项计价 | ✅ 通过 | 一次调用 1000 输入 + 5000 缓存命中 + 300 缓存写入 + 200 输出，LiteLLM 记 $0.0029，与按各自单价计算一致；若缓存按输入价算应为 $0.0071。网上报告的"缓存按输入价计"问题在 Anthropic 接入方式下未出现 |
| 虚拟 Key 预算 | ✅ 通过 | 上限 $0.005，前两次 200，第三次被拒（HTTP 422） |
| 请求标签 | ✅ 可用 | 客户端发送 `x-litellm-tags: project-demo`，花费记录的标签中出现 `project-demo`；LiteLLM 还自动把客户端 User-Agent（`claude-cli/2.1.300`）记为标签 |
| 自定义头转发 | ⚠️ 需按模型开启 | 默认不转发；对模型开启 `forward_client_headers_to_llm_api` 后，`x-` 开头的头（如 `x-paperclip-run-id`）会转发到上游 |
| 上游看到的 User-Agent | ❌ 是 LiteLLM | 两种设置下上游收到的都是 `litellm/1.105.1`，不是 Claude Code。源码确认 LiteLLM 只转发 `x-*` 和 `anthropic-beta` 头 |

### 对方案的影响

- **Kimi 会员**：Kimi 要求第三方工具保持真实客户端标识，篡改可能导致会员被暂停。经 LiteLLM 后 Kimi 看到的是 `litellm/1.105.1`。这不是篡改成别的工具，但也不是 Claude Code；是否允许需向 Kimi 确认。强行把 User-Agent 改成 `claude-cli` 属于篡改，不采用。
- **按项目归集**：如果每次运行能带上项目标签（`x-litellm-tags`），LiteLLM 可直接按项目统计，不必按时间匹配。但 Paperclip 现在按 agent 设置环境变量，做不到每次运行带不同的项目标签，需第二阶段确认替代办法（按时间匹配运行）。

## 2026-10-17 第二轮：真实模型

结果文件：`results/run-2026-10-17T05-22-05-993Z.md`。每个模型经 LiteLLM 用 Claude Code 调用两次（一句话提示）。第一次尝试（05:21）三个模型均调用成功，但脚本读取花费记录时连接中断、未写结果；加重试后重跑即本轮。

| 模型 | Claude Code 经 LiteLLM | 缓存 token | 按配置单价计价 | token 与 Claude Code 一致 |
|---|---|---|---|---|
| deepseek-chat（按量） | ✅ 正常 | ⚠️ 两次都是 0 | ✅ | ✅ 输入 31281 / 输出 2 |
| kimi-for-coding（Kimi 会员 Key） | ✅ 正常 | ✅ 缓存命中 23040 | ✅ | ✅ |
| MiniMax-M3（编程套餐 Key） | ✅ 正常 | ✅ 缓存命中 256 | ✅ | ✅ |

**Claude Code 自报费用不可信**：同样的调用，LiteLLM 按测试单价记 $0.004–$0.016，Claude Code 自己报 $0.022–$0.078（约 5 倍）——它按自己内置的 Anthropic 价格算，与实际模型无关。这印证了 Paperclip 现在对自定义网关的"工具上报费用"不能用于计价。

**DeepSeek 缓存为 0**：Claude Code 和 LiteLLM 都记为 0，两者一致。可能是 DeepSeek 的 Anthropic 兼容接口不回报缓存命中，或两次调用间隔太短未命中；若属前者，DeepSeek 的缓存折扣在 LiteLLM 里体现不出来，计价会偏高。待用更多次调用确认。

LiteLLM 日志对三个模型都提示 "Dropping adaptive thinking"：Claude Code 请求的思考参数被丢弃，不影响调用。

## 2026-10-17 第二阶段：本地 Paperclip 经 LiteLLM

`stage2.mjs`：两个 agent（deepseek-chat、kimi-for-coding），每个 agent 一个 LiteLLM 虚拟 Key，经 Paperclip"自定义网关"连接接入；每个 agent 在 P1、P2 两个项目各有一个任务，同时创建。结果文件：`results/stage2-2026-10-17T05-32-25-968Z.json`。

过程问题（已在脚本中处理）：
- Paperclip 的网关地址只接受 HTTPS 或本机回环 HTTP。本地验证用 socat 旁路容器把 Paperclip 容器内的 `127.0.0.1:4000` 转到 LiteLLM；生产需给 LiteLLM 配 HTTPS。
- 通过接口创建连接时带 `agentIds` 只授权、不选用；还要把 agent 的 `runtimeConfig.aiConnection` 指向该连接，否则运行报 "Not logged in"（界面会两步都做）。
- 本地公司开启了新建审批，agent 经"申请 + 批准"创建。

| 检查 | 结果 |
|---|---|
| Paperclip agent 经 LiteLLM 运行 | ✅ 两个 agent、4 个任务全部成功 |
| Paperclip 自己记录的计费类型 | ❌ 全部是 `subscription_included`，费用 $0（Key 以 Bearer 方式传入，被判为订阅） |
| 同一 agent 是否并发运行 | ❌ 会：同一 agent 的两个任务在 50 毫秒内同时开始 |
| 按时间把 LiteLLM 花费对应到运行 | ❌ 不可靠：DeepSeek 19 条记录 0 条可唯一对应，Kimi 24 条中 8 条 |
| 运行之外的 LiteLLM 花费 | ⚠️ 有：绑定 / 唤醒 agent 时 Paperclip 做的连接检查也产生调用（DeepSeek 6 条），Paperclip 不记录 |
| token 数：Paperclip 记录 vs LiteLLM | ✅ 基本一致（运行期间） |

token 对比（运行期间）：

| agent | 普通输入 Paperclip / LiteLLM | 缓存命中 | 输出 |
|---|---|---|---|
| deepseek-chat | 56,154 / 58,009 | 190,592 / 190,592 | 1,438 / 1,464 |
| kimi-for-coding | 87,507 / 88,717 | 474,112 / 475,136 | 3,789 / 3,789 |

DeepSeek 在真实任务中有大量缓存命中（第二轮只调用两次、间隔太短所以为 0），缓存计价可用。

### 结论

1. **按项目归集不能靠 LiteLLM + 时间匹配**：同一 agent 会并发运行，时间窗口重叠，无法判断一笔花费属于哪个任务 / 项目。
2. 要让 LiteLLM 直接按项目统计，必须每次运行带上项目 / 运行标签（`x-litellm-tags`），这需要修改 Paperclip（按运行设置请求头）。因此"Paperclip 不用修改"的前提不成立。
3. **Paperclip 自己已经按运行记录了准确的 token 数，并带有项目**，与 LiteLLM 相差约 2%。缺的只是单价。用 Paperclip 的 token × 单价表计价（在 Paperclip 内计价）即可按 agent / 项目执行预算，比经 LiteLLM 同步更直接。
4. LiteLLM 仍可作为统一接入层（集中管理上游 Key、按 Key 限额作为兜底），但不是计价和项目预算的必要条件。

## 2026-10-17 第三阶段：按运行打标签并写回 Paperclip（方案②）

思路：Paperclip 每次运行给 agent 进程传入 `PAPERCLIP_RUN_ID`、`PAPERCLIP_TASK_ID`。把 agent 的 ACP 启动命令（`adapterConfig.agentCommand`）换成 `claude-agent-acp-tagged.sh`：它设置 `ANTHROPIC_CUSTOM_HEADERS="x-litellm-tags: paperclip-run:<运行>,paperclip-task:<任务>"` 后启动原来的 `claude-agent-acp`。LiteLLM 把标签记入花费记录；`stage3.mjs sync` 按运行查出任务和项目，通过 Paperclip 现有接口 `POST /api/companies/:id/cost-events` 写回（每条带 agent、运行、任务、项目，幂等键为 LiteLLM 请求号）。不改 Paperclip 代码，只改 agent 配置。

设置：P1 项目月度预算 $0.05（硬上限）；两个 agent 在 P1、P2 各一个任务，同时创建（同一 agent 两个运行并发）。结果文件：`results/stage3-2026-10-17T08-33-10-926Z.json`。

| 检查 | 结果 |
|---|---|
| 启动脚本在默认 ACP 方式下生效 | ✅ |
| 并发运行下每条 LiteLLM 记录都带运行标签 | ✅ DeepSeek 12/12、Kimi 18/18，未打标签 0 |
| 按运行归集到项目 | ✅ 4 个运行各自对应到 P1 / P2 |
| 写回 Paperclip 的费用记录 | ✅ 30 条，按项目：P1 $0.1097、P2 $0.1002 |
| 重复同步 | ✅ 幂等：第二次 0 条新增、30 条识别为重复 |
| Paperclip 现有项目预算按写回的费用执行 | ✅ P1 超 $0.05 后：80% 预警（已解除）、硬上限事件（待处理）、项目被暂停（`pause_reason = budget`） |

### 结论

方案②可行：**不改 Paperclip 代码**，用"启动脚本打标签 + LiteLLM 计价 + 同步程序写回"就能按 agent / 项目执行 Paperclip 现有的预算。

上生产还需要解决：
1. **LiteLLM 需要 HTTPS 地址**（Paperclip 只接受 HTTPS 网关），例如经 Caddy 提供一个内部域名。
2. **启动脚本放进容器**：可由 docker-compose 挂载，不改镜像。
3. **每个 agent 要选用对应的 LiteLLM 连接并设置 `agentCommand`**：界面能否设置 `agentCommand` 待确认，否则需在部署侧用接口设置。
4. **同步程序常驻运行**（例如每分钟一次），需要一个 Paperclip 的长期凭证（不能用应急管理员的会话）。
5. **未带运行标签的调用**（连接检查等）：只记到 agent，不记到项目。
6. **条款**：Kimi 会员 / MiniMax 套餐经网关使用是否允许，仍待确认。

## 2026-10-17 spec 006 前置验证（T002、T003）

LiteLLM 改为 `STORE_MODEL_IN_DB=True`，模型通过管理接口 / 界面添加。

| 检查 | 结果 |
|---|---|
| T002 新增模型（数据库保存）后立即可用 | ✅ 新增约 10 秒后可调用，计费 $0.0029 与单价一致 |
| T002 修改单价即时生效 | ✅ 输出单价 $4→$8/M 后，下一次调用记 $0.0037（按新价） |
| T002 管理界面可编辑单价 | ✅ 模型详情 → Model Settings → Pricing：输入、输出、缓存命中、缓存写入（每百万 token） |
| T003 钩子转发调用方 User-Agent | ✅ 上游收到 `claude-cli/2.1.300 (external, sdk-cli)`，与调用方完全一致 |
| T003 拒绝未设单价的模型 | ✅ 返回 400"模型未设单价：…"，请求未发往上游 |

注意事项（写入手册 / 生产配置）：
- 界面中**缓存命中、缓存写入单价留空时按输入单价计算**，会多计费，必须填写。
- 界面提示"Environment-credential login is enabled"：生产应先在界面创建一个独立的管理员账号，再设置 `general_settings.disable_env_credential_login: true`，关闭用主密钥登录界面。
- 数据库中的模型参数（含上游 Key）由 LiteLLM 加密保存；生产必须设置固定的 `LITELLM_SALT_KEY`，之后不可更改，否则已保存的 Key 无法解密。
- 写在配置文件中的模型在界面中显示为"Defined in config"，不能在界面编辑；生产配置文件不定义模型。

## 待做

- [x] 第二轮：真实模型（可用性、缓存 token、计价、token 一致性）
- [x] DeepSeek 缓存命中是否会被回报（第二阶段确认会）
- [x] 第二阶段：接入本地 Paperclip，验证花费能否对应到运行和项目（结论：按时间不能）
- [x] 第三阶段：按运行打标签、写回 Paperclip、项目预算生效
- [ ] 向 Kimi、MiniMax 确认经代理网关使用会员 / 套餐 Key 是否允许
