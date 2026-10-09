# Quickstart: 端到端验证指南

**Feature**: [spec.md](./spec.md) | **Contracts**: [auth-oidc](./contracts/auth-oidc.md)、[deployment](./contracts/deployment.md)

本指南用于证明功能可用，不包含实现代码。场景 1~4 在本机完成，场景 5~8 在阿里云生产环境完成。

## 前置条件

- 本机：Docker Desktop、Node 24、pnpm；仓库位于 `feat/keycloak-sso` 分支。
- 阿里云：已备案域名（两个子域名的 DNS 指向 ECS 公网 IP）；ECS（中国大陆地域）；ACR 个人版命名空间；OSS 备份桶；一个只授权云助手的 RAM 用户。
- DeepSeek、MiniMax、Kimi 各自的 API Key。

## 0. 单元测试

```sh
pnpm test -- server/src/__tests__/auth-oidc.test.ts
```

**预期**：配置解析（缺项、映射无效时启动失败）、组织准入（列表与对象两种声明格式）、自动入公司（新建写活动日志、已存在不改角色）全部通过。

## 1. 本地起全栈

```sh
cd deploy/aliyun
cp env.example .env.local   # 填写本地测试值
docker compose --env-file .env.local up -d
```

本地用 `agents.localhost` 和 `sso.localhost`（Caddy 内部证书）。

**预期**：`curl -k https://agents.localhost/api/health` 返回 `status: "ok"` 且 `auth.oidc.enabled: true`；Keycloak 中 realm、组织 `acme`、客户端 `paperclip` 已由 `keycloak-config` 自动创建。

## 2. 首个管理员与应急登录（FR-009、FR-022）

1. `deploy/aliyun/scripts/bootstrap-invite.sh <env>` → 得到一次性邀请链接（本地全栈见 `deploy/aliyun/tests/stack-smoke/stack-smoke.sh`，它自动完成这一步）。
2. 用邮箱密码注册应急管理员并接受邀请，创建第一个公司，记下公司 ID。
3. 把 `{"acme":"<公司ID>"}` 写入 `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP`，并设 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`，重启 `paperclip`。

**预期**：登录页的注册入口消失；应急管理员仍能在"管理员应急登录"中用密码登录。

## 3. 两名组织用户单点登录并使用数字员工（US1、US2）

1. 在 Keycloak 中创建用户 A、B（勾选邮箱已验证），加入组织 `acme`；再创建不在任何组织中的用户 C。
2. A、B 分别在两个浏览器中点击"使用企业账号登录"。
3. A 给某数字员工建一个公开任务和一个私有任务。

**预期**：
- A、B 无需注册即进入同一公司，角色为普通成员；活动日志各有一条 `company_membership.sso_joined`。
- B 能看到 A 的公开任务（创建者显示 A），看不到 A 的私有任务（直接访问返回 404）。
- C 登录被拒绝，显示"您的账号未被授权访问此平台"，数据库中没有 C 的用户记录。
- 退出登录返回成功、不报错。

## 4. 准入撤销与角色保持（US3）

1. 应急管理员把 B 设为公司管理员；B 退出后重新登录。
2. 在 Keycloak 中把 A 移出组织 `acme`；A 退出后重新登录。

**预期**：B 仍是管理员（未被覆盖）；A 被拒绝登录。

## 5. 阿里云首次部署（US4，SC-005）

1. 按 `deploy/aliyun/README.md` 准备阿里云资源，在 ECS 上执行一次 `bootstrap.sh production`。
2. 在 GitHub 上手动触发 `deploy-aliyun` 工作流。
3. 在生产环境重复场景 2 的第 1~3 步。

**预期**：全程不手工登录服务器执行部署命令（bootstrap 除外），2 小时内可通过 `https://<APP_DOMAIN>` 完成 Keycloak 登录；证书有效。

## 6. 日常发布与回滚（SC-006、SC-007）

1. 推送一个小改动到 `deploy/production` 分支。
2. 推送一个故意让健康检查失败的版本（例如启动时退出）。

**预期**：第 1 次 20 分钟内上线，`/api/health` 的 `commit` 等于新 SHA，数据完整；第 2 次工作流失败并通知，线上保持上一版本，中断不超过 5 分钟。

## 7. 备份与恢复（FR-019、FR-019a、FR-026）

1. 手工执行 `backup.sh production`，在 OSS 中确认当天的两个数据库备份和数据卷归档。
2. 在一台临时 ECS 上执行 `restore.sh production <日期>`。

**预期**：恢复后能用 Keycloak 登录，原有公司、数字员工、任务和附件完整。

## 8. 三家模型的数字员工（FR-011a，SC-002a）

1. 在公司密钥中保存三家的 API Key。
2. 创建三个 `claude_local` 数字员工，分别设置 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（引用密钥）和模型名（见 research R8）；Kimi 也可改用 `kimi_local`。
3. 给每个数字员工分派一个简单任务（如"总结这段文字"）。

**预期**：三个任务都成功完成；故意填错其中一个的 Key，该任务明确失败并显示原因，其他两个不受影响。
