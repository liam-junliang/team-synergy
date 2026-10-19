# Team Synergy

> 以“项目共同状态”为中心的轻量多 Agent 项目协作平台。

Team Synergy 让不同的人、不同的设备和各自的编码 Agent 围绕同一套可验证的项目事实协作。平台不追求 Agent 群聊或自动调度，而是把需求、决策、任务、产物、证据和审计沉淀为项目共同状态；Agent 是可替换的执行者。

## 核心闭环

```text
想法 → 需求议题 → 需求文档 → 需求项
→ 任务（分派给人）→ 负责人授权 Agent 领取
→ 独立 Run / 工作区 → 开发、自测、证据
→ 验证 → 关闭
```

## 组成

| 目录 | 作用 |
| --- | --- |
| `apps/core-api` | 控制面 HTTP API，项目状态的唯一真相源 |
| `apps/web` | Web 工作台：项目、需求、计划、设计、任务、测试、缺陷、交接 |
| `apps/cli` | `tsp` 命令行客户端：领取任务、读写资料、本地执行 |
| `apps/agentd` | 本地 Run 会话托管 |
| `packages/contracts` | 共享类型、状态枚举与校验契约 |
| `packages/domain` | 任务状态机、Run 绑定与领域规则 |
| `packages/application` | 用例、权限、事务与审计 |
| `packages/persistence` | Drizzle Schema、PostgreSQL 迁移 |
| `packages/integrations` | Git worktree、工作区与交接快照 |

## 快速开始

前置：Node.js 22+、pnpm 10.33+、PostgreSQL 16。

```powershell
# 1. 准备数据库（本地示例）
psql -U postgres -c "CREATE DATABASE acp;"
psql -U postgres -c "CREATE DATABASE acp_test;"

# 2. 安装依赖
pnpm install

# 3. 配置连接（本地默认 postgres:postgres）
$env:ACP_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/acp'

# 4. 启动
pnpm --filter @team-synergy/core-api dev   # http://127.0.0.1:8080
pnpm --filter @team-synergy/web dev        # http://127.0.0.1:5173
```

Windows 下也可以在仓库根目录执行 `pnpm dev` 同时启动两个服务。

数据库名 `acp` 与部分 `ACP_` 环境变量是历史代号，暂保持不变。

## CLI

```powershell
pnpm --filter @team-synergy/cli build
node apps/cli/dist/index.js --help

# 绑定当前设备（浏览器授权）
tsp auth login --api http://127.0.0.1:5173/api --name "my laptop"
tsp task list --assigned-to me
```

CLI 发布包由 `.github/workflows/cli-release.yml` 在推送 `cli-v*` tag 时构建，输出各平台的自包含安装包。

## 提交信息

提交信息遵循 Conventional Commits：`<type>(<scope>): <subject>`。

- 允许的 type：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。
- 示例：`fix(web): keep document header sticky while scrolling`、`feat(cli): add task handover command`。
- 破坏性变更在 type/scope 后加 `!`，并在 footer 写 `BREAKING CHANGE:`。

首次 clone 后启用本地校验：

```powershell
git config core.hooksPath .githooks
```

也可以运行 `pnpm commit:check` 检查当前 HEAD；CI 同样会校验提交信息。

## 测试

```powershell
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
```

`typecheck` 依赖各 workspace 包已生成的 `dist` 类型声明，因此先执行 build。

测试使用独立的 `acp_test` 库，必须串行执行，避免多个包同时清理或迁移同一测试库。

## 状态

MVP 阶段。已实现任务闭环、需求与文档、计划、设计、测试、缺陷、交接、权限、技能库和代码规格接入；Agent Client Protocol 与 MCP 尚未完成。设计文档暂未随仓库发布。

## License

MIT
