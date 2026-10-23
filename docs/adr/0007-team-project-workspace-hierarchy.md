# ADR-0007：团队、项目与项目工作台采用明确层级

- 状态：Accepted
- superseded_by: null
- 日期：2026-08-14

## 背景

早期 MVP 将 `members` 同时用于“团队成员”和“项目成员”，Web 又把全库任务列表称为“团队看板”。这会导致三个问题：团队无法独立创建；项目没有团队归属；任务、需求、缺陷和文档容易跨项目混合展示。

## 决策

采用以下层级：

1. `users` 是全局登录身份。
2. 用户可以创建 `teams`，创建者成为 `team_members.owner`。
3. `projects.team_id` 必填；只有团队 Owner 可以在团队下创建项目。
4. 历史 `members` 表继续表示项目成员，避免破坏任务闭环；权限检查必须同时匹配 `principal_id + project_id`。
5. Web 顶层入口是团队与项目列表。用户点击项目后进入 `#/projects/:projectId/:section` 项目工作台。
6. 任务、Feature、需求、缺陷、编排、验收和文档均按 `project_id` 查询和展示。
7. `artifacts` 显式携带 `project_id`，`task_id` 可空；没有任务的文档、原型和报告可以直接登记为项目产物。

## 迁移与兼容

- 既有项目迁移到 `TEAM-LEGACY`。
- 既有项目成员去重后迁移为 `TEAM-LEGACY` 团队成员；在任一旧项目为 Owner 的用户迁移为团队 Owner。
- 既有任务产物通过 `artifact.task_id → task.feature_id → feature.project_id` 回填项目归属。
- CLI `project init` 暂以 `TEAM-LEGACY` 为默认团队；新的 `project create` 必须显式提供 `--team`。

## 后果

项目成为所有研发协作数据的查询边界。团队负责人员与项目集合，项目成员负责项目内执行权限。后续增加组织、团队管理员或跨项目汇总时，不应再把项目成员表复用为团队模型。
