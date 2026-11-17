# ADR-0003：明确 Agent 协作协议边界

- 状态：Accepted
- superseded_by: null
- 日期：2026-08-12

## 背景

CLI、MCP、Agent Client Protocol、A2A 和 AG-UI 都可能出现在 Agent 平台中，但它们连接的对象和生命周期不同。把所有能力塞入一个协议会造成重复状态机、身份伪装和供应商绑定。

## 决策

- REST/OpenAPI 是 Project Core 的通用应用接口。
- CLI 是人、脚本和所有 Agent Harness 的通用兜底操作面。
- MCP 是 Agent 使用项目上下文和提交能力的工具面，按 Run 绑定身份。
- Agent Client Protocol 是 Local Bridge 控制本地编码 Agent Session 的首选协议。
- 不支持 Agent Client Protocol 的 Harness 使用 CLI Adapter。
- A2A 只在出现独立远程 Agent Service 后采用。
- AG-UI 只在 Web 需要统一 Agent 流式交互后评估。

MCP、CLI 和 Web 不实现自己的任务状态机，全部调用 Core Application Use Case。

## 结果

正面影响：

- Codex、Claude Code、OpenCode 可以替换或并存。
- 每个协议的身份、错误和生命周期更清晰。
- 后续可以增加远程 Agent 或丰富界面而不改变核心领域。

代价：

- Local Bridge 需要维护 Agent Client Protocol 和少量 CLI Adapter。
- 同一业务能力需要生成 REST、CLI JSON 和 MCP Schema，但实现只能有一份。

## 被否决的方案

### 用 MCP 负责 Agent 启动和 Worktree 管理

MCP 的工具调用模型不等于本地进程生命周期和 Workspace 所有权模型。

### 用 A2A 包装所有本地编码 Agent

本地 Harness 已有进程/stdio 接口，提前服务化只会增加部署和认证成本。

### 自研统一 Agent Wire Protocol

没有足够差异化价值，还会失去现有 SDK 和 Agent Adapter 生态。

