# Agent 工具动作与权限规范

适用项目：Team Synergy。本文记录已部署版本的能力、扩展动作清单和操作契约，供成员和 Agent 对照选用。扩展动作清单对应本次开发分支，生效版本以当前连接的工具目录及平台发布记录为准。

## 先确认账号与目标

1. 远程 Agent 调用 `get_connection_context`，CLI 使用 `tsp auth whoami`。需要创建项目时先调用 `list_teams`，业务操作先调用 `list_projects`。沿用同一平台已经返回的团队、项目和对象编码。
2. Connector 用 `search_tools` 按模块、关键词和项目找工具，再看工具的输入 schema。CLI 用 `tsp tools search` 查目录，`tsp tools list` 查看当前安装版本的完整输入 schema。项目动作逐次传 `projectCode`，CLI 可用 `--project`。团队和项目创建使用账号范围的连接。
3. 两种入口执行相同的业务动作。平台按当前账号状态、项目角色、对象归属及业务状态判定请求。记录正文、版本、关系和审计进入各自的业务模块，文档和记忆检索沿用来源引用。

| Connector 权限 | 适用操作 |
| --- | --- |
| 查看项目 | 账号可访问的项目、文档、规划、需求、设计、缺陷、测试、技能及代码资料。部分读取另校验项目角色 |
| 协作任务 `tasks:write` | 任务草稿、分派、远程领取、自测证据、测试执行登记 |
| 管理团队和项目 `workspace:write` | 查找团队和成员、使用下表的业务写入。每次按当前团队或项目角色校验 |
| 读取个人记忆 `memory:personal:read` | 当前账号的适用偏好及来源 |

CLI 使用已授权的设备登录，并按对应账号角色执行。旧 Connector 授权继续沿用原范围。需要扩展写入时，在新的连接授权中主动勾选「管理团队和项目」。

## 常见路径

### 创建团队与项目

目标团队已存在时，从 `list_teams` 复用编码。需要新团队时先执行 `create_team`，然后在该团队用 `create_project` 创建。新建项目后从响应或 `list_projects` 取得项目编码；添加成员、登记仓库或创建模块时再逐次传入。项目访问策略变更前调用 `preview_project_access_policy` 核对继承权限。

```text
list_teams {}
create_team {"name":"协作示例团队"}
create_project {"team_code":"TEAM_CODE","name":"协作示例项目","description":"软件交付与回归验证"}
```

```powershell
tsp tools search 项目 --module projects
tsp tools call list_teams
tsp tools call create_project --input '{"team_code":"TEAM_CODE","name":"协作示例项目","description":"软件交付与回归验证"}'
tsp tools call get_project --project PROJECT_CODE
```

创建请求超时后先查团队或项目列表再决定是否重试，避免重复创建。移出团队成员前查看 `preview_team_member_removal` 返回的角色、归属与运行影响。负责人交接按专用流程操作。

### 把讨论推进到有证据的交付

先查需求议题、当前修订和代码分析版本。业务讨论可记录为想法、议题或评论。确认方案后再登记议题决策。实施结果通过关联任务、实际执行和测试证据核对。缺陷提交按操作步骤、预期结果、实际结果和证据组织，已有截图、日志或录屏可引用来源。任务与缺陷的流转需使用当前状态、版本或快照。

### 选择资料和证据的归档位置

项目描述、设计、接口文档、测试策略和验收矩阵进入项目文档库。源码包、日志、单次验收报告和截图留在关联任务、测试执行或缺陷记录。Connector 可提供文字和链接证据。需要从本机上传或下载附件、操作 Git 工作树、运行脚本或配置采集时使用 CLI 原生命令或相应宿主能力。

## 已有 Connector 和 CLI 能力

| 模块 | HTTP Connector | CLI |
| --- | --- | --- |
| 账号与项目 | `get_connection_context`、`list_projects`、`list_project_members` | `tsp auth`、`tsp project`、`tsp team`、`tsp ownership` |
| 资料与代码 | `list_project_materials`、Glob、Grep、按引用读原文、`read_code_catalog`、`query_code_graph` | `tsp docs`、`tsp code`、`tsp intake` |
| 记忆 | 查简报、关键词和来源，个人范围读取需单独授权 | `tsp memory`、个人记忆编辑与撤回、原生会话采集 |
| 任务与交接 | 查 Feature 和任务，创建草稿、分派、远程领取、提交自测 | `tsp task`、`tsp task handover`、设备租约、工作树与执行证据 |
| 测试 | 查用例，登记实际执行结果 | `tsp test case`、`tsp test asset`、`tsp test execution` |
| 业务管理 | 本次扩展补充下表动作 | `tsp feature`、`module`、`phase`、`milestone`、`requirement`、`requirement-doc`、`idea`、`topic`、`architecture`、`design`、`defect`、`skill` 原生命令，以及下表共用动作 |

账号凭据、设备管理、系统管理员归档恢复和硬删除继续通过各自的管理入口。个人记忆治理按账号执行，本次业务写授权只覆盖登记在下表的动作。

<!-- agent-workspace-action-table -->

## 本次新增的 94 个共用动作

CLI 使用 `tsp tools call 工具名`。项目范围的 Connector 写操作以及全部账号范围的 Team 管理工具需要 `workspace:write`。接口路径相对 Core API。路径参数、其余可选参数与输入约束可从工具 schema 查看。

### 账号与项目（`projects`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `create_project` | `POST /projects` | `team_code`、`name` | 账号范围 · 按团队角色 | 在指定团队创建项目，创建者成为项目负责人。默认访问方式为 team_read。超时后先查项目列表。 |
| `get_project` | `GET /projects/:projectCode` | `projectCode` | 按项目可读范围 | 查看指定项目的基本信息、当前快照、访问方式和当前账号的项目权限。 |
| `update_project` | `PATCH /projects/:projectCode` | `name`、`projectCode` | 负责人、管理员 | 项目负责人或管理员修改项目名称及说明。传 null 可清空说明。 |
| `reorder_projects` | `PUT /projects/order` | `team_code`、`project_codes` | 账号范围 · 按团队角色 | 更新当前账号在一个团队中的项目显示顺序，按新顺序提交该团队的全部可访问项目编码。 |
| `archive_project` | `PATCH /projects/:projectCode/status` | `projectCode` | 负责人 | 项目负责人归档已完成交接的项目。归档后项目退出日常列表，恢复由系统管理员在后台处理。 |
| `get_project_home` | `GET /projects/:projectCode/home` | `projectCode` | 按项目可读范围 | 查看项目首页绑定的项目说明、参与指引和规范目录。 |
| `update_project_home` | `PUT /projects/:projectCode/home` | `projectCode` | 负责人、管理员 | 项目负责人或管理员将项目文档关联到首页。传 null 解除对应绑定。 |
| `preview_project_access_policy` | `GET /projects/:projectCode/access-policy` | `projectCode` | 负责人 | 项目负责人查看当前访问方式，或预览变更后哪些团队成员获得或失去继承权限。 |
| `update_project_access_policy` | `PUT /projects/:projectCode/access-policy` | `member_policy`、`projectCode` | 负责人 | 项目负责人更新团队成员默认访问方式。先预览影响并确认本次变更。 |
| `add_project_member` | `POST /projects/:projectCode/members` | `user_code`、`role`、`projectCode` | 负责人、管理员 | 为用户添加项目显式角色，支持团队外部协作者。授予管理员角色须由项目负责人执行。 |
| `update_project_member_role` | `PATCH /projects/:projectCode/members/:user_code` | `user_code`、`role`、`projectCode` | 负责人、管理员 | 修改显式项目成员角色。对只有团队继承权限的成员，使用添加项目成员建立显式角色。 |
| `remove_project_member` | `DELETE /projects/:projectCode/members/:user_code` | `user_code`、`projectCode` | 负责人、管理员 | 撤销项目显式角色。团队成员可能恢复默认权限，操作前核对项目访问方式并确认。 |

### 项目资料（`materials`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_project_document_library` | `GET /projects/:projectCode/handoff` | `projectCode` | 按项目可读范围 | 浏览项目文档库的文件夹及关联业务文档。 |
| `create_project_document_folder` | `POST /projects/:projectCode/handoff/folders` | `projectCode`、`name` | 项目成员 · 按业务规则 | 在项目文档库创建普通文件夹，可指定父目录。 |
| `create_project_document` | `POST /projects/:projectCode/handoff/documents` | `projectCode`、`title`、`content` | 项目成员 · 按业务规则 | 发布可长期复用的项目说明、规范或接口文档。单次执行证据随关联任务或测试。 |
| `revise_project_document` | `PATCH /handoff-documents/:document_code` | `projectCode`、`title`、`content`、`document_code`、`base_revision`、`change_summary` | 项目成员 · 按业务规则 | 按刚读取的修订号修改普通项目文档，保留历史。 |

### 代码规格（`code`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_code_analysis_jobs` | `GET /projects/:projectCode/code-understanding/analyses` | `projectCode` | 按项目可读范围 | 列出服务端仓库分析作业及排队、运行和发布状态。 |
| `request_project_code_analysis` | `POST /projects/:projectCode/code-understanding/analyses` | `projectCode`、`idempotency_key` | 项目成员 · 按业务规则 | 申请分析项目已登记仓库的唯一主线。请为同一次请求固定使用幂等键。 |
| `get_code_analysis_job` | `GET /projects/:projectCode/code-understanding/analyses/:job_code` | `projectCode`、`job_code` | 按项目可读范围 | 读取指定服务端分析作业的进度和结果。 |
| `list_code_intake_batches` | `GET /projects/:projectCode/intake` | `projectCode` | 按项目可读范围 | 列出项目规格候选批次和发布状态。 |

### 测试与证据（`testing`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `get_test_case` | `GET /test-cases/:case_code` | `projectCode`、`case_code` | 按项目可读范围 | 读取测试用例、步骤和历史修订。 |
| `create_test_case` | `POST /projects/:projectCode/test-cases` | `projectCode`、`title` | 项目成员 · 按业务规则 | 在项目中创建结构化测试用例及首个修订。 |
| `revise_test_case` | `PATCH /test-cases/:case_code` | `projectCode`、`case_code`、`base_revision`、`change_summary` | 项目成员 · 按业务规则 | 按刚读取的版本修订测试用例。 |
| `list_test_assets` | `GET /projects/:projectCode/test-assets` | `projectCode` | 按项目可读范围 | 列出测试资料、存储类型、长期说明和相关需求。 |
| `create_test_asset` | `POST /projects/:projectCode/test-assets` | `projectCode`、`storage_kind`、`title` | 项目成员 · 按业务规则 | 登记 Markdown 或链接形式的测试资料。 |
| `revise_test_asset` | `PATCH /test-assets/:asset_code` | `projectCode`、`storage_kind`、`asset_code`、`base_revision`、`change_summary` | 项目成员 · 按业务规则 | 按当前版本修订 Markdown 或链接形式的测试资料。 |
| `list_test_executions` | `GET /projects/:projectCode/test-executions` | `projectCode` | 按项目可读范围 | 按标题或执行环境查找项目历史测试执行和结果统计。 |
| `get_test_execution` | `GET /test-executions/:execution_code` | `projectCode`、`execution_code` | 按项目可读范围 | 读取一次实际测试执行的固定用例修订、结果和证据。 |

### 团队管理（`teams`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_teams` | `GET /teams` | 无 | 账号范围 · 按团队角色 | 列出当前账号加入的团队，返回团队编码和角色。创建项目时先找到所属团队。 |
| `create_team` | `POST /teams` | `name` | 账号范围 · 按团队角色 | 新建团队，当前账号成为负责人。超时后先查团队列表，再判断是否需要重试。 |
| `rename_team` | `PATCH /teams/:team_code` | `team_code`、`name` | 账号范围 · 按团队角色 | 团队负责人或管理员修改团队名称。 |
| `reorder_teams` | `PUT /teams/order` | `team_codes` | 账号范围 · 按团队角色 | 更新当前账号的团队显示顺序，按新顺序提交本人全部团队编码。 |
| `list_team_members` | `GET /teams/:team_code/members` | `team_code` | 账号范围 · 按团队角色 | 查看所属团队的正式成员及角色。项目外部协作者不在团队成员列表中。 |
| `list_team_projects_governance` | `GET /teams/:team_code/projects-governance` | `team_code` | 账号范围 · 按团队角色 | 团队负责人或管理员查看团队内活跃项目的名称、状态和负责人等管理信息。 |
| `preview_team_member_removal` | `GET /teams/:team_code/members/:user_code/removal-impact` | `team_code`、`user_code` | 账号范围 · 按团队角色 | 移出团队成员前查询其关联项目、所有权、未完成任务和进行中的 Run。 |
| `add_team_member` | `POST /teams/:team_code/members` | `team_code`、`user_code`、`role` | 账号范围 · 按团队角色 | 团队负责人或管理员向团队添加正式成员。只有团队负责人可授予管理员角色。 |
| `update_team_member_role` | `PATCH /teams/:team_code/members/:user_code` | `team_code`、`user_code`、`role` | 账号范围 · 按团队角色 | 调整团队成员角色。管理员的任免由团队负责人处理。 |
| `remove_team_member` | `DELETE /teams/:team_code/members/:user_code` | `team_code`、`user_code` | 账号范围 · 按团队角色 | 移出团队成员并撤销其在该团队下的项目授权。先预览影响并确认本次移出。 |

### 仓库管理（`repositories`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_project_repositories` | `GET /projects/:projectCode/repositories` | `projectCode` | 按项目可读范围 | 查看项目登记的 Git 仓库、默认分支、用途和状态。 |
| `create_project_repository` | `POST /projects/:projectCode/repositories` | `name`、`remote_url`、`projectCode` | 负责人、管理员 | 项目负责人或管理员登记一个项目 Git 仓库及其默认主线分支。 |
| `update_project_repository` | `PATCH /repositories/:repository_code` | `repository_code`、`projectCode` | 负责人、管理员 | 修改项目仓库名称、用途、远端地址或默认分支。用 null 清空用途或默认分支。 |
| `archive_project_repository` | `PATCH /repositories/:repository_code` | `repository_code`、`projectCode` | 负责人、管理员 | 归档项目仓库，停止作为活跃仓库使用。操作前确认要归档的仓库编码。 |
| `restore_project_repository` | `PATCH /repositories/:repository_code` | `repository_code`、`projectCode` | 负责人、管理员 | 将当前项目已归档的仓库恢复为活跃状态。 |

### 项目计划（`planning`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_project_modules` | `GET /projects/:projectCode/modules` | `projectCode` | 按项目可读范围 | 列出项目功能模块、状态和排序。 |
| `create_project_module` | `POST /projects/:projectCode/modules` | `projectCode`、`name` | 负责人、管理员 | 创建项目功能模块，供需求和 Feature 关联。 |
| `update_project_module` | `PATCH /modules/:module_code` | `projectCode`、`module_code` | 负责人、管理员 | 修改项目功能模块的名称、说明、顺序或状态。 |
| `reorder_project_modules` | `PUT /projects/:projectCode/modules/order` | `projectCode`、`module_codes` | 负责人、管理员 | 按项目全部模块的完整编码顺序重排。 |
| `get_project_feature` | `GET /features/:feature_code` | `projectCode`、`feature_code` | 按项目可读范围 | 查项目 Feature 的目标、状态、所属模块与里程碑。 |
| `create_project_feature` | `POST /features` | `projectCode`、`title` | 负责人、管理员 | 创建项目 Feature，供需求、缺陷和任务关联。 |
| `update_project_feature` | `PATCH /features/:feature_code` | `projectCode`、`feature_code` | 负责人、管理员 | 修改项目 Feature 的目标、状态、归属或计划日期。 |
| `reorder_project_features` | `PUT /projects/:projectCode/features/order` | `projectCode`、`feature_codes` | 负责人、管理员 | 按项目全部 Feature 的完整编码顺序重排。 |
| `list_project_phases` | `GET /projects/:projectCode/phases` | `projectCode` | 按项目可读范围 | 列出项目阶段、日期和目标。 |
| `create_project_phase` | `POST /projects/:projectCode/phases` | `projectCode`、`name` | 负责人、管理员 | 创建项目阶段。日期使用 YYYY-MM-DD。 |
| `update_project_phase` | `PATCH /phases/:phase_code` | `projectCode`、`phase_code` | 负责人、管理员 | 修改项目阶段。显式 null 可清空目标或日期。 |
| `list_project_milestones` | `GET /projects/:projectCode/milestones` | `projectCode` | 按项目可读范围 | 列出项目里程碑、所属阶段、负责人和目标日期。 |
| `create_project_milestone` | `POST /projects/:projectCode/milestones` | `projectCode`、`phase_code`、`name` | 负责人、管理员 | 为当前项目已有阶段创建里程碑。 |
| `update_project_milestone` | `PATCH /milestones/:milestone_code` | `projectCode`、`milestone_code` | 负责人、管理员 | 修改项目里程碑的阶段、日期、状态或负责人。 |

### 需求与议题（`requirements`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_requirements` | `GET /requirements` | `projectCode` | 按项目可读范围 | 列出当前项目结构化需求、状态和来源。可按关键词筛选。 |
| `get_requirement` | `GET /requirements/:requirement_code` | `projectCode`、`requirement_code` | 按项目可读范围 | 读取结构化需求、验收条件和版本。 |
| `create_requirement` | `POST /requirements` | `projectCode`、`feature_code`、`title`、`body` | 项目成员 · 按业务规则 | 为当前项目的 Feature 创建需求草稿。模块、文档与 Feature 须同项目。 |
| `update_requirement` | `PATCH /requirements/:requirement_code` | `projectCode`、`requirement_code` | 负责人、管理员 | 修改当前需求描述、验收条件、开放问题或同项目的关联对象。 |
| `transition_requirement` | `POST /requirements/:requirement_code/transition` | `projectCode`、`requirement_code`、`to` | 负责人、管理员 | 按需求状态机推进或废弃需求，先读当前状态和验收条件。 |
| `list_requirement_documents` | `GET /projects/:projectCode/requirement-documents` | `projectCode` | 按项目可读范围 | 列出版本化需求文档，可按模块和状态筛选。 |
| `create_requirement_document` | `POST /projects/:projectCode/requirement-documents` | `projectCode`、`module_code`、`title`、`content` | 项目成员 · 按业务规则 | 为已有功能模块创建需求文档及首个 Markdown 修订。 |
| `get_requirement_document` | `GET /requirement-documents/:document_code` | `projectCode`、`document_code` | 按项目可读范围 | 读取需求文档正文、修订和关联需求。 |
| `revise_requirement_document` | `PATCH /requirement-documents/:document_code` | `projectCode`、`document_code`、`title`、`summary`、`content`、`keywords`、`change_summary` | 项目成员 · 按业务规则 | 核对当前内容后新增完整的需求文档修订，保留历史。 |
| `list_requirement_baselines` | `GET /projects/:projectCode/requirement-baselines` | `projectCode` | 按项目可读范围 | 列出项目冻结需求基线。 |
| `list_requirement_baseline_bindings` | `GET /projects/:projectCode/requirement-baselines/bindings` | `projectCode` | 按项目可读范围 | 查询任务和交接已绑定的冻结需求基线。 |
| `get_requirement_baseline` | `GET /projects/:projectCode/requirement-baselines/:baseline_code` | `projectCode`、`baseline_code` | 按项目可读范围 | 读取冻结基线采用的具体需求修订和内容。 |
| `compare_requirement_baseline` | `GET /projects/:projectCode/requirement-baselines/:baseline_code/diff` | `projectCode`、`baseline_code` | 按项目可读范围 | 比较冻结基线与当前需求或另一条基线。 |
| `create_requirement_baseline` | `POST /projects/:projectCode/requirement-baselines` | `projectCode`、`name`、`scope`、`reason`、`parent_baseline_code`、`requirements` | 负责人、管理员 | 确认需要冻结后创建需求基线，传入刚核对的父基线和需求修订。 |
| `list_project_ideas` | `GET /projects/:projectCode/ideas` | `projectCode` | 按项目可读范围 | 列出项目想法池，可按标题、详情或归档状态筛选。 |
| `create_project_idea` | `POST /projects/:projectCode/ideas` | `projectCode`、`title` | 项目成员 · 按业务规则 | 将已确认需要记录的观察或想法加入想法池。 |
| `update_project_idea` | `PATCH /ideas/:idea_code` | `projectCode`、`idea_code` | 项目成员 · 按业务规则 | 修改想法内容或归档状态。权限由创建者和项目角色决定。 |
| `list_requirement_topics` | `GET /projects/:projectCode/requirement-topics` | `projectCode` | 按项目可读范围 | 列出需求讨论议题，可区分讨论中、已决定和已归档。 |
| `create_requirement_topic` | `POST /projects/:projectCode/requirement-topics` | `projectCode`、`title` | 项目成员 · 按业务规则 | 创建待讨论的需求议题，可关联同项目想法。 |
| `get_requirement_topic` | `GET /requirement-topics/:topic_code` | `projectCode`、`topic_code` | 按项目可读范围 | 读取议题全文、讨论条目和当前决定。 |
| `add_requirement_topic_entry` | `POST /requirement-topics/:topic_code/entries` | `projectCode`、`topic_code`、`content` | 项目成员 · 按业务规则 | 向议题补充评论、备选方案或反馈。 |
| `record_requirement_topic_decision` | `POST /requirement-topics/:topic_code/entries` | `projectCode`、`topic_code`、`entry_type`、`content` | 负责人、管理员 | 经确认后登记议题决策。替代历史决定时给出原决定编码。 |
| `link_requirement_topic_ideas` | `POST /requirement-topics/:topic_code/ideas` | `projectCode`、`topic_code`、`idea_codes` | 项目成员 · 按业务规则 | 将当前项目的想法关联到现有议题。 |
| `link_requirement_topic_documents` | `POST /requirement-topics/:topic_code/documents` | `projectCode`、`topic_code`、`document_codes` | 项目成员 · 按业务规则 | 将当前项目的需求文档关联到现有议题。 |

### 设计与架构（`design`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_design_prototypes` | `GET /projects/:projectCode/design-prototypes` | `projectCode` | 按项目可读范围 | 列出项目视觉和交互原型。 |
| `get_design_prototype` | `GET /design-prototypes/:prototype_code` | `projectCode`、`prototype_code` | 按项目可读范围 | 查看项目原型及其版本、需求关联和预览入口。 |
| `create_design_prototype_link` | `POST /projects/:projectCode/design-prototypes` | `projectCode`、`title`、`content_kind`、`external_url` | 项目成员 · 按业务规则 | 登记已有原型链接和来源需求。 |
| `revise_design_prototype_link` | `PATCH /design-prototypes/:prototype_code` | `projectCode`、`title`、`content_kind`、`external_url`、`requirement_codes`、`prototype_code`、`change_summary` | 项目成员 · 按业务规则 | 为已有链接原型追加新修订，保留历史。先读取原型确定关系和内容。 |
| `list_architecture_documents` | `GET /projects/:projectCode/architecture-documents` | `projectCode` | 按项目可读范围 | 列出架构图源和说明文档。 |
| `create_architecture_document` | `POST /projects/:projectCode/architecture-documents` | `projectCode`、`title`、`content_kind`、`source_content` | 项目成员 · 按业务规则 | 创建 Mermaid 或 Draw.io 文本图源及首个修订。 |
| `revise_architecture_document` | `PATCH /architecture-documents/:document_code` | `projectCode`、`content_kind`、`source_content`、`document_code`、`base_revision`、`change_summary` | 项目成员 · 按业务规则 | 按当前版本修订 Mermaid 或 Draw.io 图源，保留历史。 |

### 缺陷管理（`defects`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_project_defects` | `GET /defects` | `projectCode` | 按项目可读范围 | 列出本项目缺陷及复现、预期、实际和证据。 |
| `report_defect` | `POST /defects` | `projectCode`、`feature_code`、`title`、`severity`、`action_steps`、`expected_result`、`actual_result`、`evidence` | 项目成员 · 按业务规则 | 用操作步骤、预期结果、实际结果和文字或链接证据提交缺陷。 |
| `transition_defect` | `POST /defects/:defect_code/transition` | `projectCode`、`defect_code`、`to` | 项目成员 · 按业务规则 | 按缺陷状态机推进，修复中需提供同一缺陷的修复任务。 |

### 技能库（`skills`）

| 工具名 | 业务接口 | 必填参数 | 范围或角色 | 用途 |
| --- | --- | --- | --- | --- |
| `list_project_skill_catalog` | `GET /projects/:projectCode/skills` | `projectCode` | 按项目可读范围 | 查看项目采用的技能、别名、修订和启用状态。 |
| `read_project_skill_text` | `GET /projects/:projectCode/skills/reader` | `projectCode`、`skill`、`revision` | 按项目可读范围 | 分页读取项目或当前 Run 固定技能的单个文本文件。 |
| `set_project_skill_version` | `PUT /projects/:projectCode/skills/:skill_code` | `projectCode`、`skill_code`、`revision`、`alias`、`enabled`、`base_generation` | 负责人、管理员 | 管理项目使用的技能版本和启用状态。传入刚读取的版本代数。 |
