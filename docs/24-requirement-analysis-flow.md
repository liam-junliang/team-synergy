# docs/24 立项与需求分析流程（产品线设计）

> 状态：Draft（讨论结论沉淀，待产品确认后 Adopted）
> 来源：2026-08-14 立项/需求录入讨论
> 关联：docs/00 架构基线、docs/01 产品定位、docs/02 领域模型、docs/20 试点

## 1. 背景与目标

平台自身（PROJECT-A 试点）已完成执行闭环（任务/审计/验收）与 PostgreSQL 切换。现在要补上**产品线的起点**：立项 → 需求分析 → 需求录入 → 原型产出，让「产品职责的人」在平台内与 Agent 协作产出需求，而不是把需求分析留在平台外。

## 2. 立项（Project Onboarding）

- 项目档案：目标、范围边界、里程碑、团队角色落位（PROJECT-A 补录，docs/01 产品定位的浓缩版）。
- 团队角色语义：owner / member 之外，引入**职责约定**（谁梳理需求、谁编排、谁执行）——职责是约定不是硬角色字段（MVP 不新增角色枚举，沿用 owner 权限执行需求梳理）。
- 立项产出：项目档案文档（docs 线）+ 项目级「完整需求说明文档」的载体定位。

## 3. 需求分析工作流（产品人 + Agent 协作）

```
产品职责人 ←→ Agent 多轮对话
      │
      ├─ 记录想法 → 汇聚为需求议题 → 讨论方案并形成可追溯决策
      │
      ├─ Agent 提炼 → 按模块拆分的一份或多份需求文档（完整级说明）
      │
      ├─ 产品人确认 → 录入平台（结构化需求条目，CLI/Web）
      │
      ├─ Agent 画 HTML 原型 → 作为项目产物提交（artifact）
      │
      └─ 后续：需求条目 → 功能模块归类 → Feature 归属 → 阶段/里程碑计划 → 拆任务
```

要点：
1. **三种载体、两层需求**：项目总文档保存跨模块目标和约束；平台内可有多份模块化 `Requirement Document`，保存完整需求语义；`Requirement` 是从文档提炼、可关联任务的原子工作条目。需求文档是需求事实源，条目是追踪视图，项目总文档不替代需求文档。
2. **多轮对话的沉淀**：零散观察先记录为想法；相关想法汇聚到需求议题，议题时间线保存讨论、备选方案、反馈和决策。决策由 Agent 整理成 Markdown 文档并上传共享；随后再把独立、可验收的需求项梳理到需求清单。
3. **评审按需发起**：需求文档可对某个不可变 Revision 发起成员评审。评审只记录支持、需要修改、弃权和协作结论，不是提炼需求项或创建任务草稿的硬门禁；新 Revision 不继承旧评审。
4. **原型归属**：HTML 原型文件是项目级视觉/交互设计产物，可关联需求项；配套 Markdown 说明业务、交互、数据和代码注意事项。
5. **需求文档持续迭代**：模块化需求文档是**活文档**，随项目演进持续迭代——后续新增需求、细化需求、调整边界，都先产生新的 `requirement_document_revision`，再同步原子条目的 `requirement_revision`。迭代纪律：
   - 改动必先改文档（单一事实源），再改平台条目（工作视图）；
   - 平台条目变更必须走 revise 产生新 revision，不原地覆盖（docs/21 版本管理原则）；
   - 被否/被替代的需求保留 revision 历史留痕，不删除；
   - 每次迭代在文档头部记录变更摘要（日期 + 变更点 + 关联 REQ/TASK）。
6. **Agent 提案不等于正式结构**：Agent 可以根据需求项建议模块、Feature、阶段和里程碑，但必须通过平台实体创建/修改操作落库，Owner 可以改名、合并、移动、归档或拒绝，不能继续把自由文本当作正式分类。

## 4. 数据模型映射

| 概念 | 平台承载 | 说明 |
|---|---|---|
| 项目 | projects | 项目容器；功能模块与交付计划都归属项目 |
| 想法 | requirement_ideas | 低成本汇聚观察、机会和问题表现 |
| 需求议题 | requirement_topics + requirement_topic_entries | 讨论、方案、反馈与可替代决策的长期空间 |
| 功能模块 | project_modules | 从需求点归纳出的稳定功能域，包含名称、说明、排序和归档状态 |
| Feature | features | 模块下可独立交付和验收的能力，可指定一个当前目标里程碑 |
| 项目阶段 | project_phases | 项目的较大交付周期，与任务状态严格区分 |
| 里程碑 | project_milestones | 阶段内的结果节点；关联 Feature 范围，进度由 Feature/任务事实派生 |
| 结构化需求 | requirements + requirement_revisions | 每条保存标题、正文、验收标准和来源文档；创建时 Feature 可空，后续归类 |
| 项目总文档 | project_documents | 项目目标、全局约束与执行约定 |
| 模块化需求文档 | requirement_documents + requirement_document_revisions | 一项目多文档，正文完整可读；module_id 关联正式模块，module_key 仅作旧数据兼容 |
| 文档版本评审 | requirement_document_reviews + requirement_document_review_votes | 可选评审，固定绑定某个文档 Revision |
| 执行任务 | tasks | 必须关联 Feature；保存完整 brief、验收、范围和验证接缝，Run 启动后任务契约冻结 |
| 原型 | artifacts（扩展项目级） | 见 O-2 |

## 5. 开放决策点

- **O-1 角色**：是否引入「产品」角色枚举（区别于 owner/member）？倾向：MVP 用职责约定 + owner 权限，观察后再定。
- **O-2 项目级 artifact**：artifacts.task_id 当前 NOT NULL，原型等项目级产物需要 task_id 可空或新增挂载点。方案：task_id 改可空 + artifact kind 加 'prototype'，或 projects 加附件表。待定。
- **O-3 已收口**：结构化条目使用与 Task 相同的 `{id,text}` 验收数组，并以 `document_id` 链接来源需求文档。
- **O-4 已收口**：Web 和 CLI 都可录入；Web 使用弹窗，CLI 从 Markdown 文件创建/修订，避免长正文作为命令行参数。

## 6. 执行计划（下一批任务）

1. TASK-41x 立项：PROJECT-A 项目档案 + 功能模块/Feature 重建 + 阶段/里程碑计划 + 团队角色约定落位。
2. TASK-41x 需求提炼：Agent 读 docs/00~23 提炼结构化需求清单（草案）→ 产品人 review。
3. TASK-41x 需求录入：确认后的条目批量录入平台（requirement + revision 初版），旧任务补 requirement_id 关联。
4. TASK-41x（依赖 O-2）：项目级 artifact 支持 + 原型提交（prototype-design/ 7 页 HTML 作为 PROJECT-A 的 artifact 登记）。
