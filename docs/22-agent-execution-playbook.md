# 22 · Agent 执行手册：codex 绑定用户执行任务（骨架最小闭环）

> 目的：骨架（批 A/B/C）搭好后，**用平台管理平台自己的开发**。本文档定义人 + Agent 的真实执行循环。
> 适用范围：Spike 1 阶段（无 agentd 常驻，Agent 由人在 Run 会话中启动——docs/18「人启动第一次」形态）。

## 1. 角色与身份

| 角色 | principal | 职责 |
|---|---|---|
| 项目负责人 | `<owner_user_code>` | 模块/Feature/阶段/里程碑规划、任务契约、assign、close、成员管理 |
| Builder（人） | `<builder_user_code>` | claim → 启动 codex 开发 → submit |
| Builder Agent | codex（绑定 `<builder_user_code>`） | 在 Run 会话中读项目文档和 brief.md、开发、跑测试、调用 tsp |
| Verifier（人） | 任意成员（第二人） | 验证 Run claim → verify |

**身份绑定原则**（docs/00「Agent 权限不超过所属人」）：常规 CLI 通过 `tsp auth login` 绑定设备凭据；自动化 Agent 可在机器模式继承启动者的 principal。两种模式都通过 `core-api` HTTP 操作项目状态，并以该 principal 的名义审计落库。

## 2. 环境变量

```text
ACP_API_URL         core-api 地址（未登录或需显式覆盖时设置）
ACP_PRINCIPAL_CODE  机器模式当前用户编码（HTTP header 回退）
ACP_WORKSPACES_DIR  工作区根目录（默认 ./.worktrees）
ACP_PROJECT_CODE    task run 注入的项目编码
ACP_TASK_CODE       task run 注入的任务编码
ACP_RUN_CODE        task run 注入的 Run 编码
ACP_BRIEF_PATH      task run 注入的任务 brief.md 路径
ACP_PROJECT_DOCUMENT_PATH  task run 注入的完整项目文档路径
ACP_REQUIREMENTS_INDEX_PATH  task run 注入的需求文档索引路径
ACP_REQUIREMENT_DOCUMENT_PATH task 关联 Requirement 时注入的来源需求文档路径
ACP_DESIGN_INDEX_PATH task run 注入的相关原型索引路径
ACP_DESIGN_PROTOTYPE_PATHS task 关联 Requirement 时注入的 HTML 原型文件路径（以系统路径分隔符连接）
ACP_DESIGN_NOTES_PATHS task 关联 Requirement 时注入的配套设计说明 Markdown 路径
```

PostgreSQL 连接只由 `core-api` 的 `ACP_DATABASE_URL` 持有。`tsp` 与 codex 不接收数据库路径，也没有本地直连模式。常规交互先执行：

```text
tsp auth login --api http://127.0.0.1:8080 --token <bind-token> --name <device-name>
tsp auth whoami
```

正式开始项目协作前，在一个不是现有代码仓库子目录的位置初始化长期项目工作空间。该目录的根 Git 维护协作产物，代码仓库按任务需要选择性拉取：

```text
tsp workspace init <project_code> --dir <project-workspace> --name <device-workspace-name>
cd <project-workspace>
tsp repository list
tsp repository clone <repository_code>
tsp repository status
```

产品或设计 Agent 可以不拉取任何仓库；开发 Agent 也只需要拉取当前任务涉及的仓库。已经存在的本地 Git 仓库使用 `tsp repository attach <repository_code> --dir <path>` 挂接，不上传本地路径。

## 3. 执行循环（单人 + Agent）

```text
┌─ 项目负责人（使用自己的 user_code）
│   tsp feature create --project <project_code> --title "..."
│   → 返回 <feature_code>
│   tsp task create --feature <feature_code> --profile builder \
│     --source requirement --brief-file ./task-brief.md \
│     --acceptance '[{"id":"AC-1","text":"..."}]'
│   → 返回 <task_code>
│   tsp task assign <task_code> --assignee <builder_user_code>
│
├─ 执行者（人）
│   tsp task claim <task_code> --profile builder --repo <主仓库>
│   → 产出 worktree + .agent/project-state/brief.md
│                 + .agent/project-state/project-document.md
│                 + .agent/project-state/requirements/index.md
│                 + .agent/project-state/requirements/<document_code>.md（有关联时）
│                 + .agent/project-state/design/index.md
│                 + .agent/project-state/design/<prototype_code>.html（有关联时）
│                 + .agent/project-state/design/<prototype_code>.notes.md（有关联时）
│
├─ 执行者 Agent（codex，与执行人绑定同一身份）
│   1. 先读 ACP_BRIEF_PATH（完整执行简报、关联需求点正文、任务契约和验收）
│   2. 读 ACP_PROJECT_DOCUMENT_PATH（项目目标/约束/约定）
│   3. 读 ACP_REQUIREMENTS_INDEX_PATH，按模块、摘要和关键词判断是否还有相关文档
│   4. 有 ACP_REQUIREMENT_DOCUMENT_PATH 时完整阅读该来源需求文档
│   5. 读 ACP_DESIGN_INDEX_PATH；打开 ACP_DESIGN_PROTOTYPE_PATHS 中的 HTML 确认界面与交互，再读 ACP_DESIGN_NOTES_PATHS 中同版本的业务、数据、代码逻辑和注意事项
│   6. 在本次 Run 的 <run-workspace>/repo 内开发、提交并跑测试
│   7. tsp task submit <task_code> --run-code <run_code> --artifact-kind commit \
│        --artifact-uri git:<commit> --artifact-hash <hash> \
│        --evidence-type self_test --evidence-result pass \
│        --acceptance-refs AC-1 --evidence-command "pnpm test"
│
├─ 人 review（执行者或项目负责人）
│   检查产物与证据 → 不通过则驳回（重新 claim 修复）
│
├─ Verifier（第二人，独立 Run）
│   tsp task claim <task_code> --profile verifier --repo <主仓库>
│   tsp task verify <task_code> --run-code <verifier_run_code> --evidence-result pass \
│     --acceptance-refs AC-1 --evidence-summary "独立复核通过"
│
└─ 项目负责人
    tsp task close <task_code>
    tsp task history <task_code>   # 审计流：8 个动作
```

### 外部编排器已经启动 Agent 时

Codex 原生子 Agent、Claude Code 等执行者已经在现有目录中启动时，不应事后伪造普通 Claim，也不应再创建一个看不到主工作区未提交改动的 worktree。执行 Agent 必须自己运行：

```text
tsp task attach <task_code> --profile builder --workspace <当前工作目录>
```

该命令把现有工作目录登记为 `external_shared` Run，并在 `.agent/runs/<run_code>/project-state/` 生成独立 Context Pack。共享目录不提供物理隔离，因此项目负责人仍必须在任务 `scope.writable_paths` 中分配互不重叠的文件范围。Agent 完成后使用返回的 `run_code` 自行 `task submit`。

`task claim` 与 `task run` 是两种启动入口：`task run` 内部会自行 Claim，不能在已经 Claim 后再次串联执行。已有 Run 使用当前执行器继续工作，不能重复 Claim。

## 4. codex 会话模板（绑定实际执行人）

```text
codex exec --dangerously-bypass-approvals-and-sandbox \
  -c "session_id=<run_code>" \
  "你是 Builder Agent，以当前已绑定的 CLI 身份执行任务 <task_code>，本次执行 Run 编码为 <run_code>。
   环境：ACP_API_URL=http://127.0.0.1:8080；task run 会注入项目、Run 和上下文文件路径。
   起点：依次读取 ACP_PROJECT_DOCUMENT_PATH、ACP_REQUIREMENTS_INDEX_PATH；若存在 ACP_REQUIREMENT_DOCUMENT_PATH，则完整读取来源需求文档；再读取 ACP_DESIGN_INDEX_PATH，打开 ACP_DESIGN_PROTOTYPE_PATHS 中的视觉原型和 ACP_DESIGN_NOTES_PATHS 中的配套说明；最后读取 ACP_BRIEF_PATH。
   规则：
   1. 事实以 brief.md 与 tsp 查询为准，不要臆造接口；
   2. 改动只在本次 Run 的 <run-workspace>/repo 内，提交 git；
   3. 验收标准全部满足后才 tsp task submit；
   4. 完成标准：提交产物 + 自测证据（pass）覆盖全部 acceptanceRefs。"
```

（Windows 沙箱 `workspace-write` 不可用，须 `--dangerously-bypass-approvals-and-sandbox`——本仓库已记录在案。）

## 5. 骨架当前能力清单（供 codex prompt 引用）

| 命令 | 作用 |
|---|---|
| `tsp whoami` | 会话身份（Agent 启动时先确认自己是谁） |
| `tsp workspace init <project_code>` | 初始化长期项目工作空间、根 Git、固定目录和云端登记 |
| `tsp repository list/clone/attach/status` | 查看云端仓库目录，按需拉取或挂接独立 Git 仓库，并检查本地状态 |
| `tsp task list [--assigned-to me] [--status s]` | 任务看板（Agent 找活） |
| `tsp docs list/search/show` | 统一查阅项目规范、需求、架构及其他项目文档；先搜索索引，再读取所需正文 |
| `tsp requirement-doc list/search/show` | 先读轻量索引，再按需读取完整需求文档 |
| `tsp requirement-doc create/revise` | 从 Markdown 文件上传或修订协作需求文档 |
| `tsp requirement list/search/show/update` | 按项目查阅、检索和编辑结构化需求表 |
| `tsp design list/show` | 查阅项目设计方案，并分别导出当前 HTML 与配套 Markdown |
| `tsp design create/revise` | 通过 `--file` 上传视觉原型、通过 `--notes-file` 上传业务/数据/代码说明，并产生同一个不可变 Revision |
| `tsp module/feature/phase/milestone list/create/update` | 管理功能模块与项目交付计划，命令参数统一使用公开编码 |
| `tsp task create ... --brief-file <path> --requirement <requirement_code>` | 保存完整执行简报，并将任务关联回需求点 |
| `tsp task update <task_code> --brief-file <path> ...` | 在执行前维护稳定任务契约；Run 开始后禁止修改 |
| `tsp task status <task_code>` | 任务状态与派生视图 |
| `tsp task claim/attach/submit` | worktree 领取、外部 Agent 绑定与提交；每次执行均产生可审计 Run |
| `tsp task run <task_code> --profile <p> --repo <r> --command "<cmd>"` | 一条命令执行循环：claim → 执行器（注入任务、Run、项目编码、工作区、brief 和项目文档路径）→ 收尾检查（未提交文件 + submit 指引） |
| `tsp task verify/close/history` | 验证、关闭、审计流 |
| `tsp workspace identify/cleanup` | 工作区识别与清理 |
| `tsp feature create/list/show/update` / `team create/add/list` | 功能归属与成员 |

## 6. 试点录入（平台自身 backlog）

脚本 `scripts/bootstrap-pilot.ps1` 通过运行中的 `core-api` 把 docs/20 剩余任务录入平台（真实项目管理起点）。默认 API 地址为 `http://127.0.0.1:8080`，也可预先设置 `ACP_API_URL` 覆盖：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-pilot.ps1
```

之后项目负责人把任务逐个 assign，执行者 claim 后交给 codex，形成「平台开发平台」的真实闭环。

## 7. 需求、原型与任务的关联规则

- 原型是项目级协作产物，可以关联一个或多个结构化需求点；同一需求点也可以关联多个原型。
- 原型每次修改都新增修订版本，不覆盖历史版本。每个 Revision 由可运行 HTML 和可选 Markdown 配套说明组成，Agent 通过 `design show` 默认读取当前版本。
- 开发任务关联结构化需求点；CLI 在 Claim/Attach/Run 时通过 `任务 → 需求点 → 原型` 动态解析相关原型，并把 `.html` 与 `.notes.md` 一起写入 Context Pack。
- 原型关联发生变化后，新启动的 Run 自动读取最新关系；已经启动的 Run 保留当时落盘的 Context Pack，保证执行过程可复现。
