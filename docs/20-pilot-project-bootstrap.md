# 试点计划：平台自举（Dogfooding）

- 状态：Confirmed（试点项目已确定为平台自身）
- 日期：2026-08-13
- 关联：[路线图与 MVP Backlog](07-roadmap-and-backlog.md)、[架构基线](00-architecture-baseline.md)
- 本文解决 docs/07 遗留的唯一外部输入：「首个真实仓库、功能和验收标准」

## 一句话结论

平台的第一个试点项目就是**平台自身**：把本仓库注册为 PROJECT-A「Team Synergy」，用平台的领域格式（Requirement Revision、Task 契约、Evidence）管理平台自己的开发。Spike 1 完成 Core + CLI 后进入自举点：backlog 迁移进平台自己的 SQLite，进度由平台事实派生。

## 1. 试点项目定义

```yaml
project_id: PROJECT-A
name: Team Synergy
repo: F:\workspace\team-synergy
deployment: 局域网共享（docs/15 形态）
team:
  - principal: user-chen
    role: Owner
    profiles: [planner, builder, verifier]   # 身兼多职（docs/05）
  - 第二人复核：高风险变更时邀请一位外部成员做 verifier
```

Mock 原型中的 PROJECT-A、FEATURE-12 等数据在此获得真实对应物。

## 2. Dogfooding 的三阶段推进

```text
阶段 0（现在）：用平台格式描述试点工作（本文档 + 首批需求转译）
             → 领域格式首次实战，格式问题即时回流
阶段 1（Spike 1 中）：实现 Core + CLI 后，把本文档的 REQ/TASK 导入平台
             → 自举点：后续开发在平台内跟踪，docs/07 变为投影
阶段 2（Spike 1 后）：Web 完成后，人走 5 决策点界面，Agent 走 CLI/MCP
             → 平台管理平台自己的完整闭环
每个阶段结束：记录「平台作为试点暴露的问题」→ 回流设计文档

**进度（2026-08-13 收尾）**：TASK-101~112 全部 closed，Spike 1 功能范围交付完成（docs/07 已标记）。试点全周期验证的核心结论：
- 「项目共同状态 + Context Pack + 验收标准」让 codex 两个真实任务（TASK-107/108）一次通过人 review，无返工；
- 平台审计流全程可查（8 动作），第二人验证落地为强制流程而非仪式；
- 试点暴露并回流的工程问题均已修复（迁移随构建打包、bootstrap Owner、PowerShell 参数传递、验证 Run 语义）。
- **遗留延后**：局域网多机实测（需第二台设备）、邀请码/设备凭据、Agent 准确率对比测量。

```

## 3. 首批需求转译（Spike 1 → 平台 Requirement）

| REQ | 标题 | 验收标准（来自 docs/07 成功标准） |
|---|---|---|
| REQ-0001 | 任务闭环最小链路 | Planner 创建版本化 Feature Context 与验收标准；Builder 在独立 Worktree 获取任务并发布 Commit Artifact；Verifier 在独立 Run 读取同一验收基线并提交 Evidence；Core 准确派生状态；两个并行 Run 互不共享目录/凭据/MCP Session；任务结束可预览、归档和安全清理 |
| REQ-0002 | 成员与 CLI 局域网接入 | Owner 生成邀请码；成员 `tsp team join` 后在各自设备执行平台功能；Agent 操作 CLI 只能用 Run 身份（docs/15 第 5 节） |
| REQ-0003 | 需求与编排工作台 | 需求双态分界、提取卡来源标注、Revision 确认；编排候选流审阅、编排对话条重拆、依赖图、风险前置拦截（docs/14/17） |
| REQ-0004 | 验收交付视图与 stale 提示 | 验收标准↔证据映射与完整性校验；stale 分级与差异摘要；交付时间线只记事实（docs/16） |
| REQ-0005 | Defect 闭环与任务来源分类 | 缺陷登记 → triage → 修复 Task → 复测 Evidence → close；ad-hoc/defect-fix/integration 任务走同一不变量（docs/19） |

## 4. 首批任务拆解（REQ-0001 的第一批 Task 草稿）

```yaml
- task_id: TASK-101  # ✅ 已完成（2026-08-13）：evidence: pnpm build/test/typecheck 全绿（15 测试）、/health 实测 contracts+domain 链路
  source: requirement       # REQ-0001
  title: 建立 TypeScript Monorepo 与共享 Contracts
  profile: builder
  acceptance: [pnpm workspace 可安装, contracts 包可被 apps/packages 引用, 无 Schema 重复]

- task_id: TASK-102  # ✅ 已完成（2026-08-13）：evidence: 不变量 1-11 均有领域函数，22 条 domain 测试全绿
  source: requirement
  title: 实现核心领域对象、状态机与审计事实
  profile: builder
  acceptance: [docs/00 不变量 1-11 有对应领域函数, 状态转换被拒绝时返回原因, node --test 全绿]

- task_id: TASK-103  # ✅ 已完成（2026-08-13）：evidence: 16 表 schema + 迁移入库，6 条 persistence 测试全绿（外键/索引/CTE/迁移重跑）
  source: requirement
  title: 实现 SQLite Repository 与迁移
  profile: builder
  acceptance: [外键与端点索引齐全, 迁移可重复执行, Recursive CTE 遍历通过]

- task_id: TASK-104  # ✅ 已完成（2026-08-13）：evidence: tsp task 四命令 + application 用例层，49 条全仓测试全绿
  source: requirement
  title: 实现 tsp task list / claim / status / submit
  profile: builder
  acceptance: [机器模式输出稳定 JSON, Claim 校验 Assignee 与依赖, 自测 Evidence 才能 self_tested]
  dependencies: [TASK-102, TASK-103]

- task_id: TASK-105  # ✅ 已完成（2026-08-13）：evidence: git worktree 创建/识别/清理 + workspace.yaml + tsp workspace 命令，60 条全仓测试全绿

- task_id: TASK-106  # ✅ 已完成（2026-08-13）：evidence: codex review 6 阻断/8 重要/2 建议修复（重要 4 与 CHECK 约束 2 项顺延），80 条全仓测试全绿，修复对照见 .reasonix/code-review-report.md
  source: requirement
  title: 实现原生 Git Worktree 创建与 workspace.yaml
  profile: builder
  acceptance: [Run 绑定独立 Worktree, workspace.yaml 记录基线, 冲突保护与回收区 dry-run]
  dependencies: [TASK-104]
```

剩余 Spike 1 条目（成员/局域网、Context Pack、三个工作台、stale、Defect）按相同方式在阶段 1 导入平台时拆解；本文档只固定首批 Task 粒度作为格式示例。

## 5. 自举点与之后

- 阶段 1 完成后：REQ/TASK 全量导入平台 SQLite；docs/07 的 checkbox 变成平台的 Task 状态投影；
- 之后每个新功能 = 平台的真实 Feature：需求讨论 → 确认 Revision → 编排拆解 → Claim → 独立 Worktree → 证据 → 验收 → 交付；
- 开发过程本身持续检验平台设计：格式痛点、交互痛点、同步痛点直接回流 docs/12-19。

## 6. 试点暴露问题的记录位置

每阶段结束在本文追加「阶段 N 复盘」小节，格式：

```text
问题 / 触发场景 / 涉及设计文档 / 处置（已改文档 / 进 backlog / 延后）
```
