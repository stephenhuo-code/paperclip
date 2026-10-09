# Contract: OIDC 登录（Keycloak）

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

## 1. 服务端配置项（环境变量）

| 变量 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `PAPERCLIP_AUTH_OIDC_ISSUER` | 启用 OIDC 时必填 | `https://sso.example.cn/realms/digital-workforce` | Keycloak realm URL；三个必填项同时存在才启用 OIDC |
| `PAPERCLIP_AUTH_OIDC_CLIENT_ID` | 同上 | `paperclip` | |
| `PAPERCLIP_AUTH_OIDC_CLIENT_SECRET` | 同上 | （密钥） | 不得出现在日志中 |
| `PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP` | 同上 | `{"acme":"5facf42d-..."}` | 见 data-model §2；缺失或为空时拒绝所有 OIDC 登录 |
| `PAPERCLIP_AUTH_OIDC_LABEL` | 否 | `使用企业账号登录` | 登录按钮文案，默认 `Sign in with SSO` |
| `PAPERCLIP_AUTH_SESSION_TTL_SECONDS` | 否 | `86400` | 不设置时保持 better-auth 默认（7 天） |

现有变量的约定用法：
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`，`PAPERCLIP_DEPLOYMENT_EXPOSURE=public`
- `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`（应急管理员创建后打开；只禁止邮箱密码注册，不影响 OIDC 建号）

启动校验：三个必填项只配置了一部分，或映射 JSON 无效时，服务**启动失败**并给出明确错误（不静默降级）。

## 2. HTTP 接口

除 `/api/health` 新增字段外，以下端点全部由 better-auth 提供，Paperclip 不新增路由。

### `GET /api/health`（新增字段）

匿名可访问。启用 OIDC 时：

```json
{
  "status": "ok",
  "deploymentMode": "authenticated",
  "auth": {
    "oidc": { "enabled": true, "providerId": "keycloak", "label": "使用企业账号登录" }
  }
}
```

未启用时 `auth.oidc` 为 `{ "enabled": false }`。**不得**包含 issuer、client id、映射表等配置细节。

### `POST /api/auth/sign-in/social`

请求：

```json
{ "provider": "keycloak", "callbackURL": "/STE/dashboard", "errorCallbackURL": "/auth?error=sso" }
```

响应 `200`：`{ "url": "https://sso.example.cn/realms/.../auth?...", "redirect": true }`，前端执行 `window.location.href = url`。

### `GET /api/auth/callback/keycloak`

Keycloak 回调，必须在 Keycloak 客户端的 Valid Redirect URIs 中登记为 `https://<平台域名>/api/auth/callback/keycloak`。

| 结果 | 行为 |
|---|---|
| 成功 | 设置会话 cookie，`302` 到 `callbackURL` |
| 组织不在映射中 | 不建账号、不建会话，`302` 到 `errorCallbackURL`，`error=org_not_allowed` |
| 缺少 email | 同上，`error=email_required` |
| state 无效/过期 | 同上，better-auth 原生错误码 |

### `POST /api/auth/sign-out`

authenticated 模式下由 better-auth 处理，返回 `200 {"success": true}`。不跳转 Keycloak 登出（单点登出不在范围内）。

## 3. 登录页 UI 契约（`ui/src/pages/Auth.tsx`）

- `auth.oidc.enabled === true`：
  - 主按钮显示 `auth.oidc.label`，点击调用 `POST /api/auth/sign-in/social`。
  - 邮箱密码表单折叠在"管理员应急登录"展开区内；注册入口隐藏。
  - URL 带 `error=org_not_allowed` 时显示："您的账号未被授权访问此平台，请联系管理员"。
  - URL 带其他 `error` 时显示："企业登录失败，请重试"。
  - `sign-in/social` 请求失败（Keycloak 不可达等）时显示："企业登录服务暂时不可用"，不出现空白页或无限加载。
- `auth.oidc.enabled === false`：页面与上游完全一致。

## 4. Keycloak 端契约（由 `deploy/aliyun/keycloak/realm.yaml` 保证）

- realm 启用 Organizations；存在别名与映射键一致的组织。
- 客户端 `paperclip`：confidential，Standard Flow 开启，PKCE S256，Redirect URI 见上文，Web Origin 为平台域名。
- 客户端默认 scope 包含 `openid profile email organization`。
- 用户的 `email_verified` 由管理员创建时勾选。
