# SSO 端到端验证（本地真实 Keycloak）

用真实的 Keycloak 26 和一个独立的 Paperclip 实例，自动走完浏览器式 OIDC 登录（cookie、跳转、Keycloak 两步登录表单、回调），并用 API 和数据库核对结果。对应 quickstart.md 场景 2~4、tasks.md T020。

一键运行（自动创建并清理容器、独立的 Paperclip 实例目录；任何一项失败则退出码非 0；加 `KEEP=1` 保留容器）：

```sh
deploy/aliyun/tests/sso-e2e/run-all.sh
```

三个阶段：

1. **未配置组织映射**（`e2e.mjs setup`）：应急管理员注册并认领实例、创建公司；验证所有企业登录被拒绝（fail closed）。
2. **配置组织映射后**（`e2e.mjs verify`）：单点登录、自动入公司与默认权限、活动日志、组织外用户被拒、角色不被覆盖、资料同步、退出登录、移出组织后被拒、24 小时会话、已验证邮箱关联已有账号、未验证邮箱拒绝关联、应急管理员密码登录。
3. **关闭邮箱注册后**（`e2e.mjs signup-disabled`）：邮箱注册被拒绝，新组织成员仍可通过 SSO 建号，应急管理员仍可密码登录。

端口：Keycloak 18080、PostgreSQL 55432、Paperclip 3199。

`start-paperclip.sh` 关闭了 better-auth 的登录频率限制（脚本会在短时间内多次登录）；生产环境保持开启。
