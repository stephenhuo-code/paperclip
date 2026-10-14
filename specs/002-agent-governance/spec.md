# Feature Specification: 数字员工的管控

**Feature Branch**: `feat/keycloak-sso`

**Created**: 2026-10-11

**Status**: Draft

**Input**: 新建 agent 只有管理员能审批；谁能新建 agent 由 Keycloak 角色决定；只有管理员能修改 agent 配置。2026-10-13 补充：创建人可以修改自己创建的 agent。

**Related**: [001](../001-keycloak-sso-aliyun/spec.md)

## Clarifications

### Session 2026-10-12

- Q: "只有管理员能修改 agent"是否包括修改技能？ → A: 不包括，员工仍可修改技能。
- Q: 暂停、终止、删除 agent 是否也只允许管理员？ → A: 不包括，只限修改配置；但终止待审批的 agent 等同驳回申请，只允许管理员。

### Session 2026-10-13

- Q: 创建人能否修改自己创建的 agent？ → A: 能，只限自己创建的；修改不需要审批，审批通过后也能改。
- Q: 创建人记在哪里？ → A: agent 表新增创建人字段（不依赖活动日志）；老 agent 在迁移时从活动日志补一次。

## 需要改的部分

1. **审批只归管理员**：只有 owner/admin 能批准、驳回新建 agent 的申请（包括要求修改、终止待审批的 agent），也只有他们能改"新建 agent 需要审批"开关。现在任何成员都可以。
2. **新建权限由 Keycloak 决定**：`paperclip` 客户端下新增角色 `agent-creator`。普通员工（operator）每次企业账号登录时，有这个角色就能新建 agent，没有就不能。现在所有普通员工默认都能新建。
3. **只有管理员和创建人能修改 agent 配置**：普通员工登录时收回修改所有 agent 配置的权限；但仍有 `agent-creator` 角色的员工可以修改自己创建的 agent，不需要审批。现在所有普通员工默认都能修改所有 agent。

owner/admin 不受影响，仍由 owner 在 Paperclip 中设置。

范围外：修改 agent 技能；暂停、恢复、终止（已审批的）、删除 agent；agent 修改自己的配置。这些保持 Paperclip 现状。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 只有管理员能审批新建 agent (Priority: P1)

**Acceptance Scenarios**:

1. **Given** 有待审批的新建申请，**When** 普通员工批准、驳回、要求修改或终止该 agent，**Then** 被拒绝，申请状态不变。
2. **Given** 同上，**When** owner/admin 批准，**Then** agent 被创建。
3. **Given** 审批开关已开，**When** 普通员工关闭开关，**Then** 被拒绝；改公司其他设置不受影响。

### User Story 2 - 新建由 Keycloak 角色决定，修改配置归管理员 (Priority: P2)

**Acceptance Scenarios**:

1. **Given** 普通员工 A 有 `agent-creator`、B 没有，**When** 两人登录，**Then** A 能新建 agent，B 不能；两人都不能修改别人创建的 agent 配置。
2. **Given** 去掉 A 的角色，**When** A 重新登录，**Then** A 不能新建。
3. **Given** owner/admin，**When** 登录，**Then** 权限不变。
4. **Given** 平台重启，**Then** 已收回的权限不会恢复。

### User Story 3 - 创建人可以修改自己创建的 agent (Priority: P3)

**Acceptance Scenarios**:

1. **Given** A 有 `agent-creator` 并直接创建了 agent X，**When** A 修改 X 的配置，**Then** 成功，不需要审批。
2. **Given** 开启审批，A 提交的申请被批准生成 agent Y，**When** A 修改 Y 的配置，**Then** 成功。
3. **Given** agent Z 由别人创建，**When** A 修改 Z，**Then** 被拒绝。
4. **Given** A 的 `agent-creator` 角色被去掉并重新登录，**When** A 修改 X，**Then** 被拒绝。

### Edge Cases

- 令牌里没有角色：按没有角色处理，登录照常完成。
- 角色变更在下次企业账号登录时生效；owner 在 Paperclip 中调整员工角色或权限后，也在其下次登录时按本规则重新同步。
- 应急管理员用密码登录，不受影响。
- 本功能上线前创建的 agent，升级时从当时的创建记录补上创建人；查不到记录的，只有管理员能改。
- 待审批的 agent 配置本来就不能改（Paperclip 现有规则），批准后创建人才能改。

## Requirements *(mandatory)*

- **FR-001**: 只有 owner/admin（及实例管理员）能批准、驳回、要求修改新建 agent 申请，能终止待审批的 agent，能改审批开关。
- **FR-002**: 普通员工登录时，按 `agent-creator` 角色授予或收回新建权限，并收回修改权限；不动其他权限。
- **FR-003**: 平台重启后，收回的权限不得恢复。
- **FR-004**: 部署流程自动在 Keycloak 中创建角色，可重复执行。
- **FR-005**: 不新增配置项和界面改动；数据库只为 agent 新增创建人字段（US3）。
- **FR-006**: 平台记录每个 agent 的创建人。仍有 `agent-creator` 角色（即有新建权限）的普通员工可以修改自己创建的 agent 的配置，包括指令；不能修改别人创建的 agent。创建人不能通过修改 agent 被改写。

## Success Criteria *(mandatory)*

- **SC-001**: 上述三个用户故事的验收场景全部通过。
- **SC-002**: 部署后无需手工配置 Keycloak，即可给员工分配角色。
