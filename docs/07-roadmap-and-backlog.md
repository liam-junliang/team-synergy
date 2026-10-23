# 路线图与 MVP Backlog

## 已固定的产品与架构选择

此前的开放问题已经收口：

| 问题 | 决定 |
|---|---|
| MVP 本地还是云端 | 先交付单机一体化安装；保持控制面/执行面边界，P1 再共享部署 |
| Feature Context 如何产生 | 首版模板化人工确认；代码扫描只能生成带来源的候选内容 |
| Artifact 如何保存 | 首版保存 Git Commit、文件/报告 URI、摘要和哈希，不自建对象存储 |
| Task Store 归属 | 核心最小 Task Store 自持有；GitHub/Beads 以后做 Adapter |
| 不同 Agent 如何启动 | Agent Client Protocol 优先，CLI Adapter 兜底 |
| Verifier 能否使用同一模型 | 可以，但必须是独立 Run；高风险变更仍需要第二个人复核 |
| 项目业务和代码关系如何表达 | 自有版本化 Context Graph；外部标准作为来源或视图，Task 只获取裁剪子图 |
| 工作主入口是什么 | 持续需求表；Context Graph 作为需求和任务的辅助背景 |
| Task 分派给谁 | 分派给 Human Principal；Agent 通过 Assignee 授权的 Claim 创建 Run |
| 自测后如何更新 | Builder 可更新 `self_tested`/`submitted`，不能自行 `verified`/`closed` |

试点输入已确定：首个真实项目是平台自身（PROJECT-A，dogfooding），见[试点计划](20-pilot-project-bootstrap.md)。

## MVP 成功标准

选择一个真实的小功能，并证明：

1. Planner 可以创建版本化 Feature Context 和验收标准。
2. Builder 在独立 Worktree 获取 Task 并发布 Commit Artifact。
3. Verifier 在独立 Run 读取相同验收基线并提交 Evidence。
4. Project Core 准确派生任务、阻塞、产物和验证状态。
5. 两个并行 Run 不共享未提交目录、Credential 或 MCP Session。
6. 任务结束后可以预览、归档和安全清理临时工作区。
7. Codex、Claude Code、OpenCode 至少各完成一次协议或 CLI fallback 接入验证。
8. Agent 能从 Task Context Graph 快速定位业务规则、接口、实现和测试。

## 已完成的前置技术验证

- [x] 定义 Project Context Graph 0.1 JSON Schema。
- [x] 建立 12 节点、12 关系的业务到部署示例图。
- [x] 验证重复 ID、悬空边和方向遍历。
- [x] 验证 Feature 一跳子图和 Mermaid 投影。
- [x] 验证 SQLite 外键、端点索引和 Recursive CTE 图遍历。
- [x] 6 项 Node 测试、JSON Schema 校验与 5 项 SQLite 断言通过。

## P0：三个验证 Spike

### Spike 1：任务和工作区闭环 —— ✅ 已完成（2026-08-13，试点 backlog TASK-101~112 全部 closed）

**交付摘要**（详见 [docs/20](20-pilot-project-bootstrap.md) 试点记录）：

- [x] TypeScript Monorepo + 共享 Contracts（contracts/domain/application/persistence/integrations + core-api/agentctl/web）
- [x] 核心领域对象、状态机（10 态 + 两段证据门槛）和审计事实（8 动作审计流）
- [x] Task 闭环：create/assign/claim/submit/verify/close/history，真实 git worktree + Context Pack 渲染（brief.md）
- [x] SQLite Repository 与迁移（外键/索引/CTE 图遍历/快照隔离）
- [x] Artifact、Evidence 与 Snapshot 乐观并发（base_snapshot 条件更新）
- [x] 清理 --dry-run、Patch 保护、回收区、引用检查 fail-closed
- [x] 成员管理（Owner/Member + bootstrap Owner + 最后 Owner 保护；CLI team 命令族；邀请码/设备凭据**延后**——同机多用户已实测）
- [x] Defect 闭环与 Task 来源分类（requirement/ad-hoc/defect-fix/integration；docs/19）
- [x] Web 看板 + 需求工作台 + 编排工作台（对话条 + Cytoscape.js 依赖图）+ 验收视图 + stale 提示
- [x] CLI 经 HTTP 同步任务状态（ACP_API_URL）+ core-api 任务路由（局域网共享形态落地）
- [x] `tsp task run` 一条命令执行循环（claim → 执行器 → 收尾检查）
- [x] 真实闭环验证：codex 绑定用户执行 2 个真实任务（TASK-107/108），Planner→Builder→Verifier→Close 全程审计
- [ ] 局域网**多机**实测（同机多用户已验证；跨机需另一台设备，**延后**）
- [ ] 完整文档 vs Task 子图对 Agent 准确率/耗时/Token 的影响测量（Spike 2 前补）
- [ ] 邀请码/设备凭据（docs/15 完整形态，**延后**至多机场景启动前）

### Spike 2：Agent Client Protocol 接入

- [ ] 实现 Run 生命周期内的 `agentd`。
- [ ] 验证 Codex、Claude Code、OpenCode 的 Session 创建与恢复。
- [ ] 验证流式事件、权限请求、取消和异常退出。
- [ ] 验证三个并行 Run 的 CWD、进程和日志隔离。
- [ ] 为不支持协议的 Agent 实现统一 CLI Adapter 接口。

### Spike 3：薄 MCP

- [ ] 实现 `task_get_current` 和 `feature_get_context`。
- [ ] `task_get_current` 返回 stale 状态与差异摘要（docs/16）。
- [ ] 实现 `feature_get_context_graph` 和权限过滤。
- [ ] 实现 `artifact_publish` 和 `evidence_submit`。
- [ ] 使用独立 stdio 进程绑定 Run Credential。
- [ ] 在三个 Agent Harness 中验证相同 Schema。
- [ ] 增加跨 Run 身份伪装和过期 Credential 的拒绝测试。

## P1：小团队共享

- [ ] React Web Console：Feature、Task、Run、Artifact、Evidence、Decision。
- [ ] PostgreSQL Persistence Adapter 和数据迁移验证。
- [ ] 完整权限模型与身份体系（MVP 已含 Owner/Member、邀请码与设备凭据的最小集，docs/15）。
- [ ] Proposal → Review → Decision 流程和 Snapshot 变更摘要。
- [ ] SSE 状态通知和冲突提示。
- [ ] GitHub Issues/Projects 单向导入或双向同步 Spike。
- [ ] Beads Adapter Spike；验证 DAG/Ready/Claim 价值后再决定是否产品化。
- [ ] Agent Orchestrator Session Adapter Spike；只集成，不 Fork 产品。
- [ ] Cytoscape.js 只读 Context Graph 视图。
- [ ] 燃尽图等派生统计视图；Release 正式领域对象按需评估（docs/19 第 3 节）。
- [ ] OpenAPI/AsyncAPI、Structurizr 和 BPMN Source Adapter Spike。
- [ ] Tree-sitter/LSP 代码关系 Adapter；所有结果默认标记 `inferred`。

## P2：多设备与后台执行

仅当真实需求出现时增加：

- [ ] 带预算的顺延领取（Claim Policy：范围/预算/停止条件，docs/18；不要求常驻进程）。
- [ ] 常驻 Local Bridge、设备注册和在线状态。
- [ ] 出站长连接或轮询、持久 Mailbox 和任务租约。
- [ ] Run Checkpoint、断线重连和人工恢复。
- [ ] 按类型、TTL 和引用关系的自动清理。
- [ ] AG-UI 的流式界面 Spike。
- [ ] 远程独立 Agent Service 出现时再做 A2A Spike。

## P3：高自动化与治理

- [ ] 无人值守执行和故障转移。
- [ ] 短期能力凭据和细粒度策略。
- [ ] Staging/Production 发布治理。
- [ ] 完整审计、成本、质量和可观测性指标。
- [ ] 经需求证明后引入耐久工作流或独立事件系统。
- [ ] 经安全评估后引入远程沙箱。

## 主要风险

| 风险 | 控制方式 |
|---|---|
| 平台比项目本身更复杂 | 以三个 Spike 为 P0，禁止先做远程调度和微服务 |
| Agent 身份串用 | Run Credential、Workspace 绑定和独立 MCP/Agent Client Protocol Session |
| 共同状态沦为文档负担 | 从 Git、测试和 Run 事实派生状态，只保留需确认的语义 |
| 多 Agent 制造更多打断 | WIP 限制、Ready Task 和统一阻塞/审批入口 |
| 外部工具变成事实源冲突 | 自有领域模型为准，集成只走显式 Adapter |
| 误把双 Agent 当成双人审核 | 区分技术验证和人类责任隔离 |
| 临时清理误删成果 | Dry-run、引用检查、Patch、回收区和延迟删除 |

## 演进门槛

每增加一项平台能力，都必须记录：

- 已经发生的协作问题和可观察证据。
- 不增加能力的实际代价。
- 更简单的 Git、CLI、数据库约束为什么不够。
- 新组件的故障、权限、迁移和清理成本。

## 规模化路径（量级估算与触发信号）

按团队规模对照，规模化成本主要不在性能（负载是 JSON CRUD 事实账本，本地执行面天然水平扩展），而在数据库、组织权限与运维成熟度：

| 规模 | 部署形态 | 需要完成的路线图 | 新引入 |
|---|---|---|---|
| 1～2 人 | 单机（局域网共享特例） | MVP（SQLite） | 无 |
| 2～20 人 | 局域网共享 | MVP | 无 |
| 20～50 人 | 局域网 + 备份 | MVP + 运维意识 | 定期备份、恢复演练 |
| 50～300 人 | 云端 | P1（PostgreSQL、完整权限、SSE） | 云端托管、多项目 |
| 300～1000 人 | 云端 + 水平扩展 | P1+P2+P3 | Core 多实例（无状态可扩展）、SSE 粘性会话与扇出路由、大概率独立事件系统（延后清单触发）、RBAC、配额与成本治理 |

参考负载（300 人）：日写入约 6k 事件、峰值约 3 rps、SSE 约 300 长连接——Fastify + PostgreSQL 的常规负载。

千人规模时核心领域模型（事实中心、Run 隔离、快照+Delta、双平面）不变；但产品形态已超出 docs/01 定位（个人与小团队），应重新立项讨论而非在 MVP 上堆叠。

重新评估语言的触发信号：P2 常驻 agentd 出现 Node 进程管理/资源占用的实测问题（仅替换 agentd 单组件，Core 对 agentd 实现语言无感知）。
