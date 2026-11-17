# 团队成员、CLI 加入与局域网共享设计

- 状态：Adopted（已采纳；部署形态与成员管理已更新进 docs/00/07）
- 日期：2026-08-13
- 关联：[CLI、MCP、Agent Client Protocol 与身份识别](06-cli-mcp-integration.md)、[不同人的 Agent 如何协作](05-federated-agent-collaboration.md)、[架构基线](00-architecture-baseline.md)
- 若与架构基线或已接受 ADR 冲突，以基线和 ADR 为准

## 一句话结论

MVP 支持局域网共享：Project Core + Web 跑在一台机器上监听局域网，团队成员从各自设备通过 CLI 加入团队并执行平台功能；本地执行面（agentd、Worktree、Agent Session）始终留在成员自己的设备上。成员管理、邀请加入与身份认证进入 MVP，PostgreSQL、云端托管与 SSE 实时通知仍留在 P1。

## 1. 与现有地基的映射

| 需求 | 已有设计 |
|---|---|
| 成员通过 CLI 执行平台功能 | docs/06：CLI 是通用操作面（人、脚本、Agent、CI 均可），机器模式稳定 JSON 输出 |
| Agent 在 vibe coding 时操作 CLI | docs/00：CLI 是「所有 Agent 的通用兜底入口」；docs/06：Run Credential 进程注入优先 |
| 成员加入项目 | docs/05：「如何加入项目」是平台统一事项之一，本文给出具体机制 |

## 2. 成员领域模型（最小集）

```text
Principal（人）+ Device（设备）→ Member（项目成员）→ Role
```

- 角色两级：`Owner`（管理成员、确认决策）、`Member`（可被分派任务）。
- 「Agent 权限不能超过所属人的权限」（docs/01 原则 6）：**成员角色是 Agent 权限的上限**。
- Agent Profile（planner/builder/verifier）是职责模板，与人的角色是正交两维；Profile 授权不得超出人的 Role 允许范围。
- 细粒度 RBAC 不进 MVP（P3 再评估）。
- 成员增删、邀请、加入全部进入审计事件（架构不变量 1：所有正式状态变更带 `principal_id`）。

## 3. CLI 加入与身份认证

### 3.1 流程

```text
# Owner 侧（在 Core 所在机器或任意已授权设备）
tsp team invite --role member --ttl 24h
# → 输出一次性邀请码

# 新成员侧（自己的设备）
tsp init --server http://<core-host>:8080
tsp team join <invite-code> --display-name "chen"
# → 邀请码一次性兑换
# → 生成 Principal + 本机 Device + 持久 API Credential（存本地全局配置）
tsp whoami   # 验证身份与项目
```

### 3.2 凭据设计

- 邀请码：一次性、带过期时间（`--ttl`，默认 24h）、带默认角色；兑换即失效并记录审计。
- 持久 API Credential：绑定 Principal + Device，保存于本地全局配置；全局配置只保存 Principal、Device 与服务器地址（docs/06 已定），不保存「当前 Profile」。
- MVP 不做邮箱/密码/SSO——无外部依赖，CLI 通道天然适合。
- 凭据吊销：`team member remove` 使该 Principal 的所有凭据失效；后续再支持单凭据吊销。

### 3.3 传输安全

MVP 局域网使用 HTTP + API Credential 认证；信任边界是局域网本身。自签 TLS 作为可选配置项；公网暴露必须启用 TLS（P1 云端形态再做完整认证与加密设计）。

## 4. 命令集

```text
# 初始化与身份
tsp init --server <url>
tsp team join <invite-code> --display-name <name>
tsp whoami

# 成员管理（Owner）
tsp team invite --role <owner|member> [--ttl 24h]
tsp team member list --json
tsp team member remove <principal-id>
```

其余平台命令（task / evidence / artifact / graph / proposal 等）对所有成员一致，差异只由角色与授权决定。

## 5. Agent 通过 CLI 操作的安全边界

Agent 会话内本就可以执行任意终端命令，所以「Agent 用 tsp」的设计重点不是允许，而是**保证它只能用 Run 身份**：

1. `agentd` 启动 Agent 会话时注入 Run Credential 环境变量（docs/06 身份解析优先级第 1 条）。
2. **Run 环境下禁用身份回退**：没有 Run Credential 时拒绝执行写操作，绝不回退到全局配置中的 Principal 凭据——否则 Agent 可能以人的身份越过 Run 边界（例如去 claim 其他任务、读取他人 Feature）。
3. Core 侧校验与 MCP 完全一致：Run 状态、Task 绑定、Profile 权限、Scope 路径。CLI 与 MCP 共享同一套领域用例与状态转换，不存在两条校验路径。

## 6. 局域网共享部署形态

### 6.1 与单机一体化的差异

```text
单机一体化（原 MVP）              局域网共享（本设计）
├── Core + SQLite（本机）        ├── Core + SQLite（主机，监听局域网）
├── Web Console（本机）          ├── Web Console（主机）
├── tsp（本机）             ├── tsp（成员各自设备，远程连接）
└── agentd + Worktree（本机）    └── agentd + Worktree（成员各自设备）
```

- **执行面不共享**：Worktree、Agent Session、临时文件始终在成员自己的设备上——这保持 Task/Run 隔离模型不变。
- SQLite 保持：单进程 Core + WAL 模式；PostgreSQL 仍是 P1 共享部署选项。
- SSE 实时通知不做：MVP 以轮询/手动刷新获得状态；跨设备推送仍是 P1。

### 6.2 仍然不做

云端托管、公网部署、设备在线状态、任务租约、离线恢复（docs/00 延后清单不变）。

### 6.3 风险

| 风险 | 控制 |
|---|---|
| 局域网内任意人可访问 Core | 邀请码是唯一准入：一次性、短 TTL、兑换审计 |
| HTTP 明文传输 | 信任边界限定局域网；自签 TLS 可选；公网必须 TLS |
| 设备丢失/凭据泄露 | `team member remove` 整体失效 + 审计；后续单凭据吊销 |
| Agent 越权使用人的凭据 | 第 5 节的 Run 环境禁止回退 |

## 7. 对现有文档的影响

- docs/00「MVP 物理部署」从「单人本地」扩为「局域网共享 + 本地执行面」；「Web 首版只做状态和审批界面」随 docs/14 一并细化。
- docs/07 P1 的「用户身份、项目成员和基础权限」条目提前为 MVP 最小集（Owner/Member、邀请加入、API Credential）；PostgreSQL、SSE、完整权限仍留在 P1。
- docs/06 的「CLI 如何识别当前 Run」增加一条硬规则：Run 环境下禁止回退 Principal 凭据。

## 8. 开放问题

1. 邀请码的生成与兑换是否需要在 Web 端重复提供（MVP 只有 CLI 是否足够）。
2. 局域网共享下的并发体验：多人同时操作时的乐观冲突提示（`base_snapshot` 已设计，界面提示待定）。
3. 同一个人多台设备的凭据管理与吊销粒度。
4. 局域网发现机制（mDNS 之类）是否需要，还是手动 `--server` 足够。
