# Team Synergy

[English](README.md) | **简体中文**

[![CI](https://github.com/liam-junliang/team-synergy/actions/workflows/ci.yml/badge.svg)](https://github.com/liam-junliang/team-synergy/actions/workflows/ci.yml)

> 以“项目共同状态”为中心的轻量多 Agent 项目协作平台。

Team Synergy 把需求、决策、任务、产物、证据和审计沉淀为共享的项目共同状态，让不同的人、不同的设备和各自的编码 Agent 围绕同一套可验证的事实协作。它不是 Agent 群聊室，也不是自动调度器：Agent 是可替换的执行者，只有显式提交才会改变项目的正式状态。

## 为什么需要它

编码 Agent 很快，但当上下文散落在聊天、本地笔记或某个人的脑子里时，产出很难被信任。Team Synergy 让每个人和每个 Agent 都看到同一份版本化事实：

- 需求和决策有版本，不会丢失在对话里。
- 工作拆成任务，有负责人、验收标准和证据。
- 每次 Agent 执行都有独立工作区和身份。
- 完成是显式动作：先发布产物和证据，再独立验证。

## 核心闭环

```text
想法 → 需求议题 → 需求文档 → 需求项
→ 任务分派给人 → 负责人授权 Agent 领取
→ 独立 Run / 工作区 → 开发、自测、证据
→ 独立验证 → 关闭
```

## 架构

```mermaid
flowchart LR
  subgraph Shared["控制面（共享）"]
    Web["Web 工作台"] --> API["Core API"]
    API --> DB[("PostgreSQL")]
  end
  subgraph Local["本地执行面（每位成员）"]
    CLI["tsp CLI"] --> Agentd["agentd"]
    Agentd --> Agent["编码 Agent"]
    CLI --> Worktree["Run 工作区"]
  end
  CLI --> API
```

控制面持有项目事实，本地执行面持有文件与进程。CLI 不直连 PostgreSQL；Web、CLI 和 Agent 统一经过 Core API，因此权限和状态转换只在一处校验。

| 层 | 职责 |
| --- | --- |
| Web | React 19 + Vite + TanStack Query；项目、需求、计划、设计、任务、测试、缺陷、交接 |
| Core API | Fastify HTTP API；认证、权限、用例、审计、错误语义 |
| Application / Domain | 任务状态机、Run 绑定、所有权、证据门槛、版本文档 |
| Persistence | Drizzle Schema 与按序执行的 PostgreSQL 迁移 |
| CLI | `tsp`：设备登录、任务领取/提交、文档、工作区与仓库操作 |
| agentd | 本地 Run 会话托管 |
| Integrations | Git worktree、工作区元数据、交接快照 |

设计原则：

- 项目状态是唯一事实源，私人思考不是。
- 任务/Run 是隔离单位，每次执行有自己的工作区和身份。
- 产物必须显式发布，完成必须有证据。
- Web、CLI 和 Agent 共用一套 API 和一套权限模型。
- 只在观察到真实问题时增加复杂度。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `apps/core-api` | 控制面 HTTP API，项目状态的唯一真相源 |
| `apps/web` | Web 工作台：项目、需求、计划、设计、任务、测试、缺陷、交接 |
| `apps/cli` | `tsp` 命令行客户端 |
| `apps/agentd` | 本地 Run 会话托管 |
| `packages/contracts` | 共享类型、状态枚举与校验契约 |
| `packages/domain` | 任务状态机、Run 绑定与领域规则 |
| `packages/application` | 用例、权限、事务与审计 |
| `packages/persistence` | Drizzle Schema 与 PostgreSQL 迁移 |
| `packages/integrations` | Git worktree、工作区与交接集成 |

## 快速开始

前置：Node.js 22+、pnpm 10.33+、PostgreSQL 16。

```bash
# 1. 准备数据库
psql -U postgres -c "CREATE DATABASE team_synergy;"
psql -U postgres -c "CREATE DATABASE team_synergy_test;"

# 2. 安装依赖
pnpm install

# 3. 配置数据库连接（本地默认值）
export TSP_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/team_synergy'

# 4. 启动控制面与 Web 工作台
pnpm --filter @team-synergy/core-api dev   # http://127.0.0.1:8080
pnpm --filter @team-synergy/web dev        # http://127.0.0.1:5173
```

Windows 下用 `$env:TSP_DATABASE_URL='...'` 设置变量，或在仓库根目录执行 `pnpm dev` 同时启动两个服务。

已有安装可以继续使用原来的数据库名，只需把 `TSP_DATABASE_URL` 指向它。

## CLI

```bash
pnpm --filter @team-synergy/cli build
node apps/cli/dist/index.js --help

# 通过浏览器授权绑定当前设备
tsp auth login --api http://127.0.0.1:5173/api --name "my laptop"
tsp task list --assigned-to me
```

推送 `cli-v*` tag 时，`.github/workflows/cli-release.yml` 会构建各平台的自包含安装包，每个包自带 Node 运行时。

`tsp workspace init` 会同时从项目规范生成 `AGENTS.md` / `CLAUDE.md`。规范变更后执行 `tsp workspace guidance` 刷新，`tsp workspace guidance --check` 用于检查快照是否过期。

## 系统 Agent（V1）

项目页面提供悬浮入口；可对原生项目文档批注，自动生成修改草稿，比较标题、摘要与正文后明确采用。正式文档在确认前不改变。采用核对基准修订、候选摘要与当前权限，重复请求不会重复创建修订。关联的需求、架构、测试资料暂不支持此编辑入口。

执行器固定为官方 `@deepseek-ai/dsh@0.2.1-rc.2`，单独安装并通过 `.env.example` 的环境变量启用。`TSP_SYSTEM_AGENT_DSH_BIN` 指向安装包的绝对 `lib/bin.js` 路径；设置独立的 `TSP_SYSTEM_AGENT_WORKSPACE_ROOT`，以及模型凭据文件路径。可显式使用 `TSP_SYSTEM_AGENT_DSH_CREDENTIALS_FILE` 读取已有 DSH 管理凭据中的 `DEEPSEEK_API_KEY`。不得把密钥提交到仓库。

Windows 启动器支持 `TSP_SYSTEM_AGENT_CONFIG_FILE` 指定的 JSON；默认查找源码/服务目录上级的 `system-agent.config.json`，仅接受路径、模型、启用与限额设置。未配置时面板显示原因并拒绝排队。构建会打包 `spec-production` 指导及其摘要，每个任务记录实际引擎、模型、Skill 版本和摘要。

V1 仅向模型提供授权资料快照，禁用文件、Shell、MCP 等工具；候选预览不自动加载图片或执行图表。取消、超时、失效租约明确失败，不自动重跑付费任务。工作目录保留运行记录，留存与清理由部署者管理。自动规则检查与生成者解释不代表独立复核或企业标准认证。

## 测试

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
```

`typecheck` 依赖各包生成的 `dist` 类型声明，因此先执行 build。测试使用独立的 `team_synergy_test` 数据库，必须串行执行，避免多个包同时清理或迁移同一测试库。

## 状态

早期 MVP。已实现任务闭环、需求与文档、计划、设计、测试、缺陷、交接、权限、技能库和代码规格接入；Agent Client Protocol 与 MCP 尚未完成。设计文档暂未随仓库发布。

## License

MIT
