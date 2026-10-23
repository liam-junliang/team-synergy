# CLI、MCP、Agent Client Protocol 与身份识别

## 接入总则

不同入口解决不同问题，但共享同一套领域用例、身份模型和状态转换：

```text
Human / Automation ── CLI or REST ── Project Core
Coding Agent ── MCP ──────────────── Project Core
Local Bridge ── Agent Client Protocol ── Coding Agent
```

不要用 MCP 启动 Agent，也不要用 Agent Client Protocol 承载项目管理语义。

## CLI：通用操作面

CLI 优先，因为所有编码 Agent 都能使用终端，也便于人调试、脚本调用、CI 集成和本地文件操作。

CLI 规则：

- 机器模式稳定输出 JSON，不要求 Agent 解析彩色终端文本。
- CLI 调用 Core Application API，不复制状态机。
- 操作本地文件的命令调用 Workspace Port；涉及正式状态时仍由 Core 确认。
- 不支持 Agent Client Protocol 或 MCP 的工具，可以完全通过 CLI 接入。

## MCP：Agent 的项目工具面

薄 MCP Adapter 只提供高价值、低歧义的项目工具：

```text
project_get_snapshot
feature_get_context
feature_get_context_graph
graph_get_node
change_get_impact_graph
task_get_current
task_report_progress
task_report_blocked
artifact_publish
evidence_submit
proposal_create
graph_report_delta
```

大段文件内容、终端控制、Worktree 创建和 Agent 生命周期不通过 MCP 复制实现。

## Agent Client Protocol：本地 Session 控制面

本地 Bridge 作为 Agent Client Protocol Client，为每个 Run 启动独立编码 Agent Session：

```text
Run A → codex-acp → Worktree A
Run B → claude-agent-acp → Worktree B
Run C → opencode acp → Worktree C
```

Bridge 负责能力协商、Prompt、流式事件、权限请求、取消、恢复和退出状态。协议名称在文档和代码中写全为 `Agent Client Protocol`，避免与已经并入 A2A 的旧 Agent Communication Protocol 混淆。

## 单机多 Agent 身份链

```text
Principal → Device → Agent Profile → Run → Task → Workspace
```

- `Principal`：最终负责和授权的人。
- `Device`：执行所在设备；单机 MVP 也生成稳定 ID。
- `Agent Profile`：职责和权限模板。
- `Run`：一次具体执行及短期凭据边界。
- `Task`：工作契约。
- `Workspace`：Run 的隔离目录。

模型名称、终端窗口标题或进程名不能作为 Agent 身份。

## CLI 如何识别当前 Run

按以下优先级解析：

1. 进程注入的短期 Run Credential。
2. 当前目录向上查找 `.agent/workspace.yaml`，再向 Core 验证绑定。
3. 显式 `--run` 参数与对应短期凭据。
4. 仍有歧义时拒绝写操作，不猜测默认 Agent。

全局配置只保存 Principal、Device 和服务器地址，不保存所有终端共享的“当前 Profile”。

## MCP 如何识别当前 Run

每个 Run 创建独立 stdio MCP 进程：

```text
tsp mcp serve --run RUN-201
tsp mcp serve --run RUN-202
```

Run ID 和 Credential 在进程启动时绑定。Agent 调用工具时不能传入另一个 Run ID；Core 还要校验 Task、Workspace、Profile 和允许操作。

Context Graph 工具还必须绑定 Task 的 Graph Snapshot、Focus Node 和最大遍历深度。Core 先移除当前 Run 不可见的节点和边，再执行子图或路径查询。

## 人在哪里交互

采用双入口、单一事实源：

| 项目面板 | 本地 Agent 工作区 |
|---|---|
| 项目、Feature、任务和优先级 | 编码、调试和本地测试 |
| 跨角色决策与审批 | 私有分析和临时文件 |
| 风险、阻塞和里程碑 | 具体 Session 日志和权限请求 |
| 正式产物与验证状态 | 准备 Outbox 和待提交产物 |

人可以在任一入口工作，但涉及多人共享的事实最终都通过 Project Core 生效。完整私有会话默认不上传。

## 本地 Agent 启动

MVP 由人主动启动：

```text
在项目面板或 CLI 选择 Task
→ tsp task start 创建 Run、Worktree 和短期身份
→ agentd 通过 Agent Client Protocol 启动对应 Agent
→ Agent 获取 Run-bound MCP
```

云端唤醒、本地常驻 Bridge、设备在线状态、任务租约和离线恢复属于 P2。届时 Bridge 只建立本地到云端的出站连接，避免要求云端穿透开发者网络。
