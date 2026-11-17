# ADR-0015：核心父子引用由数据库保证完整性

- 状态：Accepted
- 日期：2026-10-23
- superseded_by: null
- 局部取代：原 Schema 中“所有跨聚合关系均不声明 FK”的实现说明；不取代应用层鉴权、审计与软引用策略的其他部分。

## 决策

下列核心生命周期父子关系建立具名外键：

| 子列 | 父列 | 约束 |
|---|---|---|
| tasks.feature_id | features.id | fk_tasks_feature |
| members.project_id | projects.id | fk_members_project |
| features.project_id | projects.id | fk_features_project |
| runs.task_id | tasks.id | fk_runs_task |
| device_sessions.device_id | devices.id | fk_device_sessions_device |

均使用 `ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`。缺少父项的新增或更新被数据库拒绝。父项存在子项时不能删除；不得换成 CASCADE 来绕过业务生命周期、审计或历史保留。

显式 `SET CONSTRAINTS ... DEFERRED` 可用于同一事务内先写子项后写父项的合法编排，提交时必须完整。`RESTRICT` 删除动作依然即时执行，不能延期；删除必须先显式处理子项。当前 Drizzle foreignKey builder 不支持延迟属性，Schema 记录名称、两端列与删除/更新动作，延迟属性以 SQL 迁移和 catalog 行为回归为准。

其他可空、跨聚合弱关系继续保留软引用；数据库外键不能替代有效成员、租户/项目一致性、乐观版本或领域审计检查。后续增加约束需重新盘点存量数据并单独评审，不将本次五项扩散成全库 FK 或 RLS 决策。

## 分阶段上线

`0048_core_foreign_keys_expand` 首先只读盘点五关系；有任何孤儿即带关系名称和数量报错中止，不删除、不重挂、不伪造父项。零孤儿时安装 `NOT VALID` 约束，立即约束后续写入。重复执行仅接受同名且形状一致的约束。

`0049_core_foreign_keys_validate` 再次盘点并验证约束；孤儿仍使迁移中止。两文件都支持人工幂等重跑。上线前先备份并用只读巡检确认运行库；若失败，停止发布、保留现场，由数据负责人提供真实修复依据后重试。

## 验证与权衡

旧版迁移 fixture 建立真实项目、Feature、Task、Run、成员和设备会话，升级后保留其内容。回归覆盖 NOT VALID 阶段、手动重跑、全部 convalidated、23503 孤儿插入与父删除拒绝、显式延期及存量孤儿停止。

增加 FK 会暴露依赖孤儿数据或错误删除顺序的测试/脚本；应补齐真实父记录或调整显式删除顺序，不能关闭约束或弱化断言。约束添加/验证仍有 PostgreSQL DDL 锁与扫描成本，生产迁移须使用维护窗口和现有语句超时，不宣称无锁上线。
