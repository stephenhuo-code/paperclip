# 数字员工平台使用手册

适用于部署在阿里云上的 Paperclip + Keycloak（`deploy/aliyun`）。示例中的域名、公司前缀请换成你的实际值：

| 示例 | 含义 |
|---|---|
| `https://agent.ai-datum.net` | Paperclip 地址（`APP_DOMAIN`） |
| `https://sso.ai-datum.net` | Keycloak 地址（`SSO_DOMAIN`） |
| `FIV` | 公司前缀（公司的 `issuePrefix`） |
| `fiveguys` | Keycloak 组织别名（`KEYCLOAK_ORG_ALIAS`） |

---

## 第一章 开通

### 1.1 用脚本设置公司和管理员账号

**前提**：平台已按 `deploy/aliyun/README.md` 完成首次发布，`https://agent.ai-datum.net` 能打开；你能以 root 登录 ECS。

**1. 运行引导脚本**

```sh
ssh root@<ECS 公网 IP>
cp -p /opt/paperclip/.env /opt/paperclip/.env.bak-$(date +%F)   # 先备份配置
/opt/paperclip/deploy/scripts/first-run.sh production
```

**2. 按提示输入**（密码输入时屏幕不显示，属正常；每个密码输两次，至少 12 位）

| 提示 | 填什么 |
|---|---|
| `== Keycloak admin` → `Username` / `Password` | 你自己的 **Keycloak 管理员**用户名和密码（字母、数字、`. _ @ -`），用于登录 Keycloak 管理台 |
| `== Paperclip admin` → `Name` / `Email` / `Emergency password` | Paperclip 管理员的姓名、邮箱、**应急密码** |
| `== Company` → `Company name` | 公司名称；已有公司时直接选用，有多家时输入编号 |
| `== The admin's enterprise account` → `Enterprise password` | 管理员**企业账号**的密码，**不能与应急密码相同** |
| `Proceed? [y/N]` | 核对上面列出的操作，输入 `y` 执行 |

已经完成的步骤会显示 `exists, skipped` 并跳过，不会重复创建，也不会改已有账号的密码。脚本最后会把公司关联到 Keycloak 组织、关闭邮箱注册，并重新部署（几分钟）。出现 `Done.` 即完成；再运行一次会显示 `Nothing to do`。

**3. 脚本创建的三个账号**

| 账号 | 用途 | 怎么登录 |
|---|---|---|
| Keycloak 管理员（如 `op-admin`） | 管理员工：新建账号、加入组织、分配角色 | `https://sso.ai-datum.net/admin/`，用户名 + 密码。**不能登录 Paperclip** |
| 管理员企业账号（用户名即管理员邮箱） | 日常登录 Paperclip，身份为公司 **owner** | Paperclip 登录页点**企业登录**，邮箱 + 企业密码 |
| 应急管理员（同一邮箱） | Keycloak 不可用时登录 Paperclip | Paperclip 登录页展开**管理员应急登录**，邮箱 + 应急密码 |

企业账号和应急管理员是同一个 Paperclip 账号，两种方式登录看到的内容相同。

**4. 验证**

用无痕窗口打开 `https://agent.ai-datum.net`，点企业登录，用管理员邮箱和企业密码登录，应进入公司。

**5. 之后添加员工**（在 Keycloak 管理台，不用脚本）

1. 用 Keycloak 管理员登录 `https://sso.ai-datum.net/admin/`，左上角选 realm **digital-workforce**。
2. **Users → Add user**：填用户名、邮箱，打开 **Email verified**，保存；在 **Credentials** 设置初始密码。
3. **Organizations → FiveGuys → Members**：把用户加入组织。
4. 需要让员工新建 agent 时：用户的 **Role mapping → Assign role**，筛选改为 **Filter by clients**，勾选 `paperclip` 下的 **agent-creator**。

员工首次企业登录即以普通员工（operator）加入公司。角色变更在员工下次登录时生效。owner/admin 不需要 `agent-creator`。

**常见问题**

| 现象 | 处理 |
|---|---|
| 脚本提示 `Keycloak is not ready` / `Paperclip is not healthy` | 等几分钟或检查 `docker compose ps` 后重新运行 |
| 脚本中途失败 | 排除原因后重新运行，已完成的步骤自动跳过 |
| 提示 `email sign-up is off` 且没有管理员 | 把 `/opt/paperclip/.env` 中 `PAPERCLIP_AUTH_DISABLE_SIGN_UP` 改为 `false`，重新部署后再运行 |
| Keycloak 管理员登录 Paperclip 失败 | 正常现象，见上表，用管理员邮箱登录 |
| 企业登录被拒（`org_not_allowed`） | 该用户不在组织 `fiveguys` 中，到 Keycloak 加入组织 |

---

### 1.2 开通第一个 agent 与新增 agent

**为什么一进来就是引导页**：公司还没有任何 agent 时，Paperclip 会把你带到引导页。建好第一个 agent 后进入主界面。也可以直接打开 `https://agent.ai-datum.net/FIV/agents/new` 新建。

**1. 选择模型接入方式**

镜像中预装了 Claude Code、Codex、Kimi Code 三个 CLI。国内模型推荐如下：

| 模型 | 运行方式（adapter） | 认证 | 状态 |
|---|---|---|---|
| **DeepSeek**（推荐先用） | Claude Code | DeepSeek API Key | 本地已验证 |
| Kimi（会员） | Kimi Code | 在 ECS 上 `kimi login` 登录 Kimi 账号 | 模型可用；默认 ACP 引擎下 agent 用命令行调用 Paperclip 时可能失败，见下文 |
| Kimi（按量） | Claude Code | Moonshot 开放平台 API Key | 未验证 |

**2. 用 DeepSeek 开通第一个 agent**

1. 在 DeepSeek 开放平台 `https://platform.deepseek.com` → **API keys** 创建 Key（只显示一次，先保存；账户需有余额）。
2. 打开引导页或 `https://agent.ai-datum.net/FIV/agents/new`，填 agent 名称（如 `CEO`）。
3. **Connect a model** 一步点 **Use API key instead**，选自定义网关（Messages API / Anthropic 兼容）：
   - Base URL：`https://api.deepseek.com/anthropic`
   - API Key：你的 DeepSeek Key
   - 模型：`deepseek-chat`（推理更强可选 `deepseek-reasoner`）
4. 运行方式选 **Claude Code**，点 **Test**，通过后 **Finish setup**。
5. 给它派一个任务，例如"介绍一下你自己"，确认它在任务中回复。

保存后这个连接成为公司共享连接，之后新建 agent 可直接选用，不必再填 Key。

**3. 用 Kimi 会员开通**

1. 在 ECS 上登录一次（按提示用浏览器登录 Kimi 账号；凭证保存在数据卷中，重启和发布后仍在）：

   ```sh
   docker exec -it -u node paperclip-paperclip-1 kimi login
   ```

2. 新建 agent：运行方式选 **Kimi Code**，模型填 `kimi-code/k3`，API Key 留空。
3. 测试中的 "No Kimi ACP credentials were detected" 是误报（检查只看环境变量，不认 `kimi login`），可以继续 **Finish setup**。
4. 已知问题：Kimi 默认使用 ACP 引擎，agent 改用命令行调用 Paperclip 接口时会因缺少 `PAPERCLIP_API_KEY` 失败；本地使用的 CLI 引擎正常，但 Kimi 的配置页目前没有切换引擎的选项。如遇到，先改用 DeepSeek。

**4. 新增 agent**

- **入口**：左侧 **Agents → New Agent**，或 `https://agent.ai-datum.net/FIV/agents/new`。接入方式同上，可直接选用已保存的连接。
- **谁能新建**：owner/admin 随时可以；普通员工需在 Keycloak 分配 `agent-creator` 角色（见 1.1 第 5 步）。
- **新建审批**：在 **Company Settings → General → Hiring** 打开 "Require board approval for new hires" 后，员工新建 agent 会生成申请，只有 owner/admin 能在 **Approvals** 页面批准或驳回。
- **谁能修改**：owner/admin 可以修改所有 agent；有 `agent-creator` 的员工只能修改自己创建的 agent，修改不需要审批。

---

### 1.3 修改登录页的平台名称和 logo

Paperclip 登录页和 Keycloak 登录页显示的名称与 logo 由部署配置决定，不在网页中设置：

1. 换 logo：用新图片替换仓库中的 `deploy/aliyun/branding/logo.png`（横版，高度不小于 64px）。
2. 改名称：修改 `deploy/aliyun/environments/production.env` 中的 `PAPERCLIP_BRAND_NAME`。
3. 提交并发布。发布后用无痕窗口打开 `https://agent.ai-datum.net` 确认；浏览器可能缓存旧 logo，强制刷新即可。

`PAPERCLIP_BRAND_NAME` 留空时两个登录页恢复 Paperclip 和 Keycloak 的默认样子。

### 1.4 新增组织

另一个组织（例如另一家客户）要使用平台时，在服务器上运行：

```sh
cp -p /opt/paperclip/.env /opt/paperclip/.env.bak-$(date +%F)   # 先备份配置
/opt/paperclip/deploy/scripts/first-run.sh production --add-org
```

按提示输入：

| 提示 | 填什么 |
|---|---|
| Organization alias | 组织别名，只能用小写字母、数字和 `-`，如 `beta`；不能用首个组织的别名 |
| Organization name | 组织名称，如 `Beta 科技`（Keycloak 中已有该别名的组织时不问） |
| Email domain | 该组织员工的邮箱域名，如 `beta.com`；已被其他组织使用时脚本报错退出 |
| Company name | Paperclip 中的公司名称；已有同名公司时可选"使用已有"或"新建" |
| Proceed? | 核对汇总后输入 `y` |

脚本用 `.env` 中的写回账号（2.5）登录 Paperclip 建公司，**不需要输入密码**；写回账号缺失或登录失败时才提示输入应急密码（最多 3 次，错误时不做任何改动）。新公司的 owner 是实例管理员。完成后自动重新部署，原有组织的关联保持不变。可重复运行，已完成的步骤会跳过。

脚本结束后还要做三件事：

1. **加员工**：在 Keycloak 管理台把该组织的员工加入新组织（同 1.1 第 5 步）。
2. **指定负责人**：负责人企业登录一次后，在 Paperclip 切换到新公司，**Settings → Members** 中把负责人设为管理员。
3. **建网关连接**：AI 连接按公司隔离，新公司看不到原公司的网关连接。切换到新公司，按 2.3 建一个 Messages API 连接（Provider URL 同为 `https://llm.ai-datum.net`，可以用同一个网关 Key）。之后该公司的 agent 选这个连接即自动计费（2.4）。

---

## 第二章 模型网关：统一接入与计费

所有模型都经过模型网关（LiteLLM）接入：上游 Key 只放在网关里，单价在网关里设置；每次调用的花费按运行写回 Paperclip，记到 agent、任务和项目上，由 Paperclip 的预算控制（specs/006）。

| 地址 | 用途 |
|---|---|
| `https://llm.ai-datum.net/ui` | 网关管理界面（只允许管理员网段访问） |
| `https://agent.ai-datum.net` | Paperclip，照常使用 |

### 2.1 第一次登录网关

1. 打开 `https://llm.ai-datum.net/ui`。用户名 `admin`，密码为服务器 `/opt/paperclip/.env` 中 `LITELLM_MASTER_KEY` 的值**前面加 `sk-`**。
2. **Internal Users → Invite User**：填自己的邮箱，角色选 Admin，复制显示的邀请链接，用无痕窗口打开并设置密码。以后用这个账号登录。

### 2.2 添加模型和单价

1. **Models + Endpoints → Add Model**：
   - **Provider** 选 **Anthropic**；
   - **LiteLLM Model Name(s)** 选第一项 **Custom Model Name (Enter below)**，在下面的输入框填上游的模型名；
   - **Model Mappings** 自动生成一行，**Public Model Name** 就是 Paperclip 中选的模型名（不要手动改，要改名在添加后到模型详情里改）；
   - **Upstream API Base**、**API Key** 按下表填写，先点 **Test Connect**，通过后点 **Add Model**。

   | 服务 | 上游模型名 | API Base |
   |---|---|---|
   | DeepSeek（按量） | `deepseek-flash`、`deepseek-v4-pro` | `https://api.deepseek.com/anthropic` |
   | Kimi 会员 | `kimi-for-coding`、`k3`、`k3-256k` | `https://api.kimi.com/coding` |
   | MiniMax 编程套餐 | `MiniMax-M3`、`MiniMax-M3.1-Flash-Preview` | `https://api.minimaxi.com/anthropic` |

2. 打开模型详情 → **Model Settings → Pricing**，填四个单价（美元 / 百万 token）：输入、输出、缓存命中、缓存写入。
   - **缓存命中、缓存写入一定要填**：留空会按输入单价计费。
   - 会员 / 套餐类填"等价单价"，用于预算。
   - **没有填单价的模型不能调用**：agent 运行会失败并提示"模型未设单价"。
3. 改单价立即生效，只影响之后的调用。
4. 建议为会员 / 套餐类模型配置备用模型（额度用完时自动改用）：**Settings → Router Settings → Fallbacks → Add Fallbacks**。

### 2.3 在 Paperclip 中建网关连接（只做一次）

1. 网关 **Virtual Keys → Create New Key**，名称如 `paperclip`，模型选全部；复制 Key（只显示一次）。
2. Paperclip **Connectors → Browse → Paperclip** 标签，找到 **Messages API**，点 **Connect**（已有网关连接时为 **Add account**）：
   - **Provider URL**：`https://llm.ai-datum.net`（必须与部署配置的网关地址 `PAPERCLIP_GATEWAY_URL` 一致）
   - **API key**：上一步的网关 Key
   - **Model IDs (comma separated)**：网关中的 Public Model Name，用英文逗号分隔，例如 `deepseek-flash, deepseek-v4-pro, kimi-for-coding, MiniMax-M3`。**建好后不能修改**，以后加了新模型可在 agent 的模型框中直接输入
   - 访问范围：**Any agent**
3. 连接名称随意，不需要改名：地址是网关地址的连接都会被识别为网关连接。
4. 保存后进入这个连接的页面，建议加书签。要替换网关连接时：**先建新的，再撤销旧的**（Messages API 下一个有效连接都不剩时，Paperclip 会把它归档，之后新建的连接在 Connectors 中看不到，见 2.7）。

### 2.4 让 agent 使用网关

新建或修改 agent，在 **Harness / Runtime** 中：

1. **Adapter type** 选 **Claude Code**；
2. **Connection** 选网关连接（后面带 "Reconnect" 的是已失效的，不要选）；
3. **Model** 选网关中的模型；
4. 保存。

**其他都自动完成**：约 30 秒内系统为它设置带运行标识的启动命令，之后每次调用的花费都会写回 Paperclip。以下情况不会自动设置，花费也不会写回：执行引擎选了 **Claude CLI**、自己填写过 **ACP server command**、或不是 Claude Code。

### 2.5 写回账号（只做一次）

写回程序用 Paperclip 应急管理员登录并写入费用。在服务器 `/opt/paperclip/.env` 中加入：

```
PAPERCLIP_SYNC_EMAIL=63592990@qq.com
PAPERCLIP_SYNC_PASSWORD=<应急密码>
```

然后重新发布一次。账号缺失、登录失败或网关地址未配置时，**发布日志**（GitHub Actions 中的部署步骤）会出现 `warning: gateway-sync …` 并说明处理办法；发布本身不受影响。

### 2.6 查看花费与预算

- Paperclip **Audit → Costs**：服务商显示为 `litellm`，按 agent / 项目汇总；**Budgets** 中的公司 / agent / 项目预算按这些花费预警和暂停。
- 花费在调用后 1 分钟左右写回。
- 网关界面 **Usage / Logs** 可看到每一次调用。没有运行标识的调用（如新建 agent 时的连接检查）只在网关里可见，不写回 Paperclip；写回程序每小时在日志中汇总这部分"未归属"金额，并列出"不经网关"的 agent。

### 2.7 常见问题

| 现象 | 处理 |
|---|---|
| agent 运行报"模型未设单价" | 到网关为该模型填写单价 |
| 保存 agent 时提示 "failed validation" | 网关 **Logs** 中看失败原因：模型名与网关不一致、未设单价、网关 Key 不允许该模型、上游地址或 Key 有误 |
| 运行报 "Reconnect or validate the selected AI account" | agent 选的连接已失效：在 **Harness / Runtime** 重新选有效的网关连接 |
| 连接显示 "Sign in again to restore this AI connection" | 上游返回了认证或额度错误（如 Kimi 5 小时额度用完）：先在网关 **Logs** 查原因并处理，再点 **Reconnect** 重新填网关 Key |
| 费用页没有 `litellm` 的费用行 | 网关 **Logs** 中该调用的 Tags 应有 `paperclip-run:…`；没有说明 agent 不符合 2.4 的条件；有则检查发布日志中的 gateway-sync 警告 |
| Connectors 中看不到新建的网关连接（agent 中能选） | Messages API 应用被 Paperclip 归档了。在服务器执行：`docker exec paperclip-postgres-1 psql -U postgres -d paperclip -c "update tool_applications set status='active', archived_at=null, updated_at=now() where application_key='app-gallery:messages-api' and status='archived';"` |
| 上游 Key 更换 | 网关模型详情 → **Update API Key**，Paperclip 不用改 |
