# ADR-0006：以持续需求表驱动人负责的 Agent 交付

- 状态：Accepted
- superseded_by: null
- 日期：2026-08-12

## 背景

成员通常先与 Agent 讨论和修改需求，再拆分任务、分派给不同成员。若直接从对话创建 Agent Task，会混淆未经确认的想法、人的责任和 Agent 执行状态。

## 决策

- 讨论产生 Requirement Draft，不直接成为正式项目事实。
- 使用稳定 Requirement ID 和不可变 Requirement Revision 构成持续需求表。
- 只有已确认 Requirement Revision 可以作为 Task 基线。
- Task 分派给 Human Principal；该成员授权本地 Agent 通过 CLI Claim，Claim 创建 Run 和 Workspace。
- Builder 可以提交进度、阻塞、自测 Evidence、Artifact，并更新为 `self_tested` 或 `submitted`。
- Builder 不能自行更新为 `verified` 或 `closed`。
- Context Graph 作为 Requirement/Task 的辅助背景，不作为产品第一入口。

## 结果

需求可以持续新增、澄清、变更和追溯；不同成员可以使用各自 Agent，又共享同一需求与验收基线；自测成为结构化 Evidence。

代价是需要 Requirement Revision、Assignment 和 Claim 模型，并处理需求变更对活动 Task/Run 的影响。

## 被否决的方案

### 对话即需求文档

对话包含探索、反复和未确认假设，不适合作为执行基线。

### 任务直接分派给 Agent

Agent 工具和 Session 是可替换执行者，不能承担人的责任和审批权限。

### Builder 自测通过即任务完成

自测是提交证据，不等于按需求独立验收。

