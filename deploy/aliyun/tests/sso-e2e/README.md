# SSO 端到端验证（本地真实 Keycloak）

用真实的 Keycloak 26 和一个独立的 Paperclip 实例，自动走完浏览器式 OIDC 登录（cookie、跳转、Keycloak 两步登录表单、回调），并用 API 和数据库核对结果。对应 quickstart.md 场景 2~4、tasks.md T020。

```sh
# 1. 起依赖（端口：Keycloak 18080、PostgreSQL 55432）
docker run -d --name pc-sso-e2e-postgres -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=paperclip -p 127.0.0.1:55432:5432 postgres:17-alpine
docker run -d --name pc-sso-e2e-keycloak -p 127.0.0.1:18080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.8.0 start-dev
./keycloak-setup.sh                        # realm dw、组织 acme、客户端 paperclip、用户 A/B（组织内）/C（组织外）

# 2. 未配置组织映射：应急管理员、认领实例、创建公司、验证 fail closed
./start-paperclip.sh &                     # Paperclip 监听 3199
node e2e.mjs setup                         # 输出 COMPANY_ID=...

# 3. 填写映射后重启，跑完整验证
kill %1; ./start-paperclip.sh '{"acme":"<COMPANY_ID>"}' &
node e2e.mjs verify <COMPANY_ID>

# 清理
kill %1; docker rm -f pc-sso-e2e-postgres pc-sso-e2e-keycloak
```

`start-paperclip.sh` 关闭了 better-auth 的登录频率限制（脚本会在短时间内多次登录）；生产环境保持开启。
