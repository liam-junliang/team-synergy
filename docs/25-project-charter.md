# docs/25 项目档案：Team Synergy（PROJECT-A）

> 立项日期：2026-08-14
> 依据：docs/24 立项与需求分析流程 §2
> 变更摘要：
> - 2026-08-14 初版立项档案（目标/范围/里程碑/团队职责）

## 1. 项目目标

构建一个**轻量多 Agent 项目协作平台**：把产品设计、需求说明、开发测试、部署运维的事实统一沉淀在「项目共同状态」中，让不同职责的人与各自的 Agent（vibe coding 执行者）在同一个信息底座上协作，消除信息传递代差与黑盒。

核心价值（浓缩 docs/01）：
- 平台 = **整合控制面**，不是 Agent 群聊/重调度平台；
- **项目共同状态**为协作中心：需求、接口逻辑、业务逻辑、任务、证据、审计在平台内统一可见；
- Agent 是可替换执行者（执行者 MVP / 编排者随 MVP / 带预算委托 P2）；
- 界面事实派生，不新增状态字段；Agent 权限不超过所属人。

## 2. 范围边界

**MVP 范围内（已落地/落地中）**：
- 任务闭环：Task 10 态状态机 + Run/Worktree + Planner→Builder→Verifier + 证据/产物/审计
- 需求与立项：Requirement + Revision 版本管理 + 立项流程（docs/24）
- 团队与身份：成员/多项目/设备绑定 + CLI token 认证 + 权限（owner/member）
- CLI 与 Agent 接入：tsp（机器模式 JSON）、agentd 执行循环、MCP 后续
- Web 协作台：任务看板/需求/编排/验收/Defect/账号/项目/团队工作台
- 数据与部署：PostgreSQL（2026-08-14 全切）、局域网共享 core-api、部署运维只记事实

**延后（P2）**：
- 编排者预算委托、Agent 群聊、通知中心、外部系统集成（gitlab/gitee 等仓库绑定）、公网部署

## 3. 里程碑

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 架构基线 + 任务闭环 | ✅ 2026-08-13 | Spike 1：Task Store + Worktree + 三接口 + 试点录入 |
| M2 PostgreSQL 全切 + 团队/项目/账号体系 | ✅ 2026-08-14 | TASK-402/406/407/408/409 合回闭环 |
| M3 立项 + 需求分析流程 | 🔄 进行中 | TASK-410/411（本档案即产出之一） |
| M4 结构化需求入库 + 关联任务 | ⏳ | TASK-412+ |
| M5 原型登记 + 视觉验收闭环 | ⏳ | TASK-413+（依赖 O-2） |
| M6 编排者模式（对话条+预算委托） | ⏳ | docs/07 P1 |

## 4. 团队与职责约定

| 成员 | 角色 | 职责约定 |
|---|---|---|
| user-chen | owner | 编排：立项、任务分派、验收、需求梳理（产品职责兼任） |
| Liam | owner | 产品职责：需求分析（与 Agent 多轮对话）、需求 review 与确认、方向决策 |
| user-wang | member | 执行：builder 职责，由编排者委派的 codex Agent 以此身份执行任务 |

职责约定（docs/24 O-1）：MVP 不新增角色枚举，用职责约定 + owner 权限；需求梳理操作以 owner 身份执行。

## 5. 功能域 Feature（立项重建）

| Feature ID | 功能域 |
|---|---|
| FEATURE-TASK-LOOP | 任务闭环（Task/Worktree/验收） |
| FEATURE-REQ-MGMT | 需求与立项（Requirement/Revision/立项流程） |
| FEATURE-TEAM-ID | 团队与身份（成员/项目/认证） |
| FEATURE-CLI-AGENT | CLI 与 Agent 接入（tsp / agentd / MCP） |
| FEATURE-WEB | Web 协作台（看板/工作台） |
| FEATURE-DATA-OPS | 数据与部署（数据库/部署运维） |

> 历史交付批次（FEATURE-SPIKE1/SPIKE2/FEATURE-PG 等）保留为执行期任务组，与功能域不混用（docs/24 §4）。

## 6. 需求文档载体

- 完整级项目需求说明：docs 线（docs/01 产品定位、docs/02 领域模型、docs/00 架构基线、docs/24 需求分析流程等构成需求说明主体；docs/26 结构化需求清单为提炼视图）
- 平台工作视图：requirements + requirement_revisions（TASK-412 录入）
- 迭代纪律见 docs/24 §3.4：先改文档 → 平台 revise → 留痕不删除
