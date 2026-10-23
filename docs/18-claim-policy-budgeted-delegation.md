# Claim Policy：带预算的委托设计

- 状态：Adopted（已采纳；进入 docs/07 P2 条目）
- 日期：2026-08-13
- 关联：[团队 Vibe Coding 的上下文同步与 Agent 执行模式](12-team-vibe-coding-context-sync.md)、[CLI、MCP、Agent Client Protocol 与身份识别](06-cli-mcp-integration.md)
- 若与架构基线或已接受 ADR 冲突，以基线和 ADR 为准

## 一句话结论

「自动领取任务」的复杂度主要来自常驻执行面与任务租约，但存在一个不需要常驻进程的过渡形态——**顺延领取（chain-claim）**：人在场启动第一次 Claim（带 Policy），agentd 在每次 Run 结束时检查 Policy 剩余预算并自动启动下一个任务，预算耗尽或触发停止条件即停、交人收口。本文给出 Claim Policy 的完整领域设计；完全无人值守（常驻 Bridge + 云端唤醒）仍延后。

## 1. 与无人值守的解耦

```text
顺延领取（本设计）：人在场启动 → Run 结束时顺延下一个 → 预算/停止条件收口
                     agentd 只在上一个 Run 生命周期内「多问一句」，无需常驻
无人值守（仍延后）：设备开机即待命、云端唤醒、任务租约、离线恢复 → 常驻 Bridge
```

## 2. 领域对象

```yaml
claim_policy_id: POLICY-3
type: decision                    # 以 DECISION 记录承载：可版本化、可审计
author_principal: user-chen       # 授权人（人）
orchestrator: planner             # 允许执行分派的编排者 Profile
scope:
  feature_ids: [FEATURE-12]
  task_filter:
    states: [ready]
    max_parallel: 2               # 同时进行的最大 Run 数
budget:
  max_tasks: 3
  max_duration_per_task: 30m
  max_total_duration: 2h          # 可选
stop_conditions:
  - task_failed                   # 任何任务失败即停
  - verification_rejected         # 验收打回即停
  - budget_exhausted              # 内建
approval:
  submit_requires_human: true     # 固定 true：提交后必须人验收
expiry: 24h
status: active
```

## 3. 状态机

```text
active → budget_exhausted → completed（全部验收通过，人确认收口）
active → task_failed / verification_rejected → halted（人处理）
active → revoked / expired
```

## 4. 安全不变量

1. **Policy 是 DECISION**：创建即生效、可版本化；创建/撤销只有人能操作，Agent 只能消费。
2. **授权不越权**：Policy 的范围过滤在 Core 执行，编排者无法通过 Policy 触达授权人看不到的 Feature（架构原则 6）。
3. **审计链完整**：每个自动 Claim 记录 `policy_id` + 编排者 + 时间——「谁授权了这次自动执行」始终可回答。
4. **授权领取、不授权验收**：`submit_requires_human` 固定为 true——Policy 只覆盖「领取和执行」，验收与交付确认永远是人。
5. **失败即停，不自动重试**：halted 后需人重新授权或续期，Agent 不能自行重启。

## 5. 编排者的角色

Policy 边界内，编排者（planner Profile）决定「先领哪个、并行几个」。MVP/P2 的编排决策是**确定性算法**（依赖拓扑排序 + `max_parallel` 限制 + 优先级），Agent 只处理异常（阻塞、澄清需求）；复杂自主编排推理不做——这是「编排者 Agent」与「编排确定性算法」的边界。

## 6. 与领域模型的关系

- Claim 增加可选的 `policy_id` 来源字段，其余领域对象不变；
- 与 docs/14 的授权入口合流：任务卡与确认分派处的「单次 Claim / 带预算委托」选项；
- 与 docs/16 的验收视图衔接：halted 状态的 Policy 在待办聚合中出现「处理失败任务」条目。

## 7. 开放问题

1. `max_duration_per_task` 超时的处理：标记失败还是挂起等待人工决定。
2. Policy 续期/修改的规则：active 状态下能否修改预算（建议：修改 = 新版本，需重新确认）。
3. 顺延领取与并行（`max_parallel`）的实现位置：agentd 内 vs Core 触发。
4. 编排确定性算法与 WIP 限制（docs/07 风险控制）的关系。
