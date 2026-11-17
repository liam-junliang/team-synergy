# 需求发现、议题决策与文档评审

> 状态：Adopted（2026-08-20）
> 关联：docs/11、docs/24、migration 0020

## 1. 产品目标

需求工作台覆盖真实项目从模糊观察到可执行交付结构的最短必要链路：

```text
想法 → 需求议题 → 需求文档 → 需求清单 → 功能模块
                               └→ 设计 / 计划 / 任务
设计、开发、缺陷反馈 ───────────────→ 重新打开需求议题
```

这五层不是审批关卡。每层解决不同问题，项目成员可以按实际复杂度跳过不需要的协作动作。

## 2. 各层职责

### 2.1 想法

想法是低成本记录的观察、机会或问题表现。它只需要一句话标题，可补充场景、来源和说明；不要求给出完整方案。一个想法可以被多个议题引用，归档只影响展示，不删除历史关联。

### 2.2 需求议题

需求议题是持续存在的讨论与决策空间，不等同于 Feature。议题时间线包含：

- 讨论：补充事实、场景和约束；
- 备选方案：记录可选方向及取舍；
- 反馈：设计、开发、缺陷或其他执行阶段产生的新事实；
- 决策：明确当前方向、依据，并可显式替代历史决策。

已决策议题收到反馈后进入“重新讨论”，形成新决策后回到“已决策”。旧决策不覆盖、不删除。

### 2.3 需求文档

需求文档保存完整、连续、适合人和 Agent 阅读的需求语境。正文按不可变 Revision 管理；一个议题可以沉淀为多份文档，一份文档也可以综合多个议题。

文档评审是可选协作动作：

- 评审固定绑定某个 `requirement_document_revision`；
- 项目成员可表达“支持 / 需要修改 / 弃权”并留言；
- 发起人或项目 Owner 记录“通过 / 需要修改 / 暂无共识”结论；
- 新 Revision 不继承旧 Revision 的评审；
- 未发起、进行中或未通过评审都不阻塞提炼需求项和创建任务草稿。

### 2.4 需求清单

需求清单由可引用的“需求项”组成。每条需求项保存独立标题、正文、验收标准、开放问题以及来源文档。需求项是追踪和拆解视图，需求文档仍是完整语境的事实源。

### 2.5 功能模块

功能模块和 Feature 是正式项目结构。模块是稳定功能域，Feature 是可独立交付和计划的能力。Agent 可以提出分类建议，但必须通过平台操作落库，不能用自由文本替代实体。

## 3. 执行与变更规则

1. 创建任务时固定当前需求项 Revision；若需求项来自文档，同时固定当前文档 Revision。
2. 任务读取固定版本作为执行上下文，不因上游新 Revision 被静默改写。
3. 上游版本变化时返回 `requirement_source_changed` / `requirement_document_source_changed`，由 Owner 判断继续、更新任务合同或重新拆解。
4. 任务能否进入执行由任务合同决定：验收标准、范围、验证接缝及按任务类型需要的设计、交接或仓库目标必须完整；文档评审状态不参与任务状态机。
5. 设计、开发或缺陷阶段发现方向问题时，用议题反馈记录来源实体公开编码，再形成替代决策和后续文档 Revision。

## 4. API 与 CLI

所有外部操作只使用 20 位公开编码，不暴露 bigint 主键。

```text
tsp idea create/list/search/archive/restore
tsp topic create/list/show/comment/alternative/feedback/decide
tsp topic link-ideas/link-documents
tsp requirement-doc reviews/review-start/review-vote/review-close
tsp requirement create/list/search/show/update
```

Web 端所有长内容使用弹窗录入；想法页只常驻紧凑搜索和操作栏，议题页使用“议题列表 + 时间线 + 关联上下文”布局。

## 5. 数据模型

| 表 | 职责 |
|---|---|
| `requirement_ideas` | 项目想法池 |
| `requirement_topics` | 需求议题头与当前协作状态 |
| `requirement_topic_ideas` | 议题汇聚想法的多对多关系 |
| `requirement_topic_entries` | 讨论、备选、反馈、决策及替代关系 |
| `requirement_topic_documents` | 议题和需求文档关系 |
| `requirement_document_reviews` | 固定到文档 Revision 的可选评审 |
| `requirement_document_review_votes` | 项目成员独立意见 |
| `tasks.source_requirement_revision_id` | 任务固定的需求项版本 |
| `tasks.source_document_revision_id` | 任务固定的需求文档版本 |

关系表使用 bigint 主键关联，API、Web、CLI 和 Agent 只传递公开 code。
