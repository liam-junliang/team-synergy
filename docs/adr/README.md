# 架构决策记录

ADR 记录已经生效且会约束实现的架构选择。讨论材料和开源调研不能覆盖 Accepted ADR；发生变化时新增 ADR 取代旧决策，不静默改写历史。

| 编号 | 状态 | 决策 |
|---|---|---|
| [ADR-0001](0001-project-state-as-collaboration-center.md) | Accepted | 以项目共同状态为协作中心 |
| [ADR-0002](0002-logical-two-plane-modular-monolith.md) | Accepted | 逻辑双平面，MVP 采用模块化单体 |
| [ADR-0003](0003-protocol-boundaries.md) | Accepted | 明确 CLI、MCP、Agent Client Protocol、A2A 和 AG-UI 边界 |
| [ADR-0004](0004-own-core-domain-and-adapters.md) | Accepted | 自持有核心领域，外部系统通过 Adapter 集成 |
| [ADR-0005](0005-versioned-project-context-graph.md) | Accepted | 使用版本化项目上下文图连接业务与实现 |
| [ADR-0006](0006-requirements-led-human-accountable-delivery.md) | Accepted | 以持续需求表驱动人负责的 Agent 交付 |
| [ADR-0007](0007-team-project-workspace-hierarchy.md) | Accepted | 团队、项目与项目工作台采用明确层级 |
| [ADR-0008](0008-project-document-as-execution-context.md) | Accepted | 项目完整文档作为 Web 与 CLI 的统一执行上下文 |
| [ADR-0009](0009-modular-requirement-document-library.md) | Accepted | 模块化多需求文档与 Agent 渐进式上下文加载 |
| [ADR-0010](0010-numeric-primary-keys-and-public-codes.md) | Accepted | 数字主键关联与无实体前缀公开编码 |
| [ADR-0011](0011-project-scoped-material-fences.md) | Accepted | 项目级共享上下文与排他材料栅栏 |

每份 ADR 必须包含 `superseded_by`：有效决策为 `null`，被取代时填写新 ADR 文件名，同时更新本索引状态。文档变更与代码一同提交并经过 PR 评审。
