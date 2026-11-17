# 从想法、需求到交付证据

固定草稿快照 `256f8b15f9dc0fa80e7f56aa9d1b2b59f4ef5104a16926dfbc9ad47f4b64137b`，基准提交 `92728fbec04cfa34fee4421cb0a9319d1b755164`。本文路径相对该快照。

**intent**　团队希望追溯需求的来由、决策依据及交付验证。以下 **observed_in_code** 描述当前实现。示例中的人员与先后安排属于 **inference**，实际项目可以分别启动这些流程。

## 围绕一条验收条件协作

产品成员把想法归入议题并写出备选方案。管理者可以在议题作出决定。文档维护人可以就特定修订发起评审；即使已有投票，负责关闭评审的管理者仍需给出明确结论。经过确认的需求可以选定修订进入基线。开发者领取任务时看任务所绑定的需求或基线，然后提交实现产物和自测证据。独立验证证据决定任务能否进入 verified。如果测试执行留下失败结果，测试成员可关联缺陷，修复任务通过验证后再进入回归。

| 工作材料 | 能向下一位成员交代什么 | 接手时核对 |
| --- | --- | --- |
| 议题、备选和决定 | 谁在何时作出哪项决定，议题有无因反馈重开 | 议题状态、条目类型、作者、被替代的决定 |
| 需求文档评审与基线 | 评审人针对哪份文档，哪些需求的指定修订被固定 | 文档修订、评审结论、基线父版本及内容哈希 |
| Task、Run、产物与验证 | 执行身份、被验收的产物、对应自测及验证依据 | 验收条件、任务状态、证据类型、执行 profile |
| 测试执行与缺陷 | 实测环境、版本、结果和失败后的修复去向 | 用例修订、复现依据、缺陷绑定、修复任务状态 |

### 讨论如何成为决定

**BR-TOPIC-DECIDE**　可写成员在未归档议题添加记录。决定要求项目管理权限，事务保存作者、正文、可选理由、替代项及审计，议题变为 decided；已决定议题收到 feedback 转为 reopened。

源码依据　`packages/application/src/requirement-collaboration-use-cases.ts:321-352`。

### 评审针对哪个版本

**BR-REVIEW-REVISION**　发起者须符合文档维护或管理条件，评审绑定文档当前修订，已有该修订评审则复用。open 时，有项目写权限的成员可更新自己的一票；管理者明确提交结论并在事务中关闭。

源码依据　`packages/application/src/requirement-collaboration-use-cases.ts:434-448`、`packages/application/src/requirement-collaboration-use-cases.ts:465-495`、`packages/application/src/requirement-collaboration-use-cases.ts:55-63`。

### 何时可以固定需求基线

**BR-BASELINE-FREEZE**　有效项目管理者提供名称、范围、原因及不重复需求版本，按项目加锁。允许 confirmed、implementing、delivered 的本项目需求。若指定父基线则必须仍为最新；按需求编码排序取快照、存内容哈希与条目。

源码依据　`packages/application/src/baseline-use-cases.ts:36-45`、`packages/application/src/baseline-use-cases.ts:169-195`。

### 任务达到哪一步

**BR-TASK-EVIDENCE**　领域状态机要求 ready 已有验收条件，assigned → running 已有活动 Run；自测须自测证据，提交还须产物，验证须验证证据。builder 不能自行验证或关闭。失败或阻塞任务可以返回 ready。

源码依据　`packages/domain/src/task-state-machine.ts:17-29`、`packages/domain/src/task-state-machine.ts:71-87`、`packages/domain/src/task-state-machine.ts:104-128`。

### 执行记录证明什么

**BR-TEST-EXECUTION**　记录要求环境、被测版本和 1 至 500 条不重复用例结果；用例、引用资料必须固定修订，保存执行者、快照和结果。只有 fail 的结果可连同项目缺陷，已绑定同一目标可重放。

源码依据　`packages/application/src/testing-use-cases.ts:209-247`、`packages/application/src/testing-use-cases.ts:248-283`。

### 缺陷何时可进回归

**BR-DEFECT-RETEST**　进入 fixing 需要同项目、来源为 defect-fix 且绑定本缺陷的任务；进入 retest 需要至少一项相关任务 verified 或 closed。分诊、关闭或拒绝受管理角色限制。

源码依据　`packages/application/src/defect-use-cases.ts:185-218`、`packages/application/src/defect-use-cases.ts:220-243`。

### 候选如何变成发布计划

**BR-INTAKE-FREEZE**　submit 按项目、提交人、请求键去重，相同内容返回原批，不同内容冲突；新批为 draft。管理者按版本逐项选新增、关联或跳过；企业档阻断项须先修复，已有映射须指向同一目标，冻结时记录计划哈希。

源码依据　`packages/application/src/intake-use-cases.ts:182-204`、`packages/application/src/intake-use-cases.ts:237-275`。

### 发布失败后保留什么

**BR-INTAKE-APPLY**　apply 逐项复核管理权限、批次状态、计划哈希。只在 pending 中按种类顺序选取模块、功能、需求文档、架构、需求，同种按记录 ID 升序。依赖未成功时标 blocked；单项写入有保存点。停止时已有成果保留，部分已发的批记 partial。

源码依据　`packages/application/src/intake-use-cases.ts:28-29`、`packages/application/src/intake-use-cases.ts:281-293`、`packages/application/src/intake-use-cases.ts:349-360`、`packages/application/src/intake-use-cases.ts:376-410`。

### 系统 Agent 修改稿如何生效

**BR-AGENT-ADOPT**　完成推理后保存 awaiting_review 的修改稿、摘要和质量报告。采用时重查申请者写权限、proposalHash 和 baseRevision，文档已改则冲突；成功同事务写新修订、索引队列和审计。

源码依据　`packages/application/src/system-agent-use-cases.ts:285-298`、`packages/application/src/system-agent-use-cases.ts:192-216`。

### 接手人使用哪一版技能

**BR-SKILL-PIN**　Run 固定安装清单的修订和摘要。读取时重新确认项目授权，比较清单记录与固定修订包所存的 package_sha256；此处未从 files 重新计算摘要。无快照的旧 Run 解析为空清单；交接复制源 Run 的固定版本并再次校验范围。

源码依据　`packages/application/src/skills-run.ts:37-46`、`packages/application/src/skills-run.ts:56-82`。

## 接入现有项目的一条替代入口

已有成套需求材料时，成员也可把相关模块、Feature、文档和需求作为一批候选提交。提交者获得草稿批次及各候选键；管理者在冻结前核对目标指纹和依赖。已冻结计划可以执行，业务对象逐项写入，每项结果均有可回看的目标或状态。若已经有部分对象发布，应核对原批次、已提交对象和同一请求键，再决定如何恢复。接入详情将发布、档案材料与正式审批分别呈现。见 `packages/application/src/intake-use-cases.ts:117-128`、`packages/application/src/intake-use-cases.ts:299-325`。

**untested**　本轮没有执行真实评审、接入、缺陷修复或 CI，也没有重放并发事务。跨表原子性须逐条路径检查；例如缺陷状态更新和写审计在所检方法中先后调用，故本文不将测试执行创建的事务保证外推到该路径。见 `packages/application/src/defect-use-cases.ts:230-244`。
