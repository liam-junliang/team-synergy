# Context Pack 详细设计

- 状态：Adopted（已采纳；进入 docs/07 Spike 1 实现条目）
- 日期：2026-08-13
- 关联：[工作区与功能上下文](04-workspace-and-context.md)、[项目上下文图](09-project-context-graph.md)、[团队 Vibe Coding 的上下文同步与 Agent 执行模式](12-team-vibe-coding-context-sync.md)
- 本文是对 [docs/04](04-workspace-and-context.md)「功能上下文包」章节的深化；若与[架构基线](00-architecture-baseline.md)或已接受 ADR 冲突，以基线和 ADR 为准

## 一句话结论

Context Pack 存在的唯一理由是「代码里读不出来的信息」：Agent 自己会读仓库代码，Pack 不放代码能告诉它的东西，只放**已确认的决策、显式的未知和导航地图**。它的设计目标不是信息最全，而是**单位 token 的决策确定性最高**——vibe coding 的偏差几乎全部来自「不知道已经定了什么」和「不知道什么还没定」。

## 1. 设计原则

| 原则 | 含义 |
|---|---|
| 1. 决策密度优先 | 大段描述性文档不进 Pack；已确认决策 + 理由摘要进 Pack |
| 2. 必读卡 + 按需展开 | L0 一次性注入（约 2k token），其余靠 MCP 按需拉取，不预装 |
| 3. 显式未知区 | `open_questions` 与未确认接口单独成区；规则是禁止静默假设——遇到未知要么提问、要么提交带标注的假设 |
| 4. 事实分层标注 | 沿用 `confirmed / inferred / proposed`：Agent 必须知道哪些是硬约束、哪些只是扫描结果 |
| 5. 可度量 | 接入 docs/07 Spike 1 的测评：验收一次通过率、澄清问题数、token 用量、偏差提案数 |
| 6. 环境是真相源 | Pack 不缓存 repo 内可直接查到的内容（package.json、git log、代码本身），只打包 Agent 查不到的：未写下的约定、决策理由、坑（docs/21 吸收自 writing-for-agents） |

## 2. L0 必读卡：会话第一条消息

整个 Pack 的心脏，渲染成自然语言单页直接注入会话：

```text
# TASK-301 实现认证失败统一响应与锁定策略
快照: 28 | 基于 REQ-0142.r3 | 工作树: <worktree-path>

## 做什么（边界）
- 统一失败响应；第 5 次连续失败锁定 10 分钟
- 不做：第三方登录、密码找回

## 怎么做才算对（验收标准）
1. 账号不存在与密码错误返回相同响应
2. 锁定策略可通过测试验证

## 红线（do / don't）
- 只可写: services/auth/**, tests/auth/**
- 不可改: 公共错误码定义、限流键格式（DEC-117）

## 已确认决策（必须遵守）
- DEC-117: 限流键 = 用户ID+IP，锁定 10 分钟（理由：防用户名枚举）

## 未决问题（禁止静默假设）
- 锁定计数是否需要重置策略？未确认 → 先按不重置实现，并在提交时标注假设

## 契约（去哪查，不含全文）
- API-CONTRACT-4（摘要：错误码结构 / 400 语义）→ 按需拉取

## 术语（本任务涉及的共享语言）
- 锁定策略：第 5 次连续失败后锁定 10 分钟（完整定义见 glossary.md）

## 命令约定
- 测试: pnpm test auth  构建: pnpm build  检查: pnpm lint

## 已知坑（来自上次失败 Run 的 Evidence 摘要）
- RUN-197 曾在错误码层级上被 Review 打回：错误码必须是两级结构

## 参考实现（可选，任务需要时才有）
- REF: FEATURE-08 的锁定实现可作范例 → services/auth/lockout.ts
```

「未决问题」和「已知坑」是准确率提升最直接的两块：分别防**静默假设**和**重复踩坑**。参考实现为可选字段：默认不出现、不占预算；由 Planner 在拆任务时按需引用同类已完成任务，被引用时必须已 `verified`/`closed`。

## 3. 工作区中的文件布局

衔接 docs/04 的 `project-state/`：

```text
/workspace/project-state/
├── brief.md                    # L0 必读卡（自然语言渲染，注入会话）
├── pack.yaml                   # 结构化版本（MCP 可查询）
├── requirements/REQ-0142.r3.md # 本任务需求 Revision 的裁剪片段
├── contracts/                  # 契约摘要 + 引用（非全文）
├── decisions/                  # 相关 Decision 摘要
├── glossary.md                 # 术语表（术语 + _Avoid_ 禁词 + 关系 + 已裁决歧义，按任务裁剪）
├── graph/task-subgraph.json    # Task 子图投影（结构化，供工具查询）
├── diff-since-base.md          # 增量：与本任务事实基线的差异
└── unresolved.md               # 显式未知清单（Agent 可提交假设）
```

`brief.md` 与 `pack.yaml` 是同一内容的两种形态——一个喂会话、一个喂工具，由 Project Core 从同一份事实渲染，避免两处维护。

## 4. 三层供给与预算分配

细化 docs/04 的三层供给：

| 层 | 内容 | 预算（8k 示例） | 获取方式 |
|---|---|---|---|
| L0 必读卡 | 决策、红线、验收、未知、坑 | ~2k | Claim 时注入会话 |
| L1 常查 | 契约摘要、规则详情、模块地图 | ~6k | MCP `graph_get_*` 按需 |
| L2 深查 | 文件、符号、调用链、历史 | 不占 Pack 预算 | Agent 读 Worktree + MCP 展开 |

子图投影排序不按图结构平均分配 token，而是按**决策密度**：`business_rule / decision > contract > module > code > test`。

明确不进 Pack 的内容：

- 完整代码（Agent 直接读 Worktree 仓库）；
- 讨论记录（只留在需求工作台，确认后的 Revision 才进 Pack）；
- 大段描述性文档（保留引用，不复制内容）。

## 5. 生成、刷新与回流闭环

```text
Claim 时：模板 + 人工确认内容 + Task 子图投影 → 渲染 Pack → 绑定 Snapshot
会话中：版本心跳发现新 Revision → 生成 diff-since-base.md → 标记 stale（不打断）
Run 后：偏差提案（GraphDelta / ChangeProposal）→ 人确认 → 进入下一版 Pack
```

Pack 不是静态文件，而是「版本化事实 + 本任务投影 + 上一轮偏差回流」的渲染结果。[docs/12](12-team-vibe-coding-context-sync.md) 机制三的 `diff-since-base` 在此落到具体文件。

生成与置信度的关系（与 docs/07 已定方向一致）：

- `confirmed` 内容来自人工确认与已生效契约，直接进入 Pack 决策区；
- `inferred` 内容来自扫描，进入 Pack 时必须带来源标注，不得与 `confirmed` 并列呈现；
- `proposed` 内容（历史 Run 的偏差提案）只有在人确认后才进入下一版 Pack。

## 6. 度量指标

接入 docs/07 Spike 1 的「比较完整文档与 Task 子图」测评：

| 指标 | 说明 |
|---|---|
| 验收一次通过率 | 首要准确率指标 |
| 澄清问题数 | 越低越好，反映「显式未知区」是否充分 |
| 首轮 token 用量与总耗时 | Pack 是否又准又省 |
| 偏差提案数与确认率 | 回流机制是否被真实使用 |

## 7. 与现有文档的关系

- **已有地基**：docs/04 的 Feature Context Pack 结构与三层供给、docs/09 的 Task Context Projection（focus / depth / token_budget）、Graph Delta、verification/freshness 双维度。
- **本文新增**：L0 必读卡的具体分块（含红线、未决问题、已知坑、可选参考实现）、`brief.md + pack.yaml` 双形态、决策密度排序、生成/刷新/回流闭环、度量指标。

## 8. 开放问题

1. 必读卡各分块的长度上限与总预算的默认值（2k 是否合适，需在 Spike 1 实测）。
2. 「已知坑」的来源与去重：多个失败 Run 的 Evidence 摘要如何合并、何时衰减。
3. `diff-since-base.md` 的生成规则：哪些事实变更对「正在进行的 Run」值得提示（参考机制三的契约漂移）。
4. 参考实现引用的完整规则：谁能引用、被引用任务的失效与回滚如何处理。
