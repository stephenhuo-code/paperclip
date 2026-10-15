# Verification: 首次部署初始化引导

日期：2026-10-15。

## TDD

| 组 | 先失败 | 实现后 |
|---|---|---|
| US1（T005–T009a，7 个用例） | 7/7 失败（脚本不存在） | 7/7 |
| US2（T013–T017a，6 个用例） | 6/6 失败 | 13/13 |
| 实测发现：`docker compose exec -T` 吞掉标准输入 | 假 `docker exec` 改为像真实 CLI 一样读走 stdin 后 10/13 失败 | 13/13 |
| 实测发现：Keycloak 26 要求 lastName | 断言 `lastName` 后 1 个失败 | 13/13 |

- `deploy/aliyun/tests/run.sh`（shellcheck + 全部部署测试）：通过。
- `deploy/aliyun/tests/keycloak-provision-test.sh`（真实 Keycloak 26.8.0）：全部 PASS，含新增"从标准输入设密码并登录"。

## 本地真实环境（全新实例，T023）

在 `~/paperclip-local` 备份数据卷后清空，部署全新实例（`bootstrap_pending`），运行 `first-run.sh local`：

- 五步执行成功；`.env` 写入 `{"acme":"<公司 ID>"}` 和 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`，权限 600。
- Keycloak 管理员 `ops-admin` 能登录，具有 master realm `admin` 角色。
- 应急密码登录：200，实例管理员 + 公司 owner。
- 企业账号登录：进入同一个账号，可见公司。
- 在 Keycloak 中新建员工并加入组织，首次企业登录即以 operator 加入公司（SC-002）。
- 再次运行：全部显示已完成，输出 "Nothing to do"，不重新部署（SC-003）。
- 结束后恢复了原数据卷、`.env` 和证书，原数据完整。

实测中发现并修复两个缺陷（见上表）。另：本地测试目录没有 `bin/remote-deploy.sh`（生产由 bootstrap.sh 安装），重新部署一步改用 `deploy.sh` 手动完成。

## 未运行

- 生产 ECS 上运行：待你推送发布后执行。
- 全量 `pnpm test:run`：本功能不改 Paperclip 代码，未运行。
