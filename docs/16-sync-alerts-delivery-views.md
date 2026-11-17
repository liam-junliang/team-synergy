# 同步提示与验收/交付视图设计

- 状态：Adopted（已采纳；进入 docs/07 Spike 1/3 实现条目）
- 日期：2026-08-13
- 关联：[团队 Vibe Coding 的上下文同步与 Agent 执行模式](12-team-vibe-coding-context-sync.md)、[编排工作台交互设计](14-orchestration-workbench.md)、[团队成员、CLI 加入与局域网共享设计](15-team-membership-lan-sharing.md)
- 若与架构基线或已接受 ADR 冲突，以基线和 ADR 为准

## 一句话结论

本文补全 5 决策点中的 ③④⑤（任务卡授权区、验收视图、交付视图），并将机制三的团队增量同步产品化为「同步提示」。共同法则：全部视图**事实派生，不新增状态字段**（架构不变量 8）；同步提示的本质是「Run 绑定快照 < 当前快照」这一关系的可视化，分级计算由 Core 确定性完成，不靠 LLM。

## 1. 同步提示

### 1.1 影响计算规则（Core 确定性计算）

新 Snapshot 生成或需求 Revision 确认后，Core 对每个活动 Run 计算 stale 关系：

```text
新快照的变更集（已确认的 Graph Delta / 新 Revision）
  × Task 的 focus_nodes / contracts / 依赖边
  → 求交
  → 无交集 = 不提示
  → 有交集 = 按变更类型分级
```

### 1.2 分级规则与提示内容

| 级别 | 判定规则 | 提示内容 |
|---|---|---|
| 阻断级 | 契约 breaking 变更（major 版本或标记 breaking）；任务依赖被删除；需求 Revision 修改了本任务的验收标准 | 红色横幅：变更类型 + 一句话影响 + 处理动作 |
| 影响级 | 契约兼容变更；需求 Revision 文本更新；相关图节点确认变更 | 黄色版本徽章 `S28 → S29` + 可展开差异面板 |
| 参考级 | 与任务无关 | 不提示 |

原则：**提示但不打断**——不强制停止 Agent，由人/Agent 决定继续或更新基线；但提示必须携带差异摘要，只说「有新版本」而不说「变在哪」是噪音。

### 1.3 差异摘要的固定结构

由领域事件结构化渲染，不依赖 LLM 生成：

```text
[契约] API-CONTRACT-4 v5（breaking）
  变更：登录接口新增必填字段 device_id
  影响：TASK-301 依赖此契约，验收标准 1、2 可能受影响
  处理：[接受新基线] [忽略并记录原因]
```

- 固定字段：`变更类型 / 变更对象 / 变更要点 / 影响面 / 可选处理动作`；
- 「忽略并记录原因」也是审计事件（谁、什么时候、为什么决定基于旧快照继续）；
- 「接受新基线」→ Core 更新 Run 绑定快照 → 生成新的 `diff-since-base.md` 写入工作区 → Agent 经 MCP `task_get_current` 下次调用即见（衔接 docs/13）。

### 1.4 到达渠道（同一事实，三个入口）

| 渠道 | 形态 |
|---|---|
| Web 看板 | 任务卡版本徽章 + 全局「同步」聚合区（批量审阅） |
| CLI | `tsp task status --json` 返回 `stale: true` + 差异摘要 |
| Run 会话内 | MCP `task_get_current` 返回 stale 字段；`diff-since-base.md` 落盘 |

契约漂移定向投递：`API-CONTRACT-4` 更新时，只有依赖它的 Task/Run 收到提示（由 Task 的 `focus_nodes` 与依赖边反向索引），不广播全队——这是「相关子图 Diff」的产品形态（docs/12 机制三）。

### 1.5 MVP 轮询

无 SSE：看板按间隔轮询 stale 计算接口；关键动作前（提交 Artifact、确认交付、验收通过）强制同步检查一次。P1 换 SSE 时界面语义不变（docs/15 第 6 节）。

## 2. 验收视图（决策点④）

### 2.1 证据与验收标准的显式绑定

`evidence_submit` 必须声明覆盖关系：

```yaml
evidence_id: EVD-392
type: verifier_review
acceptance_refs: [AC-1, AC-2]   # 显式声明覆盖哪几条
result: pass
```

Core 维护「验收标准 → 证据」映射并做完整性校验：**有标准没覆盖就不能 verified**（架构不变量 5 直接可视化）。Agent 乱声明无所谓——验收时人看到映射表，缺哪条一眼可见。

### 2.2 验收映射表（核心组件）

```text
TASK-301 验收映射
┌────────────────────────────────────────────────────────┐
│ AC-1 账号不存在与密码错误返回相同响应                      │
│   ✓ self_test EVD-381 (RUN-201)  ✓ verifier EVD-392    │
│ AC-2 第 5 次失败锁定 10 分钟                              │
│   ✓ self_test EVD-383        ✓ verifier EVD-392        │
│ AC-3 单元测试通过                                        │
│   ⚠ 仅 self_test EVD-384，无独立验证证据                  │
└────────────────────────────────────────────────────────┘
[通过并 verified]   [打回 Builder 并附原因]   [请求第二人复核]
```

- 每条证据可点开详情：命令、结果摘要、时间、来源 Run、报告链接；
- 打回必须指向具体验收标准（如「AC-2 证据不足，缺并发场景」），原因进入该 Task 下次 Run 的「已知坑」区（docs/13 回流闭环）；
- 打回后 Task 状态回到 `assigned`（保留原 Claim 历史），而非 `ready`；
- 「请求第二人复核」生成对另一人的 verifier 指派请求——对应 docs/05 的高风险变更第二人复核原则；
- 验收权限 = 分派者 + Owner，MVP 不做复杂审批流。

### 2.3 验收双轴与证据质量分级

验收拆两轴，并排呈现、不合并、不重排、不跨轴加权（docs/21 吸收自 code-review）：

| 轴 | 内容 | 呈现 |
|---|---|---|
| Spec 合规 | 对照验收标准逐条：缺失 / scope creep / 实现错误，引用规格原文 | 左栏 |
| Standards 合规 | 项目规范 + 坏味基线；区分硬违规与判断 | 右栏 |

证据质量分级（docs/21 吸收自 tdd，Verifier 据此决定覆盖是否有效）：

| 反模式 | 判定 | 处理 |
|---|---|---|
| implementation-coupled | 测实现细节而非公共接口（seam） | 降权 |
| tautological | 预期值由被测代码同构推导（自证断言） | 驳回 |
| horizontal-slicing | 批量生成测试快照，对真实变化失敏 | 降权 |

预期值必须来自独立真相源（字面量 / 演算例 / 规格）；重构类变更的证据标记为「无行为变化」，不伪造测试证据。

### 2.4 偏差提案合流（docs/12 机制二的产品化）

验收视图第三栏列出本 Run 回流的 GraphDelta / ChangeProposal，逐条两个动作：

```text
[采纳 → 进入新事实（新 Snapshot / 决策记录）]
[拒绝（附原因）]
```

采纳的偏差在验收通过后随新 Snapshot 生效。**顺序固定：先审偏差，再点通过**，避免「验收了但偏差悬空」。

## 3. 交付视图（决策点⑤）

### 3.1 DeploymentEvidence 字段

```yaml
deployment_evidence_id: DEP-12
feature_id: FEATURE-12
environment: staging
version: v1.4.2
artifact_ref: commit a92f81c
verified_by: user-chen
verification_summary: smoke + 健康检查通过
link: https://ci.example.com/build/123
rollback_of: null          # 回滚时指向原 DEP
recorded_at: 2026-08-13
```

### 3.2 交付时间线

```text
FEATURE-12 用户登录
├─ 08-10 REQ-0142 r3 确认         ← 需求事实
├─ 08-12 TASK-301 verified        ← 验证事实（可展开证据）
├─ 08-13 部署 staging v1.4.2      ← DeploymentEvidence
└─ 08-13 交付确认（user-chen）     ← 人确认，Feature → delivered
```

- 时间线所有节点都是已有事实的引用，零新增状态字段（架构不变量 8）；
- 回滚也是事实：新 DeploymentEvidence 带 `rollback_of`，时间线上显示为红色节点；
- 操作只有两个：`记录部署证据`（表单即上表字段）、`确认交付`（前置条件：全部 Task verified/closed + 至少一条部署证据）。

## 4. 任务卡授权区（决策点③）

```text
TASK-301 [ready]  S28 ⚠   ← 版本徽章（stale 提示入口）
Assignee: user-chen | Profile: builder
[Claim → 创建 Run]         ← 仅 Assignee 可见可点
  └─ 已创建：RUN-201（builder · 08-12 14:00 · 进度：自测中）
```

- Claim 动作 = Core 创建 Run + 短期凭据 + Worktree，随后本地 `agentd` 启动 Agent（人主动启动，docs/06）；
- 卡片不显示「进行中/等待评审」等派生状态——由 Run 事实派生渲染（不变量 8）；
- P2 引入 Claim Policy 后，「Claim」按钮展开为「单次 / 带预算委托」，界面位置不变（衔接 docs/14 第 5 节）。

## 5. 看板全局与待办聚合

```text
Owner 视角「我的待办」：
  · 待确认需求 Revision（决策点①）
  · 待审拆解方案（决策点②）
  · 待验收 Task（决策点④）
  · 待确认交付（决策点⑤）
  · 待处理 stale 提示（跨决策点）
```

待办数量徽章 = 各决策点事实计数的派生。MVP 无 SSE 时这是轮询的入口页。

## 6. 边界情况清单

| 边界 | 处理 |
|---|---|
| stale 提示与「正在提交」的竞态 | 关键动作前强制同步检查 |
| 验收通过后证据被撤回 | Evidence 不可变，仅允许追加修正 |
| 同一契约被多个 Task 依赖 | 反向索引批量投递，不做广播 |
| 打回后 Task 状态 | 回到 `assigned`（保留原 Claim 历史），而非 `ready` |
| 验收通过但偏差提案悬空 | 交互顺序固定：先审偏差，再点通过 |

## 7. 与现有文档的关系

- **已有地基**：docs/12 机制三（增量同步）、docs/13（`diff-since-base.md`、已知坑回流）、docs/14（授权入口）、架构不变量 5/8、docs/15（MVP 无 SSE 轮询）。
- **本文新增**：stale 分级计算规则与差异摘要结构、验收标准 ↔ 证据映射（`acceptance_refs`）、偏差提案合流顺序、DeploymentEvidence 字段与交付时间线、待办聚合页。

## 8. 开放问题

1. 阻断级提示的处理时限：要不要超时升级（如 24h 未处理变为全局提醒）。
2. 验收映射表对「部分覆盖」的证据（一条证据只覆盖部分标准）的呈现细节。
3. `tsp` 下 stale 摘要的输出格式（JSON 字段结构）。
4. 交付时间线的 Feature 之外层级：Project 级版本轨迹是否需要（P1 再评估）。
