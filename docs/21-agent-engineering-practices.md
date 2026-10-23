# Agent 工程实践吸收：mattpocock/skills 评估

- 状态：Adopted（评估结论已落进 docs/02/13/16）
- 日期：2026-08-13
- 来源：[github.com/mattpocock/skills](https://github.com/mattpocock/skills)（MIT，215k stars）
- 评估方式：三个并行子代理精读 14 个 SKILL.md 与配套文档，逐条对照平台已有设计

## 1. 总体判断

该技能集围绕 Agent 开发的四个失败模式组织，与平台的问题域逐一对得上：

| Matt 的失败模式 | 他的解法 | 平台的对应设计 |
|---|---|---|
| Agent 没做对（对齐缺失） | grill 访谈 | 需求工作台（docs/17）澄清区 |
| Agent 太啰嗦（术语漂移） | 共享语言 CONTEXT.md | Context Pack 决策密度（docs/13） |
| 代码不工作（反馈缺失） | tdd / diagnosing-bugs | Evidence + Verifier（docs/16） |
| 代码变泥球（架构腐化） | to-spec / 架构调查 | 编排审阅（docs/14）+ 双轴验收 |

吸收原则：**吸收「具体技法」，拒绝「全自动出口」**——骨架（决策-拆分-依赖-状态机-人确认）与平台同构，印证了平台方向；但其「Agent 免审发布」类设计违反平台「人确认」原则，一律拒绝（见第 3 节）。

## 2. 吸收清单（已落进正式文档）

### 2.1 Task 拆分与契约（→ docs/02、docs/14）

| 技法 | 来源 | 内容 |
|---|---|---|
| 垂直切片 | to-tickets | Task 必须穿越所有层（schema/API/UI/测试）且完成即可演示；尺寸上限 = 单个 context window；禁止水平分层切片 |
| 验证接缝前置 | to-spec / tdd | Task 契约新增 `validation_seams`：先声明测试切入点（公共接口边界、测试位置），随草案进人工审阅 |
| expand–contract 序列化 | to-tickets | 大 blast-radius 变更不切片：先加新形式 → 按范围分批迁移调用点 → 删除旧形式，每批一个 Task，全部阻塞一个 integrate-and-verify Task |
| fog of war | wayfinder | 能精确陈述问题才建 Task；暂不能的留在「未定事项」区，随 frontier 推进毕业 |

### 2.2 验收与证据（→ docs/16）

| 技法 | 来源 | 内容 |
|---|---|---|
| 双轴验收 | code-review | 验收拆两轴：Spec 合规（对照验收标准逐条报缺失/越界/实现错误，引用规格原文）+ Standards 合规（项目规范 + 坏味基线，区分硬违规与判断）；并排呈现、不合并、不重排、不跨轴加权 |
| 证据质量分级 | tdd | 三个反模式 → 证据降权/驳回：implementation-coupled（测实现细节）、tautological（自证断言）、horizontal-slicing（批量测试快照）；预期值必须来自独立真相源 |
| 固定点钉住 | code-review | 验收前钉住 commit/merge-base；引用无效或 diff 为空时在派生子代理前失败 |

### 2.3 Context Pack（→ docs/13）

| 技法 | 来源 | 内容 |
|---|---|---|
| 术语表组件 | domain-modeling / CONTEXT.md | `glossary.md` 进 Pack：术语 + `_Avoid_` 禁词 + 术语关系 + 已裁决歧义记录；按任务裁剪分发；「废弃词汇显式登记」防止 Agent 间术语漂移 |
| 信息层级 | writing-for-agents | 常驻必读卡 vs 指针按需拉取，用 branching test 判定「每条分支都需要的留在常驻，部分分支触达的藏到指针后」 |
| 环境是真相源 | writing-for-agents | Pack 不缓存 repo 内可直接查到的内容（package.json、git log、代码），只打包 Agent 查不到的：未写下的约定、决策理由、坑 |
| completion criteria | writing-for-agents | 每个注入单元以可检验的完成标准收尾，防「过早完成」 |

### 2.4 需求澄清与决策治理（→ docs/17、docs/02）

| 技法 | 来源 | 内容 |
|---|---|---|
| frontier 分轮问询 | grilling | 澄清问题建模为设计树：每轮只问「前置已决」的问题集，附推荐答案；事实归 Agent 查、决策归人定；回答落地后重算 frontier |
| Decision 入库门槛 | domain-modeling | ADR 三条件：难以逆转 + 缺上下文会令后人惊讶 + 真实权衡的结果，三者齐备才入库，防决策库泛化为流水账 |
| 拒绝知识库 | triage / OUT-OF-SCOPE | 被拒 Proposal 按概念留痕（范围哲学/技术约束/战略决策，禁「太忙」类临时理由）+ 去重；「已实现」不写入 |

### 2.5 Defect（→ docs/19）

| 技法 | 来源 | 内容 |
|---|---|---|
| Verify before grill | triage | triage 先复现/跑测试再向 reporter 索要信息；验证结果分级（confirmed / failed / insufficient detail）驱动状态迁移 |

## 3. 拒绝清单（平台坚持「人确认」）

| 拒绝项 | 来源 | 理由 |
|---|---|---|
| Agent 生成 spec 后免审直接发布 | to-spec | 平台：spec/Revision 必须进人工审阅门禁（docs/17 确认动作） |
| Agent 拆解后默认打 ready 标签 | to-tickets | 平台：状态迁移由工作台显式确认，Agent 不顺手置 ready |
| Agent 解决决策条目后自行 close | wayfinder | 平台：Agent 提交 resolution 留痕，人（或受审规则）确认后关闭 |
| 本地 markdown 文件充当 tracker 的降级路径 | to-tickets / wayfinder | 平台已有结构化领域模型（Requirement/Task/Decision），无需降级实现 |

## 4. 已验证平台方向（无需改动）

- Requirement 不可变版本 ← to-spec「spec 是发布物而非实现细节」+「brief 是合同，讨论只是上下文」；
- Task 依赖显式化与 blockers-first ← to-tickets blocking edges；
- Proposal→Decision ← wayfinder decision tickets +「Plan, don't do」；
- Defect triage 状态机 ← triage 5 状态机 + needs-info 回流 + 维护者 override；
- 编排工作台人工审阅拆解 ← to-tickets 的 Quiz（粒度/依赖边/合并拆分三问）。

## 5. 后续可评估项（未本轮落地的）

- handoff 一等原语：Agent 阶段结束的交接文档（压缩 + 指针集）——观察平台「偏差回流」是否已覆盖该需求，TASK-102 后再评估；
- 建议的 skill 清单可复用于平台自身的开发 Agent（dogfooding 的开发辅助）：tdd、code-review 两轴直接作为本仓库开发纪律。
