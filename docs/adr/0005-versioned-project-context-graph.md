# ADR-0005：使用版本化项目上下文图连接业务与实现

- 状态：Accepted
- superseded_by: null
- 日期：2026-08-12

## 背景

Feature Context Pack 能提供任务摘要，但无法稳定表达业务规则、系统、接口、代码、测试和部署之间的多对多关系。单张架构图适合人浏览，却缺少 Agent 查询所需的稳定 ID、来源、版本、权限和可信度。

## 决策

Project Core 增加版本化 Project Context Graph：

- 使用有类型节点和有方向关系表达业务到实现的追踪链。
- 每个节点和关系必须记录 Source、Revision、Verification 和 Freshness。
- Task/Run 绑定不可变 Graph Snapshot，并通过 Focus Node、Depth、Direction、Kind 和 Token Budget 获得子图。
- 图先经过权限过滤，再执行遍历和路径查询。
- Agent 和 Adapter 只提交 Graph Delta；影响 confirmed 语义的变化必须 Review。
- MVP 使用 SQLite/PostgreSQL 关系表和受限深度遍历，不引入专用图数据库。
- Mermaid、Structurizr、BPMN 等是视图或外部来源，不是平台统一事实模型。

## 结果

正面影响：

- Agent 可以快速获得与任务相关的最小业务和代码背景。
- 业务规则、接口、代码、测试和部署可以端到端追溯。
- 同一图模型能为产品、开发、测试和运维生成不同视图。
- 来源变化和图过期可以被明确检测。

代价：

- 需要维护稳定的节点/关系 Schema 和版本迁移。
- 需要定义人工确认与自动推断的治理边界。
- Graph Delta、权限过滤和新鲜度检测增加了 Core 用例。

## 被否决的方案

### 只维护 Mermaid 或 Draw.io 图片

图片适合展示，但不能可靠查询、裁剪、校验引用或表达来源和权限。

### 第一版使用 Neo4j/RDF

当前查询是以 Feature/Task 为中心的浅层遍历；关系表、索引和 Recursive CTE 已经可以满足，专用图基础设施没有被实际规模证明。

### 完全依赖代码自动扫描

代码可以推断实现关系，无法可靠决定业务目标、规则、Owner 和正式决策。

### 将全部项目内容塞入一张图

会造成噪音、权限泄露和上下文膨胀。权威模型可以统一，但 Agent 必须消费裁剪后的视图。

