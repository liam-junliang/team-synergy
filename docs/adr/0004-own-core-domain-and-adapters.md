# ADR-0004：自持有核心领域，外部系统通过 Adapter 集成

- 状态：Accepted
- superseded_by: null
- 日期：2026-08-12

## 背景

Beads、GitHub Issues、Agent Orchestrator、Plane 等项目分别覆盖任务图、代码协作、本地 Session 或传统项目管理。它们可以显著降低实现成本，但没有一个系统完整表达本项目的 Feature Context、Run 身份、Workspace、Proposal/Decision 和 Artifact/Evidence 语义。

## 决策

平台自持有以下权威模型和状态转换：

- Project、Feature、Task、Run、Workspace。
- Feature Context Pack 和 Snapshot。
- Proposal、Decision、Artifact、Evidence。
- Principal、Device、Agent Profile 和 Run Credential 映射。

MVP 使用自有最小 Task Store。外部能力通过 Ports/Adapters 集成：

- GitHub Issues/Projects：任务导入、链接或同步。
- Beads：任务 DAG、Ready/Claim 和本地记忆实验。
- Agent Orchestrator：本地 Session/Worktree 集成实验。
- Git/CI：代码和验证事实采集。

外部对象必须保存映射、来源和同步版本；外部变更不能绕过 Core 状态机直接成为已生效项目事实。

## 结果

正面影响：

- 平台差异化和审计语义不受外部工具生命周期影响。
- 团队可以继续使用已有项目管理和 Agent 工具。
- Adapter 可以按用户场景逐步增加。

代价：

- 需要实现一个小而完整的核心 Schema。
- 双向同步会出现冲突，需要在 P1 单独设计版本和所有权规则。

## 被否决的方案

### 直接以 Beads/Dolt 作为平台核心数据库

它擅长 Agent 任务图和版本化同步，但平台仍需补齐多租户权限、正式决策、Artifact/Evidence 和 Run 审计。

### Fork Agent Orchestrator 作为完整平台

其本地 Agent Session 和 PR/CI 闭环很有价值，但产品边界不等于跨人的项目共同状态控制面。

### 第一版重做 Jira/Linear

传统项目管理不是平台差异化，且会显著扩大 MVP。

