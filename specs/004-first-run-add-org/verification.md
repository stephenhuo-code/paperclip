# 验证记录：引导脚本新增组织

**日期**：2026-10-19 | **环境**：本地 `~/paperclip-local`（版本 bad8191bc，Keycloak 26.8.0）

## 自动测试

| 检查 | 结果 |
|---|---|
| `node --test deploy/aliyun/tests/first-run.test.mjs` | 35 通过（003 原有 13 个 + 004 新增 22 个） |
| `deploy/aliyun/tests/run.sh`（shellcheck、actionlint、全部部署测试） | 125 通过，deploy checks passed |
| `deploy/aliyun/tests/keycloak-provision-test.sh`（真实 Keycloak） | 全部 PASS；新增：按脚本参数建第二个组织成功、别名/名称/域名正确；已占用域名被拒，报错 `Domain example.cn is already linked to organization Acme in realm dw` |

## 本地实测（plan"测试与验证"第 4 步）

1. 备份 `.env`；本地没有 ECS 上的 `/opt/paperclip/bin/remote-deploy.sh`，放了一个调用 `deploy.sh local` 的替身。
2. `first-run.sh local --add-org`，输入 `beta` / `Beta Inc` / `beta.example.com` / `Beta` / `y`：
   - **未提示任何密码**（用 `.env` 写回账号登录）；
   - Keycloak 新建组织 `beta,Beta Inc,true,beta.example.com`；
   - Paperclip 新建公司 Beta，owner 为实例管理员 `admin@example.cn`；
   - 映射变为 `{"acme":"<原值>","beta":"<Beta 公司 id>"}`，原条目不变；
   - 重新部署当前版本成功，结束说明给出三步（含 `Provider URL https://llm.127.0.0.1.nip.io`）。
3. 企业登录：Keycloak 中建 `beta-check@beta.example.com`（加入 beta）和 `acme-check@example.cn`（加入 acme）。前者登录后只看到公司 **Beta**，后者只看到 **Acme Digital Workforce**。
4. 计费：在 Beta 公司建一个指向网关地址的 Messages API 连接（名称随意），新建 Claude Code agent 只选连接和模型 → 启动命令被自动设置为 `/usr/local/bin/claude-agent-acp-tagged`；运行一个任务后 6 条 `litellm` 费用写回到 **Beta**（3.9881 分，均带项目）。重新部署后 gateway-sync 即对 Beta 报"缺少网关连接"，建好后自动接入。

## 观察到的问题（不属于本 spec）

- 重新部署时，若 gateway-sync 恰好在 paperclip 重启期间跑了一轮，发布日志会出现一次 `warning: gateway-sync status unknown or failing: … fetch failed`；约 30 秒后下一轮恢复 `ok`。属 spec 006 的状态检查时机问题，未处理。

本地留下的测试数据：公司 Beta 及其中的验证 agent、项目、网关连接；Keycloak 组织 beta 和两个 `*-check` 用户。
