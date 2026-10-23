# GitHub 开源技术雷达

- 调研日期：2026-08-12
- 范围：Agent 项目管理、编码 Agent 编排、ACP、MCP、A2A、CLI、工作区和执行环境
- 数据来源：项目 GitHub 仓库、README、架构文档、Release 和 GitHub 元数据

Star 和版本仅用于判断当前生态热度，不能替代代码质量、许可证和维护状态评估。

> 本文是有日期的调研快照，不是实施规范。当前选择以[架构基线](00-architecture-baseline.md)和[ADR](adr/README.md)为准。

项目上下文图、制图标准、关系存储和代码建图工具的专项判断见[技术路线验证](10-technical-route-validation.md)。

## 结论

已经存在大量可复用技术，不适合从零开发一个包含 Agent Runtime、项目管理、协议和工作区管理的全栈系统。

本项目最合理的边界是：

> 自己掌握 Project、Feature、Task、Run、Artifact、Evidence、Decision 这套项目协作领域模型；Agent 会话、工具接入、工作区和通用项目管理尽量复用或适配现有开源能力。

建议优先级：

1. **采用 Agent Client Protocol（ACP）作为本地编码 Agent 会话的首选控制协议。**
2. **采用 MCP 向 Agent 暴露项目上下文和项目操作。**
3. **借鉴 Agent Orchestrator 的本地 Daemon、端口适配、Worktree 和事实状态模型。**
4. **借鉴 Beads 的任务 DAG、Ready/Claim 和 JSON CLI；先作为 Adapter Spike，不替代核心 Task Store。**
5. **使用原生 Git Worktree，必要时复用 agent-worktree；不自行发明代码隔离方案。**
6. **A2A、AG-UI、远程沙箱和复杂工作流引擎延后到实际需求出现。**

## 协议分层

名称相近，但解决的问题不同：

| 协议 | 连接对象 | 本项目中的位置 | 阶段建议 |
|---|---|---|---|
| ACP（Agent Client Protocol） | 客户端/IDE ↔ 编码 Agent | 本地 Bridge 启动和控制 Codex、Claude、OpenCode 会话 | MVP Spike，随后采用 |
| MCP | Agent ↔ 工具/资源 | Agent 查询项目状态、提交产物和证据 | MVP 采用薄适配器 |
| A2A | 独立 Agent 服务 ↔ Agent 服务 | 跨团队、跨云的远程 Agent 委派 | P2/P3 再采用 |
| AG-UI | Agent Backend ↔ 用户界面 | Web 控制台中的流式进度、审批和共享状态 | P1/P2 评估 |

推荐的协议组合：

```text
Web UI ── AG-UI（可选） ── Project Platform
                              │
                              ├── MCP Server ── Agent 使用项目工具
                              │
Local Bridge ── ACP Client ── Codex / Claude / OpenCode
                              │
Remote Agent Service ─ A2A ──┘（后期）
```

### ACP 名称歧义

当前仍可能搜到两个不同的 ACP：

- [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol)：编辑器/客户端与编码 Agent 的协议，当前活跃，适合本项目。
- [i-am-bee/acp](https://github.com/i-am-bee/acp)：原 Agent Communication Protocol，已经归入 A2A，仓库于 2025-08-27 归档，不应作为新依赖。

规范性文档首次引用和代码中的协议类型应写完整名称或使用 `agent_client_protocol`，避免与旧协议混淆；官方仓库名、二进制命令和本调研表中的已定义缩写保持原名。

## 第一梯队：最值得研究或复用

### 1. Agent Orchestrator

- 仓库：[Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)
- 快照：约 9.4k Star，Apache-2.0，2026-08-11 发布 `v0.12.3`
- 定位：本地 Agent IDE/编排器，支持多种编码 Agent、独立 Worktree、CLI、桌面端、PR/CI/Review 反馈闭环。

与本项目高度重合的能力：

- 长运行 Go Daemon，桌面端和 `ao` CLI 共享同一服务。
- 每个 Session 使用独立 Git Worktree 和分支。
- Agent Adapter、Runtime Adapter、Chat/ACP Driver、Workspace Adapter、SCM Adapter 分层。
- SQLite 保存持久事实，通过 CDC/SSE 通知界面。
- 不直接持久化 `working`、`ci_failed` 等展示状态，而是从 Activity、Runtime、PR/CI 等事实派生。
- 支持 Codex、Claude Code、OpenCode 等大量 CLI Harness。

建议：

- 作为本地 Bridge 的首要架构参考。
- 做一个“平台云端 Task → Agent Orchestrator Session”的集成 Spike。
- 优先复用 Adapter/ACP/Worktree 思路，不立即 Fork 整个桌面产品。
- 其主要边界是本地代码执行和 PR 闭环，并不等于本项目需要的跨人共同状态、正式决策、Artifact/Evidence 治理。

### 2. Beads

- 仓库：[gastownhall/beads](https://github.com/gastownhall/beads)
- 快照：约 26.2k Star，MIT，2026-08-11 发布 `v1.2.1`
- 定位：面向编码 Agent 的分布式图任务系统和持久记忆 CLI。

可复用思想：

- 依赖图、自动计算 Ready Task、原子 Claim 和阻塞解除。
- 全面的 JSON CLI 输出，支持 Codex、Claude 等 Agent 接入。
- Hash ID 降低多分支任务 ID 冲突。
- 任务、消息、关系图和项目记忆使用统一结构。
- Dolt 支持版本化 SQL、分支和跨设备 Push/Pull。
- 已区分嵌入式单写和服务端多写模式。

建议：

- 做两条路线对比：
  - 快速原型：`tsp` 包装 Beads，补充 Feature、Artifact、Evidence 和 Decision。
  - 产品化：自有 PostgreSQL 模型，提供 Beads Import/Sync Adapter。
- 不宜未经 Spike 就把 Dolt 设为云端平台的核心数据库；其多租户、权限和正式产物模型仍需额外建设。

### 3. Agent Client Protocol

- 协议：[agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)
- Registry：[agentclientprotocol/registry](https://github.com/agentclientprotocol/registry)
- TypeScript SDK：[agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk)
- Python SDK：[agentclientprotocol/python-sdk](https://github.com/agentclientprotocol/python-sdk)
- 快照：主协议约 3.9k Star，Apache-2.0，当前稳定 Wire Protocol Version 为 `1`

协议已覆盖初始化、能力协商、Session、Prompt、流式更新、工具调用、文件修改、终端输出和权限请求等编码 Agent 会话能力。

可直接验证的 Agent 接入：

- Codex：[agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)，将 ACP 请求转换为 Codex App Server 操作。
- Claude：[agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)。
- OpenCode：[anomalyco/opencode](https://github.com/anomalyco/opencode) 原生命令 `opencode acp`，通过 JSON-RPC/stdio 提供 ACP Server。
- Copilot CLI：官方提供 ACP Server，但当前文档仍标记为 Preview。

建议：本地 Bridge 实现 ACP Client，为每个 Run 启动独立 stdio ACP Server，并绑定 Run、Workspace 和短期权限。对于不支持 ACP 的 Harness，再使用 CLI Adapter 兜底。

### 4. MCP

- 规范：[modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)
- TypeScript SDK：[modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- 定位：Agent 与工具、API、数据源之间的统一接口。

建议仅暴露少量稳定项目工具：

```text
project_get_snapshot
feature_get_context
task_get_current
task_report_progress
task_report_blocked
artifact_publish
evidence_submit
proposal_create
```

MCP 不负责启动 Agent、分配长期任务或管理 Worktree，不能替代 ACP、本地 Bridge 或项目状态机。

### 5. Git Worktree 工具

- [nekocode/agent-worktree](https://github.com/nekocode/agent-worktree)：MIT，提供创建、运行、合并和清理的 Agent Worktree 工作流，支持 PowerShell。
- [morapelker/hive](https://github.com/morapelker/hive)：MIT，统一管理 Claude Code、OpenCode、Codex Session 和独立 Worktree。

建议：MVP 可以直接使用原生 Git 命令；如果 Hook、依赖复制、端口和清理逻辑开始膨胀，再评估调用或抽取 `agent-worktree`。Hive 更适合做 UX 和多仓库 Session 参考。

## 第二梯队：强参考或竞争产品

| 项目 | 核心能力 | 适配判断 |
|---|---|---|
| [Cline](https://github.com/cline/cline) | Apache-2.0；CLI、SDK、IDE、Kanban、多 Agent Team、定时任务；Kanban Card 绑定 Worktree 和依赖 | 强产品参考；更偏 Cline 自有 Runtime，不适合作为“每个人自选 Agent Harness”的唯一底座 |
| [OpenHands](https://github.com/OpenHands/OpenHands) | MIT；Agent Canvas、REST Agent Server、多 Agent、多主机和自动化服务 | 可参考 Agent Server/Workspace；整体较重且倾向自身 Agent SDK |
| [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) | MIT；Python/REST API、Local/Ephemeral Workspace、Agent Server | 若后续建设云端托管 Agent，可作为 Runtime 候选；MVP 无需引入 |
| [CCPM](https://github.com/automazeio/ccpm) | MIT；PRD → Epic → GitHub Issue → 并行开发；Agent Skills 兼容 | 很适合借鉴 Spec-driven 流程与 GitHub Issues 事实源；主要是 Skill/方法论，不是完整控制平台，且其部分并行模式允许多个 Agent 在同一 Worktree 工作，不应照搬 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Apache-2.0；Kanban、Agent Workspace、Diff Review、PR、Worktree 清理 | 源码仍有参考价值，但项目已明确 Sunsetting，不应成为基础依赖 |
| [Forge](https://github.com/forge-agents/forge) | MIT；基于 ACP 的通用编码 Agent CLI | 可参考 ACP Client/TUI，但规模小、近期活跃度较低，不宜直接承担核心运行时 |

## 通用项目管理系统

| 项目 | 许可证 | 适用方式 |
|---|---|---|
| [Plane](https://github.com/makeplane/plane) | AGPL-3.0 | 成熟的 Issue、Cycle、Module、Doc 和 Triage；后续通过 API/Webhook 集成，不建议为 MVP Fork/嵌入 |
| [OpenProject](https://github.com/opf/openproject) | GPL-3.0 | 适合传统项目、计划、工时、预算和组织治理；对早期 Agent 协作过重 |
| GitHub Issues/Projects | 托管服务，不属于本项目开源依赖 | 对代码项目是最快的共享任务事实源；CCPM 已证明这条路线可行 |
| Beads | MIT | 最接近 Agent 原生任务 DAG；适合 CLI-first 原型和离线/多分支场景 |

结论：不要先做一个 Jira/Linear 替代品。MVP 可以使用自己的最小 Task Store，或将 GitHub Issues/Beads 作为 Task Backend。平台差异化应放在 Feature Context、Run 身份、Workspace、Artifact/Evidence 和跨 Agent 同步。

## Agent-to-Agent 与人机界面协议

### A2A

- 仓库：[a2aproject/A2A](https://github.com/a2aproject/A2A)
- 快照：约 25.3k Star，Apache-2.0，已发布 `v1.0.x`

A2A 支持 Agent Card 能力发现、长任务、同步/流式/异步交互和富数据交换。它适合连接独立、远程、内部实现不透明的 Agent Service。

MVP 中本地 Codex/Claude/OpenCode 是进程型编码 Harness，不必为了“协议完整”先包装成 A2A Server。等平台真正出现跨组织远程 Agent 服务时再接入。

### AG-UI

- 仓库：[ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui)
- 快照：约 15.3k Star，MIT

AG-UI 定义了面向用户界面的事件流、双向状态同步、结构化消息和 Human-in-the-loop。后续 Web 控制台如果需要统一显示不同 Runtime 的流式执行、审批和状态，可以采用；第一版普通 REST + SSE 已足够。

## Agent 编排框架

这些框架解决“应用内部如何构建 Agent/多 Agent Workflow”，并不天然解决跨人的项目事实、Git Worktree、身份和 Artifact/Evidence：

| 项目 | 状态 | 本项目建议 |
|---|---|---|
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | MIT，活跃；Handoff、Guardrail、Session、Tracing、Human-in-the-loop、Sandbox Agent | 需要内部 Planner/Summarizer Agent 时优先候选；不作为外部编码 Agent 控制协议 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | MIT，活跃；Python/.NET、Workflow、MCP、A2A | 若采用微软/.NET 技术栈或需要 A2A，可评估 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | MIT，活跃；持久化、长任务、人机介入 | 适合复杂内部 Workflow；MVP 的任务状态机不需要它 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | MIT，活跃；角色化 Agent 和 Flow | 适合模型内编排实验，不替代项目控制面 |
| [AutoGen](https://github.com/microsoft/autogen) | 已进入 Maintenance Mode | 新项目不采用；微软官方建议迁移到 Agent Framework |

## 执行环境与基础设施

| 项目 | 价值 | 判断 |
|---|---|---|
| [E2B Infra](https://github.com/e2b-dev/infra) | Apache-2.0；Firecracker 沙箱、自托管基础设施 | 云端隔离执行的后期候选，MVP 过重 |
| [Coder](https://github.com/coder/coder) | AGPL-3.0；开发者和 Agent 的远程安全环境 | 企业远程 Workspace 候选，需评估许可证和部署复杂度 |
| [Daytona](https://github.com/daytonaio/daytona) | 曾提供快速 Agent Sandbox | 仓库明确说明 2026-06 起核心转为私有且不再维护，不能作为新开源底座 |
| [Temporal](https://github.com/temporalio/temporal) | MIT；耐久长流程和失败恢复 | 只有出现跨小时/天、重试和补偿需求后再引入 |
| [OpenTelemetry Collector](https://github.com/open-telemetry/opentelemetry-collector) | Apache-2.0；标准 Trace/Metric/Log | 从早期保留 Trace ID，P1 再完善采集链路 |
| [OPA](https://github.com/open-policy-agent/opa) / [OpenFGA](https://github.com/openfga/openfga) | Apache-2.0；策略与关系权限 | 权限复杂化后采用；MVP 简单角色/路径规则即可 |

## 推荐的“自研与复用”边界

### 必须自研或牢牢控制

- Project、Feature、Task、Run 的领域关系。
- Feature Context Pack 和 Snapshot Version。
- Proposal → Decision 的生效边界。
- Artifact、Evidence 和验收状态。
- Human、Agent Profile、Run、Workspace 的身份映射。
- 项目级审计语义和客户端无关 API。

### 优先复用

- ACP Schema、SDK、Registry 和现有 Agent Adapter。
- MCP 官方 SDK。
- Git Worktree 与现有 Worktree 管理经验。
- GitHub API/Issues 或 Beads Task Graph。
- OpenTelemetry 语义和 Trace ID。

### 暂不建设

- 自定义 Agent-to-Agent Wire Protocol。
- 自研模型编排框架。
- 自研远程容器/微虚拟机平台。
- 完整 Jira 替代品。
- Kafka/NATS/Temporal/OPA 组成的复杂分布式控制面。

## 建议的三项技术 Spike

### Spike A：ACP 本地 Bridge

目标：验证同一台电脑上三个独立 Run 能否分别控制 Codex、Claude 和 OpenCode。

```text
Run A → codex-acp → 独立 Worktree A
Run B → claude-agent-acp → 独立 Worktree B
Run C → opencode acp → 独立 Worktree C
```

验证项：

- Session 创建与恢复。
- 流式消息和 Tool Event。
- Permission Request。
- Stop/Cancel。
- CWD/Workspace 隔离。
- MCP Server 注入。
- Agent 异常退出和日志采集。

### Spike B：任务和工作区闭环

对比三个方案：

1. 自有 SQLite/PostgreSQL Task Store + 原生 Git Worktree。
2. Beads + `tsp` Wrapper。
3. Agent Orchestrator Daemon + 云端 Task Adapter。

用同一个真实功能验证 `Task → Run → Commit → Test Evidence → Close → Cleanup`，再决定复用深度。

### Spike C：薄 MCP 项目接口

只实现 `task_get_current`、`feature_get_context`、`artifact_publish`、`evidence_submit`，分别在 Codex、Claude 和 OpenCode 中验证 Schema 稳定性与身份绑定。

## 当前推荐架构修订

基于调研，MVP 可收敛为：

```text
Web / CLI
   │
Project Core API
   ├── 自有 Project/Feature/Task/Run/Artifact/Evidence/Decision
   ├── 自有最小 Task Store；Beads/GitHub 作为外部 Adapter
   └── MCP Server：给 Agent 使用项目能力

Local Bridge
   ├── ACP Client：首选 Agent 会话控制
   ├── CLI Adapter：不支持 ACP 时兜底
   └── Git Worktree Manager
```

最值得直接吸收的两个架构思想：

1. Agent Orchestrator 的“持久化事实、派生显示状态”和 Port/Adapter 结构。
2. Beads 的“任务依赖图、Ready 计算、原子 Claim、JSON CLI 和可同步持久记忆”。

这两者与本项目已有的“项目共同状态 + Task/Run 隔离 + Artifact/Evidence”可以互补，而不是互相替代。架构已经决定先实现自有最小 Task Store 和 Run 级本地执行进程，再通过 Spike 决定两类 Adapter 的复用深度。
