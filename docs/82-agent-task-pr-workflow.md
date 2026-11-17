# 任务发布、Agent隔离执行与PR验收规范

版本：1.1　｜　2026-11-17　｜　适用于平台项目中的人工与成员自带Agent

## 职责与事实来源

负责人明确目标、范围、验收和依赖；执行Agent从平台读取任务及当前项目资料，在独立Run和Git worktree实现；审查Agent独立核对代码与证据；负责人根据结果决定合入和关闭。方案确认、代码提交、PR合并、测试通过及任务关闭分别记录，不可互相替代。人工负责的账号可承载多个Agent Run，不伪造成员或提升观看者权限。

平台保存任务契约、Run和验收记录；Git远端保存提交、PR、检查及合并事实；真实命令、附件原件和哈希是验证依据。记忆与资料检索用于定位当前事实，不授予本轮推送或合并权限。本轮操作者已明确授权指定仓库内的开发、推送、PR审核及通过后合入；其他任务仍以其当轮授权为准。

## 1. 发布可执行任务

需求先记录问题、设计、影响范围和可观察验收；设计类任务关联需求修订与冻结基线。缺陷必须包含实际操作、预期、实际和证据。维护任务可以使用ad-hoc，不虚构需求。Task须给出Feature、profile、允许写入路径、验收ID、相关来源和依赖；负责人先分派，执行者再领取。

CLI入口为`tsp task create`、`tsp task assign <TASK> --assignee <USER>`。此时MCP没有任务领取/提交能力，执行者使用真实CLI，不能假装调用不存在的MCP工具。统一任务能力的补齐另建需求。

## 2. 执行者自行取上下文

执行者先运行`tsp task status <TASK>`，读取简报、原缺陷或需求、固定基线、项目首页和当前规范。项目背景使用CLI/MCP按需检索，不全量灌入文档。任务码和已授权仓库是派工入口，负责人转述不能替代平台契约。遇到范围、目标分支或验收冲突，保留证据并回报，不能扩大写入范围。

## 3. 领取独立Run和worktree

在执行者私有运行目录调用`tsp task claim <TASK> --profile builder --repo <基线仓库>`，设置绝对`ACP_WORKSPACES_DIR`到私有运行区。先核实基线SHA、远端和当前分支；claim取的是仓库HEAD，不携带未提交修改。依赖须closed，verified不足以解除依赖。不要在共享源码目录执行可能生成指导文件的领取准备。

claim会创建真实detached worktree、平台Run、Workspace与固定Context Pack。工作区建立后按Git规范创建`feature/<TASK>-<简述>`、`fix/<TASK>-<简述>`或对应维护分支。独立worktree不能用共享node_modules的目录联接替代依赖安装，构建产物也应留在各自工作树，避免跨任务覆盖。不得在已有脏目录上静默stash/reset/clean。

`task attach`只是登记外部共享工作目录，不能冒称隔离执行；仅用于明确注明的基线整理或特殊外部执行情形。`workspace create`本身不登记任务Run，不能替代task claim。

## 4. 实现、自测、提交PR

实现仅写任务允许路径，不覆盖他人变更。开始及最终提交前fetch最新远端、核实目标并集成基线；遵守《Git分支、提交与合并规范》当前修订。标题使用中文ConventionalCommits，正文如实记录验证及必要Lore trailers。禁止直接推送main或强推共享分支。

按影响范围运行lint、类型、构建和行为验证。数据库测试必须使用专用测试集群与全新租约，禁止将业务库或业务引擎配置传给测试；测试日志和单次验收结果归任务或测试执行，源码包不塞进文档库。纯规范修改验证内容、示例和链接，无需重跑重型数据库测试。

执行者推送任务分支，PR包含问题、最终行为、影响、真实验证、风险及回退。说明任务编码、基线SHA和待审SHA。提交前确认实际GitHub PR状态，不把本地提交当成已发布。依赖中的基线PR尚未合并时，可先创建明确指向该整合分支的draft；基线合并后须重核目标、最终diff和CI。

用`tsp task submit <TASK> --run-code <BUILDER_RUN>`提交真实commit产物、hash、自测pass和验收ID；完整参数见CLI help。证据摘要必须含PR URL与SHA，不可仅写“测试通过”。提交后由独立审查接手，Builder不自行宣布验收完成。

## 5. 独立审查、合入与关闭

根负责人安排独立审查Agent，审查者重新读取任务契约、PR差异和实际证据，核对权限、边界、兼容性及未覆盖项；记录APPROVE或具体返工意见。通过独立`task claim <TASK> --profile verifier --repo <包含待审提交的仓库>`建立verifier Run，核对实际待审SHA。不得拿Builder Run写verifier_review。

独立Agent审查和GitHub账号Approval是两种事实。同一登录账号下的不同Agent/Run不能冒称另一个GitHub用户批准。当前仓库若无强制第二账号审批且操作者已授权负责人代理审查合入，可以记录真实Agent审查及同账号COMMENT后合并；若实际保护规则或组织制度要求另一账号批准，必须取得真实批准，禁止绕过或降低规则。不能把本次代理授权外推到其他任务。

合并前必须确认最新PR head、无冲突、必要检查通过、讨论已处理，并使用期望head SHA防止审查后移位。短期任务按项目约定squash；需保留本次基线的功能决策链时使用merge，并保持最终中文提交与有意义的正文。不得通过改合并方式绕过失败检查。

通过后记录PR URL、被审SHA、合并SHA和实际验证；verifier用`task verify`提交覆盖全部验收ID的结论，负责人再`task close`。若需求关联多个任务，全部关闭后才将需求标记delivered；缺陷按确认、修复、待回归、关闭的真实状态流转。运行状态以平台回读为准。

## 6. 遇阻、返工与维护

检查失败时保留命令、错误和来源，判断环境、实现或规范问题，禁止改测试来掩盖缺陷。发现平台流程缺口即记录需求或四要素缺陷，说明本轮手工边界和后续目标；不要将所有旁支问题塞进当前任务。返工需独立证据和重新审查。

PR或平台写入失败先回读状态，防止重复创建。任务执行后契约锁定时，新增范围建立后续任务。当前平台不会自动证明PR已合并或产物URL有效，负责人必须核验真实远端并保存证据。

worktree和本机运行证据保留到验收完成，不自动删除未推送或脏目录；后续回收须验证路径、所有者和Git状态。流程中的卡点应修订本规范、CLI/MCP指引及相关内置技能，保留修订历史。版本改变前重读规范，不能按旧引用覆盖并发编辑。


## 7. 审查失败后的独立返工

审查者用自己的verifier Run提交fail或inconclusive，保留失败命令、待审SHA和具体未满足的验收；任务进入failed后，由负责人重新assign。执行者先回读状态，再claim新的builder Run和独立worktree，不复用已completed的Run冒充新执行。

返工从远端待审HEAD或明确确认的修复基线取代码。若原任务分支仍被旧worktree占用，先确认该旧工作树干净、提交已推送且归本任务所有，再在旧树切换为detached HEAD以保留现场；随后在新树切回同一任务分支续写。禁止强制移动他人分支、删除旧现场或用force push替代正常续写。

新增修复提交前fetch并同步最新目标，重新检查差异和验证；正常push更新原PR，记录新的head。审查者按新head复核，旧测试结果只证明旧版本，不能改写成新版本结果。新范围超出原契约时新建有明确scope的后续任务；测试契约子PR可指向原修复分支，先完成其独立审查再集成。

实际执行测试的一方保留原始日志、退出码与确切源码/测试组合树。执行者只回读他人日志时，应注明由谁执行，不冒称亲自运行；源码独立树与联合测试树须分别表述。合并后可以核对tree哈希说明文件内容相同，但这不自动免除仓库对新提交要求的必需CI。

基线存在公共故障时，独立修复它并以正常merge同步到受影响分支，再重新运行组合检查；不能只反复重跑到偶然变绿。CI失败先取真实日志，区分实现错误、测试契约变化、资源竞争和基础设施中断。不要删除断言或降低权限、代数、状态等安全不变量。

## 附录：仓库副本与命令核对

以上规范正文来自平台文档 `N9DCMK3B17793W55MSCS` 第 2 修订，版本 1.1，读取日期为 2026-11-17；配套《Git 分支、提交与合并规范》为 `TY7YKEH2YHAYZ1B2HJ3X` 第 2 修订。更新本副本前先通过 `tsp docs show` 重读当前版本，不能用旧副本覆盖平台新修订。文中的本轮授权只记录对应会话事实，不授予其他任务推送、审批或合并权限。

仓库背景参见 [工作区与上下文](04-workspace-and-context.md) 和 [需求到交付流程](11-requirement-to-delivery-workflow.md)。本附录命令参数已与当前 CLI 的 `task status/claim/assign/submit/verify/close --help` 核对。示例中的任务码、Run、仓库路径、验收 ID、SHA 和 URL 必须替换为当前任务的真实值；示例不代表已经分派、测试、审批或合并。

### 领取与工作树定位

执行者先读任务和当前规范；随后在自己的私有目录领取，不在共享源码根目录领取或编辑。以下为 PowerShell 示例：

```powershell
tsp task status TASK_CODE
tsp docs show N9DCMK3B17793W55MSCS
tsp docs show TY7YKEH2YHAYZ1B2HJ3X

$privateRoot = 'C:/agent-runs/example'
New-Item -ItemType Directory -Force -Path $privateRoot
Set-Location -LiteralPath $privateRoot
$env:ACP_WORKSPACES_DIR = Join-Path $privateRoot 'workspaces'
tsp task claim TASK_CODE --profile builder --repo C:/work/project
```

claim 返回的 Workspace 目录包含 `.agent/project-state/brief.md` 等上下文；真实 Git 工作树在其 `repo/` 子目录。以返回值为准进入该目录，再建立符合任务类型的分支。例如本文档任务使用 `docs/TASK_CODE-workflow`。基线取自 `--repo` 的 HEAD，不能把未提交文件或仅存在于远端的提交当成 claim 基线。

### 提交与 PR 证据

最终提交前在自己的工作树检查状态、fetch，并集成任务指定目标。下面仅示范目标确认为 `main` 的情形；其他目标须按任务替换。若 merge 需要提交，应理解双方变更并使用中文 Conventional Commits 与必要 Lore trailers 完成，不能静默丢弃未提交工作。

```powershell
git status --short
git fetch origin --prune
git merge --no-commit origin/main
git diff --check
```

提交标题示例为 `docs(workflow): 让任务执行保留可审计的交付证据`。正文记录选择依据；`Constraint:`、`Rejected:`、`Directive:`、`Tested:`、`Not-tested:` 按真实情况填写，`Confidence: high`、`Scope-risk: narrow` 等枚举保持英文。检查器放行不代替中文规范或真实验证。

完成适用检查、提交并推送任务分支后创建 PR，回读远端 head 和目标分支。下面的 `pass` 只能用于实际自测通过时；验收 ID 应来自任务，不得照抄示例。

```powershell
tsp task submit TASK_CODE --run-code BUILDER_RUN `
  --artifact-kind commit --artifact-uri git:COMMIT_SHA --artifact-hash COMMIT_SHA `
  --evidence-type self_test --evidence-result pass --acceptance-refs "AC-1,AC-2" `
  --evidence-command "实际检查命令" `
  --evidence-summary "实际PR URL；待审SHA；结果、验证树和未覆盖范围"
tsp task status TASK_CODE
```

### 独立审查与关闭

独立审查者在自己的私有目录设置自己的 `ACP_WORKSPACES_DIR`，以 HEAD 已核实为待审提交的仓库建立独立 verifier Run。审查、CI、真实 GitHub 用户 Approval 和合并事实分别记录；Builder 不运行下面的 verify/close 步骤。当前 CLI 的关闭操作仅允许 Owner。

```powershell
tsp task claim TASK_CODE --profile verifier --repo C:/agent-runs/review-source
tsp task verify TASK_CODE --run-code VERIFIER_RUN --evidence-result pass `
  --acceptance-refs "AC-1,AC-2" --evidence-command "实际审查和验证命令" `
  --evidence-summary "实际PR URL；被审SHA；合并SHA；实际结果和边界"
tsp task status TASK_CODE
tsp task close TASK_CODE
tsp task status TASK_CODE
```

这些命令分别由有权执行的审查者和负责人完成，不能当作不经审查的连续成功脚本。失败或证据不足时记录 `fail` 或 `inconclusive`，按第 7 节重新分派并领取新 Run。仅回读他人日志时注明实际执行者和确切源码/测试树；不得把旧 SHA 或联合树的结果改写成本次独立树已通过。
