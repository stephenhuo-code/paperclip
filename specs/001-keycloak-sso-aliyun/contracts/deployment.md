# Contract: 阿里云部署

**Feature**: [../spec.md](../spec.md) | **Research**: [../research.md](../research.md) R9–R15

## 1. 环境配置文件

### `deploy/aliyun/environments/<env>.env`（入仓库，仅非敏感参数）

| 变量 | 示例 |
|---|---|
| `ENV_NAME` | `production` |
| `ALIYUN_REGION` | `cn-hangzhou` |
| `ECS_INSTANCE_ID` | `i-bp1...` |
| `ACR_REGISTRY` | `registry.cn-hangzhou.aliyuncs.com` |
| `ACR_REGISTRY_VPC` | `registry-vpc.cn-hangzhou.aliyuncs.com` |
| `ACR_NAMESPACE` | `digital-workforce` |
| `APP_DOMAIN` | `agents.example.cn` |
| `SSO_DOMAIN` | `sso.example.cn` |
| `KEYCLOAK_REALM` | `digital-workforce` |
| `KEYCLOAK_ORG_ALIAS` | `acme` |
| `OSS_BACKUP_BUCKET` | `oss://acme-paperclip-backup` |
| `OSS_ENDPOINT` | `oss-cn-hangzhou-internal.aliyuncs.com` |
| `ACME_EMAIL` | `ops@example.cn` |

新增环境 = 新增一份该文件（FR-020a），脚本和工作流不改。

### ECS 上的 `/opt/paperclip/.env`（不入仓库，权限 600，由 `bootstrap.sh` 生成）

`BETTER_AUTH_SECRET`、`PAPERCLIP_AGENT_JWT_SECRET`、`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`、`POSTGRES_PASSWORD`、`PAPERCLIP_DB_PASSWORD`、`KEYCLOAK_DB_PASSWORD`、`KC_BOOTSTRAP_ADMIN_PASSWORD`、`PAPERCLIP_AUTH_OIDC_CLIENT_SECRET`、`PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP`（首个公司创建后由管理员填写）。

`env.example` 列出全部键名与说明，值为空。

## 2. 脚本接口（`deploy/aliyun/scripts/`）

| 脚本 | 调用方式 | 行为 | 退出码 |
|---|---|---|---|
| `bootstrap.sh <env>` | 首次在 ECS 上手工执行一次 | 安装 Docker；挂载数据盘；生成 `.env`（已存在则跳过已有键）；`docker login` ACR（VPC 地址）；安装备份定时任务 | 0 成功；非 0 失败并说明原因 |
| `deploy.sh <env> <image-tag>` | 由云助手调用，也可手工执行 | 记录当前版本 → 拉取镜像 → 运行 `keycloak-config` 一次性任务 → `docker compose up -d` → 健康检查 → 成功则写入 `state/current`，失败则回滚到 `state/previous` | 0 成功；2 健康检查失败已回滚；1 其他错误 |
| `backup.sh <env>` | cron 每日 03:00 | `pg_dump -Fc` 两个库 + 打包 `/paperclip/instances/default/{data/storage,secrets}` → 上传 OSS；检查证书剩余有效期 < 7 天时以非 0 退出 | 0 成功；非 0 失败 |
| `restore.sh <env> <backup-date>` | 手工 | 停止服务 → 从 OSS 下载 → 恢复两个库和数据卷 → 启动 → 健康检查 | 0 成功；非 0 失败 |

健康检查判定（`deploy.sh`）：
- Paperclip：`GET https://<APP_DOMAIN>/api/health` 返回 200，`status == "ok"`，且 `commit` 等于本次镜像的 commit SHA。
- Keycloak：容器内 `GET http://localhost:9000/health/ready` 返回 200。
- 超时 10 分钟判定失败。

所有脚本**不得**打印 `.env` 中的值（`set -x` 禁用）。

## 3. Docker Compose 服务（`deploy/aliyun/docker-compose.yml`）

| 服务 | 镜像（均从 ACR VPC 地址拉取） | 对外端口 | 持久化 |
|---|---|---|---|
| `caddy` | `caddy:2` | 80、443 | `caddy-data` |
| `paperclip` | `paperclip:<tag>`（仓库 Dockerfile，production target） | 无（仅经 Caddy） | `paperclip-data:/paperclip` |
| `keycloak` | `keycloak:26.x.y` | 无（仅经 Caddy；9000 不暴露） | 无（数据在 PostgreSQL） |
| `postgres` | `postgres:17-alpine` | 无 | `pgdata` |
| `keycloak-config` | 与 `keycloak` 相同的镜像，运行 `keycloak/provision.sh` | 无 | 一次性任务，`restart: "no"` |

Caddy 路由：`APP_DOMAIN → paperclip:3100`，`SSO_DOMAIN → keycloak:8080`；`SSO_DOMAIN/admin` 仅允许配置的管理 IP 段访问（FR-027）。

## 4. CI 工作流（`.github/workflows/deploy-aliyun.yml`）

- **触发**：推送到 `deploy/production` 分支，或 `workflow_dispatch`（输入：`env`，默认 `production`）。
- **步骤**：
  1. 用仓库 `Dockerfile` 构建 `--target production`，设置 `PAPERCLIP_BUILD_COMMIT=${{ github.sha }}`。
  2. 推送到 `${ACR_REGISTRY}/${ACR_NAMESPACE}/paperclip:${{ github.sha }}`。
  3. 同步基础镜像（keycloak、postgres、caddy）到 ACR（已存在相同 tag 则跳过）。
  4. 调用阿里云云助手 `RunCommand`，执行 `/opt/paperclip/deploy/scripts/deploy.sh <env> <sha>`，轮询 `DescribeInvocationResults` 直到结束。
  5. 退出码非 0 时工作流失败（GitHub 自动通知）。
- **GitHub Secrets**：`ACR_USERNAME`、`ACR_PASSWORD`、`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`（RAM 用户仅授权 `ecs:RunCommand`、`ecs:DescribeInvocationResults`、`ecs:DescribeInvocations`）。
- 云助手命令内容只包含环境名和版本号，不包含任何密钥。

## 5. Paperclip 容器运行时环境（部署方案约定）

| 变量 | 值 |
|---|---|
| `PAPERCLIP_DEPLOYMENT_MODE` | `authenticated` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `public` |
| `PAPERCLIP_PUBLIC_URL` | `https://${APP_DOMAIN}` |
| `DATABASE_URL` | `postgres://paperclip:${PAPERCLIP_DB_PASSWORD}@postgres:5432/paperclip` |
| `PAPERCLIP_AUTH_OIDC_ISSUER` | `https://${SSO_DOMAIN}/realms/${KEYCLOAK_REALM}` |
| `PAPERCLIP_AUTH_OIDC_CLIENT_ID` | `paperclip` |
| `PAPERCLIP_AUTH_SESSION_TTL_SECONDS` | `86400` |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | 首次部署 `false`，应急管理员创建后改为 `true` |
| `PAPERCLIP_ANNOUNCEMENTS_ENABLED` | `false` |
| `NPM_CONFIG_REGISTRY` | `https://registry.npmmirror.com` |
| `DISABLE_AUTOUPDATER` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |

**禁止**在 Paperclip 容器环境中设置任何 `ANTHROPIC_*` 变量，也不得写入共享的 `/paperclip/.claude/settings.json`；模型地址、密钥、模型名只配置在各个 agent 上（research R8.3）。`deploy.sh` 启动前检查 `.env` 中不含 `ANTHROPIC_` 前缀的键，发现则失败退出。
