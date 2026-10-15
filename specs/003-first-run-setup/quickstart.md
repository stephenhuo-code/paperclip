# Quickstart: 首次部署初始化引导

## 自动测试

```sh
node --test deploy/aliyun/tests/first-run.test.mjs
deploy/aliyun/tests/run.sh          # shellcheck + 全部部署测试
```

## 本地真实环境（全新实例）

1. 备份并清空 `~/paperclip-local` 的数据卷，按 001 的方式重新部署（`deploy.sh local <tag>`），得到没有管理员和公司的实例。
2. `PAPERCLIP_ROOT=~/paperclip-local ~/paperclip-local/deploy/scripts/first-run.sh local`，按提示输入。
3. 预期：
   - 用输入的 Keycloak 管理员登录 `https://sso.127.0.0.1.nip.io/admin/`；
   - 用应急密码登录 Paperclip，是实例管理员和公司 owner；
   - 用管理员同邮箱的企业账号登录，进入同一账号、同一公司；
   - 在 Keycloak 中新建一个组织成员，企业登录后进入公司；
   - 再运行一次脚本，全部显示已完成，不重新部署。
4. 恢复原数据卷。

## 生产（本次）

当前生产已有管理员和公司：运行脚本后应跳过这两步，只创建 Keycloak 管理员、管理员企业账号，并完成关联。
