# Team Synergy Agent 操作手册

## 1. 确认账号、项目与授权

### 确认当前项目

接入后，遇到依赖项目现状或团队决定的问题，主动查询相关资料。先用 `get_connection_context` 核对当前账号和默认项目。默认项目不明确，或操作者指定了其他项目时，用 `list_projects` 找到与意图一致的项目。仍有歧义就询问操作者。选定后，向项目工具明确传入结果中的 `projectCode`，切换项目时重新核对。

### 直接用 MCP

从宿主的 Team Synergy 工具列表直接发起调用。下面每一行代表一次调用，工具名后是参数。确认项目后，把 `PROJECT_CODE` 换成实际项目编码，把 `SOURCE_CITATION` 换成搜索结果给出的完整引用。

```text
get_connection_context  {}
list_projects  {}
grep_project_materials  {"projectCode":"PROJECT_CODE","pattern":"KEYWORD"}
read_project_material  {"projectCode":"PROJECT_CODE","sourceCitation":"SOURCE_CITATION"}
```

用 MCP 查资料原文、项目或个人记忆、代码证据和技能版本。需要发布、分派、领取、提交、验收或关闭任务时，按对应章节使用 CLI 或平台页面。下文的记忆和技能章节还有可直接调用的 MCP 参数示例。

### 通过 CLI 使用同一批查询工具

用 `tsp tools list` 查看共用的参数定义。`tsp tools call` 用 `--input` 接收 JSON，用 `--project` 指定该次调用的项目。

```bash
tsp tools call get_connection_context
tsp tools call list_projects
```

### 核对操作权限

平台权限与操作者授权都适用。可以按需读取已授权项目的资料。创建、分派、领取、提交、推送或合并前，核对本次指示和当前权限。账号偏好只指导工作方式。权限或项目选择不明确时，说明具体阻塞后向操作者确认。

## 2. 检索项目资料并引用来源

### 选择索引、Glob 或 Grep

用目录查询按标题、摘要或路径定位资料，用 Glob 缩小虚拟路径范围，用 Grep 查正文。目录关键词和 Grep 默认按字面匹配。需要多模式匹配时显式选择 `regex`。按返回的引用或虚拟路径读取必要段落，核对修订版本和当前状态。回答时提供标题、修订和相关行号。一轮检索无命中时，可缩短关键词或调整范围。

### CLI 与 MCP 查询示例

以下示例中的大写占位符须替换为当前项目的实际值。`VIRTUAL_PATH` 与 `SOURCE_CITATION` 取自检索结果。

```bash
tsp project home PROJECT_CODE
tsp docs index --project PROJECT_CODE --limit 10
tsp docs glob 'requirement/*.md' --project PROJECT_CODE
tsp docs grep "KEYWORD" --project PROJECT_CODE
tsp docs read "VIRTUAL_PATH" --project PROJECT_CODE
```

MCP 中逐行分别调用工具，空格后是该工具的 JSON 参数。

```text
list_project_materials  {"projectCode":"PROJECT_CODE","limit":10}
glob_project_materials  {"projectCode":"PROJECT_CODE","pattern":"requirement/*.md"}
grep_project_materials  {"projectCode":"PROJECT_CODE","pattern":"KEYWORD"}
read_project_material  {"projectCode":"PROJECT_CODE","sourceCitation":"SOURCE_CITATION"}
```

### 归档长期资料，关联单次证据

把长期复用的背景、需求、架构、设计、规范、指南和测试策略放在对应文档或业务页面。测试指南、环境说明和可复用的验收矩阵适合收录到文档库。从关联任务查交付源码或构建产物，从测试执行查单次验收结果和日志，从缺陷查截图或录屏。用链接或对象编码关联这些原件。

## 3. 按产品对象核对项目事实

### 从 Feature 顺着需求、设计和代码查

先看项目首页、功能模块和 Feature，理解业务边界。计划页面的阶段和里程碑提供时间与依赖背景。在需求页面查需求状态、当前修订和相关交付任务。设计页面的原型和配套说明描述预期交互，架构资料描述系统边界。若任务关联冻结基线，按基线查当次实施范围，发现新版差异时向负责人确认。到规格页面或代码工具核对实现版本。

```bash
tsp feature list --project PROJECT_CODE
tsp requirement show REQUIREMENT_CODE
tsp design list --project PROJECT_CODE
tsp design show PROTOTYPE_CODE
tsp architecture list --project PROJECT_CODE
```

### 按用例、执行与缺陷定位测试事实

用例给出检查步骤与预期。执行记录给出实际结果、固定版本和证据。缺陷记录说明实际操作、预期、实际结果和原始证据。根据这些输入确认失败是否能复现及影响范围。用 `tsp test execution record --project PROJECT_CODE --file EXECUTION_FILE` 保存实际执行结果时，填真实用例修订与资料引用。任务交付状态通过任务记录和验收确认。

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

近期项目背景用 `read_memory_brief`，明确的主题用 `search_memory`。用 `read_memory_source` 核对必要的原始记录。分别标明讨论中的设想、已确认结论和有事实支撑的落实情况。落实情况要查对应实现或执行证据。已有充分来源时复用本会话的结果。需要核对更新时，使用同一上下文返回的最新 `context_receipt`。

账号通用偏好可用 `list_personal_memories` 查看。需要特定项目内的个人偏好时显式传入项目，或用 `search_memory` 将 `scope` 设为 `personal`。个人信息仅用于当前账号授权的工作。

### 用固定版本的代码图取证

先用 `read_code_catalog` 选定仓库和分析版本。调用 `query_code_graph` 时用 `run_code` 或 `view_code` 其中之一。引用分析对应的提交和源码位置。确认当前实现或线上行为时，再查对应版本的源码或执行记录。

```text
read_memory_brief  {"projectCode":"PROJECT_CODE","scope":"project"}
search_memory  {"projectCode":"PROJECT_CODE","scope":"project","query":"KEYWORD"}
read_memory_source  {"projectCode":"PROJECT_CODE","source":"MEMORY_SOURCE"}
list_personal_memories  {}
read_code_catalog  {"projectCode":"PROJECT_CODE"}
query_code_graph  {"projectCode":"PROJECT_CODE","run_code":"ANALYSIS_RUN_CODE","query":"SYMBOL"}
```

## 5. 使用技能与会话采集

### 按平台、项目和运行版本选择技能

从平台技能目录查看已发布的内置技能，从项目目录查看已采用的技能。已有任务 Run 时用其 `run_code` 读取当次固定技能版本。先确认技能的适用范围和修订，再读取所需的 `SKILL.md` 或参考文件。把示例中的 `revision` 换成目录返回的版本。

```text
list_platform_skills  {}
read_platform_skill  {"skill":"SKILL_CODE","revision":1}
list_project_skills  {"projectCode":"PROJECT_CODE","run":"RUN_CODE"}
read_project_skill  {"projectCode":"PROJECT_CODE","run":"RUN_CODE","skill":"SKILL_CODE","revision":1}
```

### 核对检索与宿主采集状态

CLI 与 MCP 提供主动取证。会话采集另由原生 Hook 或插件接收符合当前工作区注册范围的新操作者输入。只有明确需要启用采集时，才在已登录且明确绑定项目的工作区注册实际宿主。将 `HARNESS` 替换为 `codex`、`dsh` 或 `opencode`。Codex 安装后由操作者在 `/hooks` 审阅信任，并用新会话验证。

```bash
tsp memory native install --harness HARNESS
tsp memory native doctor --harness HARNESS
```

依次核对宿主注册、本地入队、平台接收、整理和记忆可检索状态。`doctor` 报告本机状态。平台采集与处理记录用于核实服务端进展。查看或纠正私有偏好时使用账号的「我的记忆」，保持项目来源与私人偏好分开。

## 6. 建立任务草稿并分派

### 写成可领取的任务

任务流转用 CLI 或平台页面。MCP 可以查背景资料，任务领取和本机工作树创建使用 CLI。

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

### 核对草稿并指派执行者

回读真实任务编码与 `draft` 状态。项目负责人或管理员核对草稿后，将其分派给有权限的项目成员。分派会校验验收标准，回读状态确认 `assigned`。

```bash
tsp task assign TASK_CODE --assignee USER_CODE
tsp task status TASK_CODE
```

## 7. 领取任务并在独立工作树执行

### 检查任务与仓库基线

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

### 提交真实的自测与产物引用

逐项自测，记下实际命令、通过的验收编号、结果及未覆盖范围。需要 PR 时按项目流程和本次授权操作，核对实际 PR 链接与提交 SHA。仅在自测通过后提交。`COMMIT_SHA` 是实际交付提交，`AC-1` 替换为证据覆盖的验收编号，多个编号用逗号分隔。

```bash
tsp task submit TASK_CODE --run-code BUILDER_RUN --artifact-kind commit --artifact-uri git:COMMIT_SHA --artifact-hash COMMIT_SHA --evidence-type self_test --evidence-result pass --acceptance-refs AC-1 --evidence-command "TEST_COMMAND" --evidence-summary "TEST_SUMMARY"
tsp task status TASK_CODE
```

### 回读状态与交付证据

回读确认 `submitted`。自测失败或证据不足时，记录结果并解决问题后再提交。把实际产物、测试结果、PR 和待审 SHA 交给独立验收者。

## 9. 独立验收并关闭

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
