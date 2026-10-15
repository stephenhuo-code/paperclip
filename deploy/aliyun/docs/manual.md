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
