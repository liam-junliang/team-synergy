# 软件工程实体补齐与列表视图规范

- 状态：Proposal（讨论沉淀，作为 MVP 领域模型与 Backlog 的设计输入）
- 日期：2026-08-13
- 关联：[领域模型与协作流程](02-domain-model-and-workflow.md)、[同步提示与验收/交付视图设计](16-sync-alerts-delivery-views.md)
- 若与架构基线或已接受 ADR 冲突，以基线和 ADR 为准

## 一句话结论

补齐软件工程协作的真实缺口：新增 `Defect` 实体承接「测试后 bug 提交入口」，Task 增加来源分类（requirement / ad-hoc / defect-fix / integration）；燃尽图、里程碑等项目管理视图由已有事实**派生**，不新增状态字段。同时制定列表/看板视图规范，解决数据量增大后的可读性。

## 1. Defect 实体：bug 提交入口

### 1.1 生命周期

```text
reported → triaged → fixing → retest → closed
   │          │         │       └→ triaged（回归失败，重新修复）
   └──────────┴─────────┴────────→ rejected（非缺陷/重复/无需处理）
```

### 1.2 核心字段

```yaml
defect_id: DEF-7
title: 锁定计数在密码重置后未清零
feature_id: FEATURE-12
severity: medium            # critical / high / medium / low
reported_by: user-wang      # 测试、使用者或 Verifier Run
found_in: v1.4.2            # 发现环境/版本
action_steps: 锁定测试账号后重置密码，用新密码再次登录
expected_result: 登录成功，锁定计数清零
actual_result: 登录仍返回账号已锁定
evidence:
  - kind: text
    text: 'POST /login → 423 account_locked'
description: 补充说明或历史原文
related_requirement: REQ-0142  # 可选
status: reported
fix_tasks: [TASK-305]       # 由 tasks.defect_id 反查，可有多轮修复任务
reported_at: 审计事件时间  # 由 defect.reported 事件派生
```

新手工报告须填写操作、预期和实际结果，并附至少一项证据。证据可用日志或响应文本、HTTP(S) 链接和原始文件，可混合提交。每份报告最多 20 项，附件合计最多 6 MiB。列表返回文件名、大小和摘要，项目成员可按证据下标下载原件。旧记录保留原始说明。从失败测试创建缺陷时，系统沿用执行时保存的步骤、预期、实际结果和已有证据。

```sh
tsp defect report --feature <feature_code> --severity medium --title "重置密码后仍显示已锁定" --action "重置后用新密码登录" --expected "进入首页" --actual "返回 423" --evidence-text "POST /login → 423 account_locked" --evidence-file ./login.png
tsp defect list --project <project_code>
tsp defect download <defect_code> 1 --out ./report-screenshot.png
```

### 1.3 状态约束

- `fixing` 必须关联 `source=defect-fix` 且 `task.defect_id` 精确指向当前 Defect 的修复 Task；只校验同项目不够；
- 修复 Task 与 Defect 必须属于同一个 Feature；其他来源的 Task 禁止写入 `defect_id`；
- `fixing → retest` 前至少一个关联修复 Task 必须达到 `verified` 或 `closed`；
- `retest → closed` 由项目 Owner 或 Admin 确认回归通过。回归失败走 `retest → triaged`，再创建下一轮修复任务。
- 修复 Task 的验收标准由 triage 时人确认的「期望行为」生成，不是 Agent 自行定义；
- Defect 增改与状态变更进入审计事件（架构不变量 1）。

### 1.4 入口与流程

```text
入口：项目「缺陷」工作台的「提交缺陷」弹窗 / 后续 Verifier Run 提交
流程：报告 → 项目 Owner 或 Admin 分诊、关联修复 Task
     → 修复 Task 走既有 Claim → Run → Artifact/Evidence 闭环
     → 关联 Task 完成验证后进入回归 → 项目 Owner 或 Admin 确认 close 或重新修复
```

有项目写权限的成员可以上报。成员 Agent 通过 CLI 操作时使用其所属账号的项目权限。

### 1.5 Web 工作台

- 顶部统计待确认、修复中和待回归数量，主操作仅保留「提交缺陷」；
- 缺陷队列使用紧凑表格，每行一项。可按状态和严重度筛选，默认显示未结束项。
- 打开某行的详情即可核对操作、预期、实际、证据和流程进度，也可查看关联需求或修复任务。
- 在详情按当前角色分诊、安排修复或处理回归。修复任务的简报带入缺陷事实和证据，供执行者接手。
- 缺陷页负责分诊和关联，任务的分派、领取、提交和验收继续由任务看板承担。

## 2. Task 来源分类

| 来源 | 含义 | 与 Requirement 的关系 |
|---|---|---|
| `requirement` | 从已确认 Requirement Revision 拆解 | 必须绑定 |
| `ad-hoc` | 临时任务（修 CI、写脚本、补文档） | 不绑定 |
| `defect-fix` | 修复某个 Defect | 绑定 Defect（可选关联 Requirement） |
| `integration` | 对接/联调任务 | 不绑定；可引用外部系统契约 |

共性约束不变：所有 Task 仍必须有验收标准才能 `ready`（架构不变量 2）、有 Evidence 才能 `verified`。ad-hoc 任务的验收标准由提出人确认（与需求确认同一动作模式，只是没有 Requirement 承载）。

## 3. 项目管理视图：派生而非新增状态

| 视图 | 来源事实 | 阶段 |
|---|---|---|
| 燃尽图 | Task 状态变化的时间序列（审计事件） | P1（纯统计视图） |
| 里程碑/版本计划 | Release 作为 Decision 的聚合投影 | P1（Release 正式领域对象再评估） |
| 评审记录 | Proposal → Decision 审计流 | 已可派生，界面 P1 |
| 甘特图、迭代规划 | — | 延后（自有模型站稳后） |

原则：视图落后于事实可以接受（重新派生即可），事实落后于视图会污染协作——所以一律事实先行。

## 4. 列表与看板视图规范

### 4.1 列表类（需求表/任务表/证据表/Defect 表）

- 必须支持：状态筛选、负责人/Feature 筛选、分页、列排序、关键词搜索；
- 默认视图 = 需要人决策的事项（draft / clarifying / ready 待分派 / submitted 待验收 / reported 待 triage），confirmed / closed 默认折叠进「已办」；
- 行数超阈值（建议 50）默认分页，页大小可调；
- 表格行永远显示稳定 ID + 状态徽章，其余列可配置显隐。

### 4.2 看板类

- 每列折叠：显示前 5 张卡 + 「还有 N 项」，点击展开；
- 按 Assignee 泳道可选；
- 列头显示 WIP 计数（派生），不强制 WIP 限制（docs/07 风险控制项）。

### 4.3 图类

- MVP 依赖图范围小（单 Feature 约 10 任务），不做折叠；数据大时按 focus 裁剪（docs/09 已有设计）。

## 5. 逻辑验证方式

原型是静态展示，逻辑权威在领域层（docs/00 不变量 + 各状态机）。验证分两步：

1. **走查清单（现在）**：`prototype-design/VERIFICATION.md` 按页面列出应验证的逻辑点，人对照原型逐条走查；
2. **可执行断言（Spike 1 时）**：领域层实现时，清单中每条规则转成纯函数 + 断言测试（沿用 `tests/context-graph.test.mjs` 先例），`node --test` 全绿即逻辑自洽。原型中按钮的禁用理由与领域函数共用同一规则，展示与逻辑不脱节。

## 6. 与现有文档的关系

- **新增领域**：Defect 实体、Task 来源分类 → 并入 docs/02 领域模型、docs/00 核心领域清单、docs/07 Backlog。
- **新增视图规范**：本文第 4 节作为 Web 实现的界面规范，进入 docs/07 Spike 1。
- **原型落地**：`prototype-design/large-data.html` 演示筛选/分页/折叠与缺陷登记入口。

## 7. 开放问题

1. Defect 与外部缺陷系统（GitHub Issues 等）的关系：沿用 Adapter 原则，MVP 只做自有 Defect，同步延后。
2. severity 是否需要升级/降级流程（MVP 只记录，不流转）。
3. ad-hoc 任务的验收标准确认人：提出人自己确认 vs Owner 确认。
4. Release 正式领域对象的价值阈值：出现「跨 Feature 版本交付」真实需求时再评估。
