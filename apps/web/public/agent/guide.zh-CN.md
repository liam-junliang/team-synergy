# Team Synergy Agent 操作手册

## 1. 确认账号、项目与授权

### 优先使用 HTTP Connector

无需下载 Connector 或安装 CLI。在支持远程 HTTP MCP 与 OAuth 的宿主中，从平台「Agent 接入」复制 HTTP Connector 服务地址，并在宿主的 MCP 或 Connector 设置中添加远程连接。宿主发起 OAuth 后，在浏览器登录 TeamSynergy。已有登录会话时会直接进入授权页。核对账号、客户端和回调地址，按需授权后返回宿主。账号授权允许同一个会话按项目权限操作多个项目，无需安装 `tsp` 或绑定本地目录。

默认按需查项目资料。要创建和推进任务，在授权页选择「可协作」。账号个人记忆读取单独授权，连接保持会话采集关闭。无法发起 OAuth 且支持自定义请求头的宿主，可在接入页的高级设置生成有期限的授权凭据。

### 在当前 Connector 确认账号、项目与工具

用 `read_connector_skill {}` 查看内置操作流程，需要详细说明时传 `module`。用 `get_connection_context {}` 核对账号与连接权限，再用 `list_projects {}` 找到目标项目与角色。在同一连接上为每次项目操作传入目标 `projectCode`。切换项目时核对项目归属，分别保留文档、代码和任务来源。写入目标不明确时先确认。

用 `search_tools {}` 看模块概况。按 `module` 和 `query` 查找工具，传目标 `projectCode` 可按当前项目权限筛选。调用时以当前连接返回的参数定义为准。

```text
read_connector_skill  {"module":"tasks"}
get_connection_context  {}
list_projects  {}
search_tools  {"projectCode":"PROJECT_CODE","module":"tasks","query":"草稿"}
```

### 本地 CLI 接入

需要本机工作树、设备绑定或显式启用采集时，在接入页选择「本地 CLI」。安装并授权 `tsp` 后，用 `tsp tools list` 查看查询工具的输入定义。`tsp tools call` 用 `--input` 接收 JSON，用 `--project` 指定该次调用的项目。使用 CLI 时，从当前登录的平台发现项目，并在该平台内使用其返回的编码。宿主直接调用平台工具时，配置 HTTP Connector。

```bash
tsp tools call get_connection_context
tsp tools call list_projects
```

### 核对操作权限

平台权限与操作者授权都适用。可以按需读取已授权项目的资料。创建、分派、领取、提交、推送或合并前，核对本次指示和当前权限。账号偏好只指导工作方式。权限或项目选择不明确时，说明具体阻塞后向操作者确认。

## 2. 检索项目资料并引用来源

### 选择索引、Glob 或 Grep

用目录查询按标题、摘要或路径定位资料，用 Glob 缩小虚拟路径范围，用 Grep 查正文。目录关键词和 Grep 默认按字面匹配。需要多模式匹配时显式选择 `regex`。按返回的引用或虚拟路径读取必要段落，核对修订版本和当前状态。回答时提供标题、修订和相关行号。一轮检索无命中时，可缩短关键词或调整范围。

### 在 Connector 中查目录、搜索和原文

以下示例中的大写占位符须替换为当前项目的实际值。`SOURCE_CITATION` 使用检索结果中的完整引用。

在当前 Connector 中逐行调用工具，空格后是该工具的 JSON 参数。需要定位方式、行范围和引用参数时，用 `read_connector_skill {"module":"materials"}`。

```text
list_project_materials  {"projectCode":"PROJECT_CODE","limit":10}
glob_project_materials  {"projectCode":"PROJECT_CODE","pattern":"requirement/*.md"}
grep_project_materials  {"projectCode":"PROJECT_CODE","pattern":"KEYWORD"}
read_project_material  {"projectCode":"PROJECT_CODE","sourceCitation":"SOURCE_CITATION"}
```

本机 CLI 对应 `tsp docs index`、`tsp docs glob`、`tsp docs grep` 和 `tsp docs read`，指定目标项目后执行。

### 归档长期资料，关联单次证据

把长期复用的背景、需求、架构、设计、规范、指南和测试策略放在对应文档或业务页面。测试指南、环境说明和可复用的验收矩阵适合收录到文档库。从关联任务查交付源码或构建产物，从测试执行查单次验收结果和日志，从缺陷查截图或录屏。用链接或对象编码关联这些原件。

## 3. 按产品对象核对项目事实

### 从 Feature 顺着需求、设计和代码查

先看项目首页、功能模块和 Feature，理解业务边界。计划页面的阶段和里程碑提供时间与依赖背景。在需求页面查需求状态、当前修订和相关交付任务。设计页面的原型和配套说明描述预期交互，架构资料描述系统边界。若任务关联冻结基线，按基线查当次实施范围，发现新版差异时向负责人确认。到规格页面或代码工具核对实现版本。

先用 `list_project_features`、`list_project_materials` 和代码工具查 Connector 能读取的事实。需要查看独立的需求、原型和计划状态时，可前往平台对应页面，或在本机使用以下 CLI。

```bash
tsp feature list --project PROJECT_CODE
tsp requirement show REQUIREMENT_CODE
tsp design list --project PROJECT_CODE
tsp design show PROTOTYPE_CODE
tsp architecture list --project PROJECT_CODE
```

### 按用例、执行与缺陷定位测试事实

用例给出检查步骤与预期。执行记录给出实际结果、固定版本和证据。缺陷记录说明实际操作、预期、实际结果和原始证据。根据这些输入确认失败是否能复现及影响范围。Connector 可用 `list_test_cases` 查用例，按 `read_connector_skill {"module":"testing"}` 的说明用 `record_test_execution` 登记真实结果。任务交付状态通过任务记录和验收确认。

本机 CLI 可用 `tsp test execution record --project PROJECT_CODE --file EXECUTION_FILE` 登记结果。具体测试执行和缺陷也可从平台页面核对。

```bash
tsp test case list --project PROJECT_CODE
tsp test execution show EXECUTION_CODE
tsp defect list --project PROJECT_CODE
```

记录测试执行时，`EXECUTION_FILE` 使用以下结构。用真实修订号、结果和发现替换示例值。

```json
{
  "title": "EXECUTION_TITLE",
  "environment": "TEST_ENVIRONMENT",
  "tested_version": "TESTED_VERSION",
  "source": "agent",
  "asset_refs": [{"asset_code":"ASSET_CODE","revision":1}],
  "results": [{"case_code":"CASE_CODE","case_revision":1,"result":"fail","actual_result":"ACTUAL_RESULT"}]
}
```

经授权上报时，使用真实复现内容并附至少一项证据。可将示例的文本证据改成 `--evidence-file FILE_PATH` 或 `--evidence-url EVIDENCE_URL`。发现版本和关联需求明确时一起记录。

```bash
tsp defect report --feature FEATURE_CODE --title "DEFECT_TITLE" --severity medium --action "REPRO_STEPS" --expected "EXPECTED_RESULT" --actual "ACTUAL_RESULT" --evidence-text "OBSERVED_EVIDENCE"
```

## 4. 查项目记忆、个人记忆和代码

### 找到适用的记忆并确认来源

近期项目背景用 `read_memory_brief`，明确的主题用 `search_memory`。在 Connector 中用 `read_memory_sources` 回读来源，按来源类型读取资料或记忆文档。区分讨论、决定与实现或测试确认的事实。可复用本会话仍适用的来源。通过 CLI 可用 `tsp tools call read_memory_source` 回读单个来源；参数以 `tsp tools list` 返回的定义为准。

Connector 的个人记忆需单独授权。确认授权后，在当前项目调用 `search_memory` 并将 `scope` 设为 `personal`。CLI 可用 `tsp tools call list_personal_memories` 查看账号通用偏好。个人信息仅用于当前账号授权的工作。

### 用固定版本的代码图取证

先用 `read_code_catalog` 选定仓库和分析版本。调用 `query_code_graph` 时用 `run_code` 或 `view_code` 其中之一。引用分析对应的提交和源码位置。确认当前实现或线上行为时，再查对应版本的源码或执行记录。

```text
read_memory_brief  {"projectCode":"PROJECT_CODE","scope":"project"}
search_memory  {"projectCode":"PROJECT_CODE","scope":"project","query":"KEYWORD"}
read_memory_sources  {"projectCode":"PROJECT_CODE","scope":"project","sources":["MEMORY_SOURCE"]}
read_code_catalog  {"projectCode":"PROJECT_CODE"}
query_code_graph  {"projectCode":"PROJECT_CODE","run_code":"ANALYSIS_RUN_CODE","query":"SYMBOL"}
```

## 5. 使用技能与会话采集

### 读取 Connector 内置操作说明

用 `read_connector_skill {}` 查协作流程，用 `module` 查六个模块中的一个。工具说明可在当前 HTTP 连接中直接读取，各项目的可用操作由账号权限决定。

### 在本机按平台、项目和运行版本选择技能

从平台技能目录查看已发布的内置技能，从项目目录查看已采用的技能。已有任务 Run 时用其 `run_code` 读取当次固定技能版本。先确认技能的适用范围和修订，再读取所需的 `SKILL.md` 或参考文件。把示例中的 `revision` 换成目录返回的版本。

```text
list_platform_skills  {}
read_platform_skill  {"skill":"SKILL_CODE","revision":1}
list_project_skills  {"projectCode":"PROJECT_CODE","run":"RUN_CODE"}
read_project_skill  {"projectCode":"PROJECT_CODE","run":"RUN_CODE","skill":"SKILL_CODE","revision":1}
```

### 核对检索与宿主采集状态

HTTP Connector 提供按需检索和任务工具，配置连接不会自动开启会话采集。只有操作者明确同意保存当前工作区的新会话时，才进入「本地 CLI」接入，安装并授权 CLI，在项目工作区根目录注册原生 Hook 或插件。先确认 `tsp project current` 返回目标项目；未绑定时先绑定，绑定不符时停止并核对。将 `HARNESS` 替换为 `codex`、`dsh` 或 `opencode`。Codex 安装后由操作者在 `/hooks` 审阅信任，并用新会话验证。Claude Code 的会话采集暂未开放，可使用 HTTP Connector 查询和协作。

```bash
tsp project current
tsp memory native install --harness HARNESS
tsp memory native doctor --harness HARNESS
```

停止当前工作区的采集时，执行 `tsp memory native uninstall --harness HARNESS`。该命令只移除平台管理的采集条目，保留其他插件和已入队记录。

依次核对宿主注册、本地入队、平台接收、整理和记忆可检索状态。`doctor` 报告本机状态。平台采集与处理记录用于核实服务端进展。查看或纠正私有偏好时使用账号的「我的记忆」，保持项目来源与私人偏好分开。

## 6. 建立任务草稿并分派

### 通过 Connector 建草稿和分派

用 `list_project_features` 找目标 Feature，`create_task_draft` 写入背景和可观察的验收项。同一次创建重试沿用 `idempotency_key`。用 `get_task` 检查 `draft` 与当前 `base_snapshot`。需要分派时，负责人或管理员先通过 `list_project_members` 核对执行者，再使用 `assign_task` 并回读 `assigned`。具体输入用 `read_connector_skill {"module":"tasks"}`。

### 用本机 CLI 建立任务草稿

找到目标项目的 Feature。把背景、上下游、允许改动范围、依赖和可观察验收写入执行简报 `brief.md`。有写权限的项目成员可以建立 `ad-hoc` 草稿。项目负责人或管理员按来源创建其他任务，需求用 `--source requirement --requirement REQUIREMENT_CODE`，缺陷修复用 `--source defect-fix --defect DEFECT_CODE`。以下是临时任务示例。用 `--depends-on` 指定已知依赖任务编码，多个编码用逗号分隔。

```bash
tsp feature list --project PROJECT_CODE
tsp task create --feature FEATURE_CODE --title 'TASK_TITLE' --profile builder --source ad-hoc --acceptance '[{"id":"AC-1","text":"ACCEPTANCE_CRITERION"}]' --scope '{"writable_paths":["WRITABLE_PATH"]}' --brief-file brief.md
```

Windows PowerShell 使用安装包提供的 `tsp.cmd` 传递 JSON。

```powershell
$acceptance = '[{"id":"AC-1","text":"ACCEPTANCE_CRITERION"}]'.Replace('"', '\"')
$scope = '{"writable_paths":["WRITABLE_PATH"]}'.Replace('"', '\"')
tsp.cmd task create --feature FEATURE_CODE --title 'TASK_TITLE' --profile builder --source ad-hoc --acceptance $acceptance --scope $scope --brief-file brief.md
```

### 用本机 CLI 核对草稿并分派

回读真实任务编码与 `draft` 状态。项目负责人或管理员核对草稿后，将其分派给有权限的项目成员。分派会校验验收标准，回读状态确认 `assigned`。

```bash
tsp task assign TASK_CODE --assignee USER_CODE
tsp task status TASK_CODE
```

## 7. 领取任务并执行

### 通过 Connector 领取到已有执行环境

用 `list_tasks` 与 `get_task` 核对本人的 `assigned` 任务和最新快照。准备真实可访问的 HTTPS `workspace_url` 与对应的 Git 基线 `git_base`，再调用 `claim_task`。保留实际返回的 `run_code` 和任务链接。执行工作区由宿主或操作者准备。受设备租约约束的任务走本机入口。

### 在本机检查任务与仓库基线

执行者从可能跨项目的指派列表里找到任务，核对项目、执行简报、验收标准、分派身份以及依赖是否已经关闭。确认来源仓库与 `HEAD` 的提交符合任务基线。领取时从仓库 `HEAD` 创建工作树，未提交文件不会随基线带入。

```bash
tsp task list --assigned-to me
tsp task status TASK_CODE
tsp task claim TASK_CODE --profile builder --repo "REPO_PATH"
```

### 在本次 Run 的工作树实施

在私有运行目录领取，可用 `ACP_WORKSPACES_DIR` 指定工作区根目录。保留返回的 `run_code` 和 `pack`。进入 `ACP_WORKSPACES_DIR/RUN_CODE/repo`，未设置时进入领取目录下的 `.worktrees/RUN_CODE/repo`。读运行简报并按授权范围实施，分支与提交遵循项目 Git 规范。

### 按项目规范准备分支与 PR

读取项目 Git 规范，核对目标分支和基线。只在本次工作树改动约定路径，提交前同步该目标的最新代码并复查差异。需要 PR 时记录任务编码、基线 SHA、待审 SHA、实际验证和已知缺口。后续提交改动了待审 SHA 时，对新版本重新验证。

## 8. 自测并提交交付证据

### 通过 Connector 提交产物与证据

逐项自测后用 `get_task` 回读当前运行和 `base_snapshot`。调用 `submit_task_evidence` 时，`artifact.uri` 存放可核验的 HTTPS 产物链接，`artifact.content_hash` 单独存放该产物的内容哈希，`evidence.acceptance_refs` 关联实际通过的验收项。提交后回读 `submitted` 并交给独立验收。登记现有测试用例结果使用 `record_test_execution`，无需因此改变任务状态。

### 用本机 CLI 提交真实的自测与产物引用

逐项自测，记下实际命令、通过的验收编号、结果及未覆盖范围。需要 PR 时按项目流程和本次授权操作，核对实际 PR 链接与提交 SHA。仅在自测通过后提交。`COMMIT_SHA` 是实际交付提交，`AC-1` 替换为证据覆盖的验收编号，多个编号用逗号分隔。

```bash
tsp task submit TASK_CODE --run-code BUILDER_RUN --artifact-kind commit --artifact-uri git:COMMIT_SHA --artifact-hash COMMIT_SHA --evidence-type self_test --evidence-result pass --acceptance-refs AC-1 --evidence-command "TEST_COMMAND" --evidence-summary "TEST_SUMMARY"
tsp task status TASK_CODE
```

### 回读状态与交付证据

回读确认 `submitted`。自测失败或证据不足时，记录结果并解决问题后再提交。把实际产物、测试结果、PR 和待审 SHA 交给独立验收者。

## 9. 独立验收并关闭

用 `get_task` 查验收项与证据，`get_task_workflow` 查最新快照、交付编码及验收人。独立验收者用 `start_task_review` 开始，使用新快照和已核验交付编码调用 `finish_task_review`。通过须覆盖全部验收项。项目负责人或管理员用 `close_task` 关闭 `verified` 任务。CLI 可用 `tsp task workflow`、`tsp task review-start`、`tsp task review-finish` 完成同一流程。

### 在待审提交上单独复测

验收者把待审提交检出到独立本机目录，在该目录的 `HEAD` 核对 SHA，再用 `verifier` 身份领取单独的 Run。复测已提交版本。通过时覆盖全部验收编号，并留下命令、实际结果和差异或 PR 证据。

```bash
tsp task claim TASK_CODE --profile verifier --repo "REVIEW_REPO_PATH"
tsp task verify TASK_CODE --run-code VERIFIER_RUN --evidence-result pass --acceptance-refs AC-1 --evidence-command "REVIEW_COMMAND" --evidence-summary "REVIEW_SUMMARY"
tsp task status TASK_CODE
```

### 按验收结果推进状态

验收结论按实际填写。`fail` 或 `inconclusive` 会进入 `failed`，记录可复现证据和阻塞，由负责人安排返工。验收通过后回读 `verified`。平台验收、PR 审批和合入是不同记录。满足项目交付与合入要求后，由项目负责人或管理员关闭，再回读 `closed`。

```bash
tsp task close TASK_CODE
tsp task status TASK_CODE
```

## 10. 处理阻塞、返工与交接

### 先查状态与阻塞证据

遇到依赖、权限、目标分支、验收冲突或已有活跃 Run，回读任务详情和审计。将当前项目、任务、Run 或提交 SHA、已尝试的操作、实际报错和下一项所需决定交给操作者。需要新增工作时，按授权关联需求或缺陷。修改失败后先回读最新状态与权限，再决定是否重试。

明确要取消时，项目负责人或管理员读取 `get_task_workflow` 后按最新快照和实际原因调用 `cancel_task`。CLI 执行中取消使用 `tsp task cancel TASK_CODE --execution --base-snapshot SNAPSHOT --reason "REASON"`。Run 仍可能运行时，确认中止后使用 `confirm_active: true` 或 CLI 的 `--confirm-active`。

```bash
tsp task status TASK_CODE
tsp task history TASK_CODE
```

### 把可恢复的工作交给另一位成员

需要跨人接续时，用交接记录固定任务、代码及上下文，列出已完成的步骤、未完成项、证据和验证入口。原执行者提供经审阅的结构化摘要并与负责人协调停止源 Agent，再准备交接。负责人发布后，接手者使用自己的账号接受，在新的工作树恢复、核对版本，最后激活。通过平台交接页或 `tsp task handover show HANDOVER_CODE` 核对真实状态。`SUMMARY_FILE` 是经审阅的共享摘要 JSON，填入真实目标、进展、剩余工作、下一步和证据引用。

```json
{
  "goal": "TASK_GOAL",
  "completed": ["COMPLETED_STEP"],
  "remaining": ["REMAINING_STEP"],
  "next_actions": ["VERIFICATION_STEP"],
  "evidence_refs": ["EVIDENCE_REFERENCE"]
}
```

```bash
tsp task handover prepare TASK_CODE --target USER_CODE --run SOURCE_RUN --summary SUMMARY_FILE --agent-stopped
tsp task handover publish HANDOVER_CODE
tsp task handover accept HANDOVER_CODE
tsp task handover restore HANDOVER_CODE --repo "REPO_PATH" --dir "NEW_WORKTREE"
tsp task handover activate HANDOVER_CODE
```

## 管理团队、项目和业务记录

使用 `search_tools {"module":"teams","query":"创建团队"}` 或 `tsp tools search 创建团队 --module teams` 找动作。先用 `list_teams` 查团队编码，再调用 `create_project`。CLI 可用 `tsp tools call create_project --input '{"team_code":"TEAM_CODE","name":"示例项目"}'`。项目内查成员、仓库、需求、设计、缺陷和测试时，每次明确传目标项目编码。

Connector 在授权时勾选「管理团队和项目」才能管理团队或更改业务记录。角色、目标状态及修订仍由平台逐次校验。使用模块参考和工具 schema 查具体输入。新建操作超时后先回查，避免重复提交。
