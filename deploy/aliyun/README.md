# 阿里云部署（Keycloak SSO 数字员工平台）

设计依据：`specs/001-keycloak-sso-aliyun/`（规格、方案、调研、契约）。

> 部署手册的其余章节由任务 T049 补全。

## 配置数字员工

数字员工就是 Paperclip 里的 agent。三家国内模型都通过 Paperclip 现有的 `claude_local`（Claude Code CLI，已装在镜像里）接入各自的 **Anthropic 兼容接口**，不需要新的 adapter（调研见 research.md R8）。

| 模型 | Adapter | `ANTHROPIC_BASE_URL` | 模型名（示例） |
|---|---|---|---|
| DeepSeek | Claude Code（`claude_local`） | `https://api.deepseek.com/anthropic` | `deepseek-chat` |
| MiniMax | Claude Code（`claude_local`） | `https://api.minimaxi.com/anthropic` | `MiniMax-M2` |
| Kimi | Claude Code（`claude_local`） | `https://api.moonshot.cn/anthropic` | `kimi-k2` 系列 |

> ⚠️ 上表的接口地址和模型名来自各家公开文档，**尚未在生产环境实测**（任务 T021，需要三家的 API Key）。实测后以实测结果为准并更新本表。Kimi 也可以改用原生的 `kimi_local`（Kimi Code CLI），配置 `KIMI_MODEL_NAME` 与 `KIMI_MODEL_API_KEY`。

### 创建一个数字员工

1. 管理员在公司设置里把该模型的 API Key 保存为**公司密钥**（例如 `deepseek-api-key`）。
2. 新建 agent，Adapter 选 **Claude Code**。
3. 模型下拉框选 **Enter custom model…**，填入上表的模型名。
4. 在 agent 的环境变量中添加：

   | 变量 | 值 |
   |---|---|
   | `ANTHROPIC_BASE_URL` | 上表对应的地址 |
   | `ANTHROPIC_AUTH_TOKEN` | 引用第 1 步保存的公司密钥 |
   | `ANTHROPIC_SMALL_FAST_MODEL` | 同一家的模型名（避免 Claude Code 的辅助调用去请求不存在的 Claude 模型） |
   | `DISABLE_AUTOUPDATER` | `1` |
   | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |

5. 给它分派一个简单任务验证可用。思考强度（effort）首期不设置，第三方接口不一定支持。

### 三条约束（必须遵守）

1. **每个数字员工自己配置**地址、密钥、模型名，密钥一律引用公司密钥，不写明文。
2. **服务器容器环境里不设置任何 `ANTHROPIC_*` 变量**。否则它会成为所有 agent 的默认值，漏配的 agent 会静默调错模型、扣错账户。`deploy.sh` 启动前会检查 `.env`，发现 `ANTHROPIC_` 开头的变量直接失败退出。
3. **共享的 `/paperclip/.claude/settings.json` 里不写 `ANTHROPIC_*`**，服务器上也不要执行 `claude login`。所有 `claude_local` agent 共用这个配置目录（research.md R8.3）。

### 切换模型

把某个数字员工从一家模型换到另一家后，旧的会话可能无法续接，在 agent 页面重置会话即可。

### 运行隔离

三类数字员工都作为 Paperclip 容器里的子进程运行，各有独立的工作区 `/paperclip/workspaces/<agentId>`，但**文件系统不隔离**（research.md R16）。`claude_local` 自带的 bubblewrap 文件沙箱实测可用，但需要派生镜像并放宽容器的两项安全加固（`seccomp=unconfined`、`systempaths=unconfined`），首期不开启。
