# Feature Specification: 模型网关统一接入与按运行计费

**Feature Branch**: `feat/keycloak-sso`

**Created**: 2026-10-17

**Status**: 已上线（2026-10-19，阿里云生产；提交 `442bb9c32`、`0144a7e5e`、`4991854de`）

**Input**: 采用验证过的方案②：所有模型经一个模型网关（LiteLLM）统一接入；网关有管理界面和访问地址，在界面中设置每个模型的单价；每次模型调用带上 Paperclip 的运行和任务标识，网关按单价计费，再按运行写回 Paperclip，由 Paperclip 现有的公司 / agent / 项目预算执行。上游看到的是实际调用方（Claude Code）的标识。不修改 Paperclip 代码。

**Related**: 验证记录 [deploy/aliyun/experiments/litellm-verify/REPORT.md](../../deploy/aliyun/experiments/litellm-verify/REPORT.md)

## Clarifications

### Session 2026-10-17

- Q: 调用了未设单价的模型怎么办？ → A: 拒绝调用；网关中只能使用设了单价的模型。
- Q: 没有运行标识的调用（共用一个网关 Key 时无法确定 agent）如何处理？ → A: 不写回 Paperclip，在网关中可见，每小时汇总"未归属"金额。
- Q: agent 怎么接入网关？ → A: 自动补齐。管理员照常在 Paperclip 中新建 / 修改 agent，并选择网关连接和模型；后台定时检查只为"选了网关连接、启动命令为空的 Claude Code agent"补上带运行标识的启动命令。已有自定义（启动命令已填写、选了别的连接、或不是 Claude Code）的 agent 一律不改，只在报告中列为"不经网关"。

## 现状与要改的部分

- 各 agent 分别直连 DeepSeek、Kimi 等服务，上游 Key 分散在各处，Paperclip 统计的费用为 0 或不准（工具按 Anthropic 价格自报，或被当成订阅记 0），预算无法真正控制花费。
- 验证结论：Paperclip 每次运行都会把运行和任务标识交给 agent 进程；经网关并按运行打标签后，花费可 100% 对应到运行和项目；写回 Paperclip 后，现有项目预算能正常预警和暂停。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 所有模型经网关统一接入 (Priority: P1)

平台管理者在网关中接入所有模型服务（按量付费的 API、会员 / 套餐的 Key），Paperclip 的 agent 只连接网关，不再各自持有上游 Key。

**Independent Test**: 网关中接入 DeepSeek、Kimi 会员、MiniMax 套餐；在 Paperclip 中为三个 agent 选用网关，各自完成一个任务。

**Acceptance Scenarios**:

1. **Given** 网关已接入某模型，**When** Paperclip 中的 agent 选用网关上的该模型并执行任务，**Then** 任务正常完成。
2. **Given** 上游 Key 只保存在网关中，**When** 查看 Paperclip 的 agent 配置和仓库，**Then** 看不到任何上游 Key。
3. **Given** 网关停止服务，**When** agent 执行任务，**Then** 运行失败并给出明确原因，不会改为直连上游。

### User Story 2 - 在网关界面设置模型与单价 (Priority: P1)

平台管理者通过网关的访问地址登录管理界面，添加模型、修改每个模型的单价（输入、缓存命中、缓存写入、输出，每百万 token，美元）。

**Independent Test**: 用浏览器打开网关地址并登录，把某模型的输出单价改为新值；之后该模型的下一次调用按新单价计费。

**Acceptance Scenarios**:

1. **Given** 平台管理者在允许的网段内，**When** 打开网关地址，**Then** 看到登录页，用管理员账号登录后可管理模型和单价。
2. **Given** 不在允许的网段内，**When** 打开管理界面，**Then** 被拒绝访问。
3. **Given** 修改了某模型的单价，**When** 之后发生调用，**Then** 按新单价计费；修改前的调用金额不变。
4. **Given** 会员 / 套餐类模型（如 Kimi 会员），**When** 设置单价，**Then** 填写"等价单价"，按此计费并计入预算。

### User Story 3 - 花费按运行写回 Paperclip 并执行预算 (Priority: P1)

每次模型调用都带有 Paperclip 运行和任务的标识。网关按单价计费，花费自动写回 Paperclip，记到对应的 agent、任务和项目上；Paperclip 现有的公司 / agent / 项目预算据此预警和暂停。

**Independent Test**: 给某项目设很小的月度预算，在该项目中让两个 agent 同时执行任务；几分钟内 Paperclip 费用页按项目显示网关计算的花费，项目超额后被暂停。

**Acceptance Scenarios**:

1. **Given** 同一 agent 同时执行多个任务，**When** 花费写回，**Then** 每笔花费归到正确的运行、任务和项目。
2. **Given** 项目 / agent / 公司设有预算，**When** 写回的花费达到预警比例或上限，**Then** Paperclip 按现有规则预警或暂停。
3. **Given** 写回中断后恢复，**When** 再次写回，**Then** 补齐遗漏，不重复计费。
4. **Given** 不带运行标识的调用（如连接检查），**When** 写回，**Then** 不写回 Paperclip（无法确定所属 agent）；金额在网关界面中可见，写回程序每小时在日志中汇总"未归属"金额。
5. **Given** 调用的模型没有设置单价，**When** agent 调用，**Then** 网关拒绝调用，agent 运行失败并提示该模型未设单价。

### User Story 4 - 上游看到真实调用方 (Priority: P2)

网关把调用方自己的客户端标识原样转给上游，上游看到的是 Claude Code，而不是网关。

**Acceptance Scenarios**:

1. **Given** Claude Code 经网关调用 Kimi，**When** Kimi 收到请求，**Then** 客户端标识与 Claude Code 直连时相同。
2. **Given** 其他客户端经网关调用，**When** 上游收到请求，**Then** 标识是该客户端自己的，网关不编造标识。

### User Story 5 - agent 接入网关 (Priority: P2)

管理员照常在 Paperclip 界面中新建或修改 agent，选择 Claude Code 运行方式、公司共享的网关连接和模型；带运行标识所需的启动命令由后台自动补上，不需要手工填写。已有的自定义配置不会被改动。

**Independent Test**: 新建一个选了网关连接、未填启动命令的 Claude Code agent，1 分钟内其启动命令被自动补上，之后运行的花费归到项目；另一个已填写自定义启动命令的 agent 保持不变，并出现在"不经网关"清单中。

**Acceptance Scenarios**:

1. **Given** Claude Code agent 选了网关连接、启动命令为空，**When** 定时检查运行，**Then** 补上带运行标识的启动命令。
2. **Given** agent 已填写自定义启动命令，或选了非网关连接，或不是 Claude Code，**When** 定时检查运行，**Then** 不做任何修改，并在报告中列为"不经网关"。
3. **Given** 新建 agent 后、启动命令补上之前就发生运行，**When** 写回，**Then** 这些花费按"未归属"处理（同 US3 场景 4）。
4. **Given** 现有直连的 agent（如 CFO、AI 情报员），**When** 管理员把它改为选择网关连接，**Then** 之后由定时检查补齐，纳入网关计费。

### Edge Cases

- 网关或其数据库重启：已记录的花费不丢失，写回从断点继续。
- 写回落后：Paperclip 中的花费与预算判断最多滞后几分钟；超额后可能多完成一两次调用。
- 单价为 0：允许，但 0 单价的模型不受网关自身的额度限制，也不占 Paperclip 预算，界面上需提示。
- 同一笔调用被重复写回：按调用唯一编号去重。
- 网关地址证书或网络故障：agent 运行失败并显示原因。
- 上游会员 / 套餐额度用尽：网关返回上游错误，agent 运行失败并显示原因。

## Requirements *(mandatory)*

- **FR-001**: 部署中增加一个模型网关服务，所有模型服务在网关中接入；上游 Key 只保存在网关（及服务器密钥文件）中。
- **FR-002**: 网关提供 HTTPS 访问地址和管理界面；管理界面仅允许管理员网段访问，并需要管理员登录。
- **FR-003**: 在管理界面中可以添加、修改、删除模型及其四个单价；修改即时生效，不需要重新部署。
- **FR-004**: Paperclip 的 agent 通过网关调用模型，每次调用都带上所属的运行和任务标识。全公司使用一个共享的网关连接。
- **FR-004a**: 后台定时检查（不超过 1 分钟一次）为"选了网关连接、启动命令为空的 Claude Code agent"补上带运行标识的启动命令；不修改任何已有自定义；"不经网关"的 agent 清单在报告中可见。
- **FR-004b**: 网关拒绝调用未设单价的模型。
- **FR-005**: 网关把调用方的客户端标识原样转给上游，不编造标识。
- **FR-006**: 网关按单价计算每次调用的花费，并记录 token 明细（输入、缓存命中、缓存写入、输出）。
- **FR-007**: 花费定期（不超过 1 分钟一次）写回 Paperclip，按运行对应到 agent、任务和项目；无运行标识的调用不写回，作为"未归属"每小时汇总到日志；写回可重复执行且不重复计费。
- **FR-008**: Paperclip 现有的公司 / agent / 项目预算按写回的花费执行，不修改 Paperclip 代码。
- **FR-009**: 网关、写回程序的运行状态可在部署健康检查中看到；任一故障在部署日志中有明确提示。
- **FR-010**: 网关的数据（模型、单价、花费记录）纳入每日备份。

## Key Entities

- **模型接入**：模型名、上游地址、上游 Key、四个单价。
- **调用花费记录**：调用编号、模型、token 明细、金额、运行标识、任务标识、调用方标识、时间。
- **Paperclip 费用记录**（已有）：由写回程序创建，关联 agent、运行、任务、项目。

## Success Criteria *(mandatory)*

- **SC-001**: 经网关的调用 100% 被计费；带运行标识的调用 100% 归到正确的项目。
- **SC-002**: 修改单价后 1 分钟内的新调用按新单价计费。
- **SC-003**: 花费在调用结束后 5 分钟内出现在 Paperclip 费用页和预算中。
- **SC-004**: 项目超出预算后，Paperclip 在花费写回后 5 分钟内暂停该项目。
- **SC-005**: Paperclip 代码零改动。

## Assumptions

- 平台由所有者本人使用；会员 / 套餐 Key 经网关使用的服务条款风险由所有者知悉并承担。
- 先支持 Claude Code 运行方式的 agent；Codex 等其他运行方式以后再接入。
- 单价以美元填写；会员 / 套餐类模型填写等价单价。
- Paperclip 自身记录的费用（工具自报或 0）保留不动，与写回的网关花费并存；预算以写回的花费为主要来源。
- 网关管理界面使用网关自带的管理员账号，不接入 Keycloak 单点登录。
