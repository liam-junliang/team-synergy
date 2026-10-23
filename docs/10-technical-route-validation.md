# 技术路线验证与缺口审计

- 验证日期：2026-08-12
- 结论：Conditional Go
- 范围：项目共同状态、本地 Agent 接入、Workspace、项目上下文图

`Conditional Go` 表示总体路线可以进入 MVP，实现前不需要重新设计总体架构；但 Agent Client Protocol 兼容性、MCP 身份绑定、自动代码建图准确率等仍需后续 Spike 提供证据。

## 总体判断

当前技术路线成立：

```text
TypeScript Modular Monolith
├── Project Core + SQLite/PostgreSQL
├── Versioned Project Context Graph
├── REST/OpenAPI + SSE
├── CLI + Run-bound MCP
└── Local agentd + Agent Client Protocol + Git Worktree
```

新增 Context Graph 后仍不需要引入微服务、图数据库、消息总线、工作流引擎或 GraphRAG。

## 缺口审计

| 缺口 | 当前处理 | 仍需验证 |
|---|---|---|
| 图的稳定 Schema | 已建立 0.1 JSON Schema 和有类型节点/关系 | 用第二个真实 Feature 检查枚举是否过窄 |
| 关系来源与可信度 | 已定义 Source、Revision、Verification、Freshness | 来源变化后的自动失效流程 |
| Agent 上下文过大 | 已实现 Focus Node、Depth、Direction 子图裁剪 | Token Budget 排序和实际回答质量 |
| 图与文档重复维护 | 同一模型生成 JSON 和 Mermaid | Structurizr/BPMN/OpenAPI Adapter 的差异同步 |
| 图更新冲突 | 设计为 Base Snapshot + Graph Delta | 并发 Delta 合并和 Review 流程 |
| 敏感节点泄露 | 已规定先授权过滤再遍历 | 行级权限和路径查询的安全测试 |
| 代码自动建图 | 自动结果只能标记 `inferred` | 多语言解析、重命名和动态调用准确率 |
| 图存储选型 | SQLite 表、外键、索引和递归遍历已验证 | PostgreSQL Adapter 契约和规模基准 |
| 可视化交互 | Mermaid 已验证；Cytoscape.js 为 P1 候选 | 大子图布局与用户可读性 |
| 生命周期治理 | 设计 Graph Snapshot、Stale 和 Delta | 谁负责确认、过期多久报警、如何归档 |

## 技术选型结论

### 立即采用

| 能力 | 选择 | 原因 |
|---|---|---|
| 权威图模型 | 自有 Typed Property Graph | 能连接业务、项目和代码语义，不受单一制图标准限制 |
| 交换格式 | JSON + JSON Schema 2020-12 | Agent 友好、可校验、易通过 REST/CLI/MCP 传输 |
| MVP 存储 | SQLite；共享阶段 PostgreSQL | 当前查询是受限深度子图，关系表已经足够 |
| 轻量视图 | Mermaid | 文本化、可版本化、适合 Markdown 和 Agent 生成 |
| 架构视图 | C4 概念 + Structurizr DSL Adapter | Structurizr 将一个模型和多个视图分离，符合投影思路 |
| API 契约 | OpenAPI | 机器和人都能读取 HTTP API 能力 |
| 事件契约 | AsyncAPI | 需要异步事件后再接入，不自定义事件描述格式 |

[Structurizr DSL](https://docs.structurizr.com/dsl)本身以模型和视图组织架构；[C4](https://c4model.com/diagrams)允许按 Context、Container、Component 等层级缩放。它们适合架构投影，但不用于表达所有业务规则和 Task/Run。

[OpenAPI](https://spec.openapis.org/oas/latest.html)提供语言无关、机器可读的 HTTP API 描述；[AsyncAPI](https://github.com/asyncapi/spec)提供异步 API 的机器可读定义。两者应作为图的外部来源，而不是由图反向替代。

### 条件采用

| 能力 | 候选 | 采用条件 |
|---|---|---|
| Web 交互图 | Cytoscape.js | P1 需要筛选、遍历、布局和节点详情时 |
| 业务流程 | BPMN 2.0 + bpmn-js | 项目确实存在跨角色分支、异常和补偿流程时 |
| 业务决策 | DMN | 复杂决策表需要独立版本和验证时 |
| 软件目录 | Backstage Catalog Adapter | 团队已有多个服务、Owner 和平台目录时 |
| 代码结构抽取 | Tree-sitter/LSP Adapter | 人工 Module Map 成为维护负担时 |
| 深层代码分析 | Joern Code Property Graph | 需要跨过程数据流、安全或复杂调用分析时 |

[Cytoscape.js](https://js.cytoscape.org/)支持浏览器和无界面图分析、集合过滤、遍历和多种布局；适合作为只读交互视图。[bpmn-js](https://bpmn.io/toolkit/bpmn-js/walkthrough/)能够显示和编辑 BPMN 2.0。Backstage 的 [Software Catalog](https://backstage.io/docs/features/software-catalog/)则证明了“代码仓库内元数据 + 中央目录 + 关系”的模式，但完整 Backstage 对当前 MVP 过重。

[Joern Code Property Graph](https://docs.joern.io/code-property-graph/)同时表达语法、控制流和数据流，适合深层静态分析；它不适合承担人工业务语义，也不应成为 MVP 的必选运行组件。

### 当前明确不采用

- Neo4j、RDF/OWL：尚无大规模或复杂图查询需求。
- GraphRAG/向量数据库：语义检索不能替代稳定 ID、来源和确定关系。
- 自动反向生成全部业务架构：代码无法可靠推断业务目标、规则和责任。
- 单一 Mermaid 文件作为事实源：图片语法缺少来源、权限、可信度和生命周期语义。
- 用 Structurizr/C4 表达全部业务流程：C4 的目标是软件结构，不是业务规则引擎。

## 已执行的验证

### 验证环境

```text
Node.js v22.21.1
SQLite 3.41.2
第三方运行依赖：0
```

### 原型规模

示例“用户登录”图覆盖：

- 12 个节点：Actor、Capability、Use Case、Feature、Rule、Decision、API、Service、Aggregate、Table、Test、Deployment。
- 12 条关系：从业务目标一直追踪到实现、测试和部署。
- 每个节点和关系都包含来源版本、可信状态和新鲜度。

### 通过的验证项

| 假设 | 证据 | 结果 |
|---|---|---|
| 图能执行基本完整性校验 | 重复节点和悬空边负向测试 | Pass |
| JSON 交换格式符合正式 Schema | PowerShell `Test-Json` 校验 2020-12 Schema | Pass |
| Task 可获得受限子图 | 一跳、方向性和深度遍历测试 | Pass |
| 一份模型可生成图形视图 | JSON 图生成 Mermaid，边数一致 | Pass |
| 关系型数据库可存储版本化图 | SQLite 复合主键/外键、两个快照和端点索引 | Pass |
| SQLite 可查询受限深度子图 | Recursive CTE 一跳与三跳断言 | Pass |
| 原型无需引入依赖 | 仅使用 Node.js 标准库和 SQLite CLI | Pass |

自动测试结果：6/6 通过；JSON Schema 校验通过；SQLite 外键/引用/多快照/图遍历断言：5/5 通过。

## 尚未验证，不能宣称完成

1. Codex、Claude Code、OpenCode 的 Agent Client Protocol 行为是否完全一致。
2. Run-bound MCP 在三个 Harness 中的身份隔离和 Schema 兼容性。
3. 真实大型仓库中两跳子图的 Token 数和 Agent 理解准确率。
4. Tree-sitter/LSP 对多语言调用图、动态调用和重命名的准确率。
5. Graph Delta 并发冲突、审批和 Snapshot 合并。
6. PostgreSQL 多用户写入、权限过滤和查询性能。
7. Cytoscape.js 在实际复杂图上的布局可读性。

## 下一轮验证顺序

1. 选择一个真实 Feature，人工建立 20～50 个节点的确认图。
2. 比较 Agent 使用“普通文档”和“Task 子图”完成模块问答的准确率、耗时和 Token。
3. 实现 `feature_get_context_graph` MCP，只返回 Run 授权后的子图。
4. 导入一个真实 OpenAPI 文件，验证来源变更后自动标记 `stale`。
5. 让 Builder 提交 Graph Delta，由 Verifier 检查代码、测试和图变化是否一致。
6. 完成这些验证后，再决定是否开发 Cytoscape.js Web 视图和代码扫描 Adapter。

## Go/No-Go 门槛

Context Graph 进入正式 MVP 必须满足：

- 一个真实 Feature 的图能够在 5 分钟内让新 Agent 回答模块入口、规则、接口和测试位置。
- Task 子图相对完整项目上下文显著减少 Token，且不降低关键问题正确率。
- 所有 confirmed 节点可追溯到有效来源和版本。
- 无权限的 Run 无法通过节点、路径、计数或错误信息推断隐藏对象。
- 一次真实代码变更可以提交、Review 并应用 Graph Delta。
