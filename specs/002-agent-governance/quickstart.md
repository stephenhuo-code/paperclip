# Quickstart: 数字员工的管控

```sh
pnpm test -- server/src/__tests__/company-admin.test.ts \
  server/src/__tests__/agent-hire-approval-admin.test.ts \
  server/src/__tests__/auth-oidc.test.ts \
  server/src/__tests__/better-auth-oidc.test.ts
deploy/aliyun/tests/keycloak-provision-test.sh
deploy/aliyun/tests/sso-e2e/run-all.sh
deploy/aliyun/tests/stack-smoke/stack-smoke.sh <tag>
```

预期：全部通过，覆盖 [spec](./spec.md) 的验收场景（含重启后权限不恢复）。
