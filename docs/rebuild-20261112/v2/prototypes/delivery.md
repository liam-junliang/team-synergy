# 交付工作台原型 · 屏幕、状态与验收

[打开交付工作台](delivery.html)。从顶部任选设备交接、任务验收、缺陷回归三个演练起点。展开一项操作，选中目标屏幕即可继续。键盘可用 Tab 聚焦操作，Enter 展开，再用 Tab 和空格选中目标状态。每屏的“操作条件与依据”可展开查阅角色约束与对应功能号。

示例项目为订单平台。林澈和宋宁是不同的执行成员，周岚是项目管理员，汪宁在相应场景持有验证或测试所需权限。TASK、RUN、ATT 和 EXEC 短编号为虚构展示值；项目中的真实设备、工作区、报告或记录不受原型操作影响。屏幕展示给定角色操作前后的数据，跨角色意味着交接给另一位操作者。

## 三条完整演练

1. **设备交接**。林澈准备快照并确认停止，周岚发布，宋宁接收并在设备 B 恢复。正常资料可从就绪直接激活；模拟指南更新后，周岚说明理由批准沿用已冻结的旧版，宋宁再次就绪并激活。并列分支可查看设备不一致、契约变化、取消及原执行人显式恢复。
2. **任务验收**。宋宁提交产物和自测，汪宁使用独立验证 Run，周岚确认关闭。尝试漏一个验收项通过应留下 submitted；验证失败进入 failed，允许重新分派，执行人要再次领取。
3. **测试与缺陷**。汪宁从固定用例版本的一次 fail 结果新建或关联缺陷。周岚分诊并建立修复任务，任务仅 submitted 时申请回归应失败；至少一条关联修复任务 verified 后方可入 retest。回归通过关闭，失败回到分诊。

## 屏幕与角色验收

片段 ID 可用于独立 HTML 的直达地址。平台 srcdoc 预览使用原生详情控件和单选操作切换，避免相对片段被解析到外层页面。每行以该屏的预置数据开始，目标列列出可实际点击的后继状态。条件或拒绝决定见展开说明和相应功能条目。

### 设备交接与恢复

| 屏幕 / 角色 | 显示字段与当前条件 | 操作与可观察的后继状态 | 验收依据 |
| --- | --- | --- | --- |
| [准备交出任务](delivery.html#h-start) · `h-start`<br>执行人 · 林澈 | **running** · 交接前核对。任务：TASK-31 · 导出失败保留诊断记录；源 Run：RUN-A · active；接手设备：宋宁 · 设备 B | 准备交接 → `h-prepared`。提交准备请求只会先暂停源 Run。管理者发布后，宋宁才能阅读交接包。 | M08-F05<br>`packages/application/src/handover-use-cases.ts:301-340` |
| [确认源执行已停止](delivery.html#h-prepared) · `h-prepared`<br>执行人 · 林澈 | **preparing** · 等待停止确认。源 Run：RUN-A · suspended；代码清单：导出服务 · 固定 commit、tree；停止回执：待确认 · 托管进程 | 提交快照与停止回执 → `h-package`；查看缺少回执时的发布结果 → `h-noack`。准备阶段的交接包只对源执行者及项目管理者可读。收到停止确认前，发布会被拦截。 | M08-F05、M08-F06<br>`packages/application/src/handover-use-cases.ts:343-375` |
| [缺少源停止回执](delivery.html#h-noack) · `h-noack`<br>项目管理员 · 周岚 | **preparing** · 发布被拦截。错误：handover_not_ready；源 Run：RUN-A · suspended；交接包：未发布 | 回到源执行人 → `h-prepared`；取消这次交接 → `h-cancel`。让源执行者从准备设备补交停止确认；管理者的发布操作不能代替 A 的回执。 | M08-F06、M08-F07、M08-F11<br>`packages/application/src/handover-use-cases.ts:539-562` |
| [审核交接包](delivery.html#h-package) · `h-package`<br>项目管理员 · 周岚 | **preparing** · 可发布。接手人：宋宁 · 当前项目成员；需求基线：REQ-17 r3 · 固定正文；停止回执：源设备 A · 已确认 | 发布交接包 → `h-published`；取消交接 → `h-cancel`。发布时还会核对接手人的写权限及资料漂移。已停机和已发布是两个独立状态。 | M08-F06、M08-F07<br>`packages/application/src/handover-use-cases.ts:515-529` |
| [接收固定的交接包](delivery.html#h-published) · `h-published`<br>接手人 · 宋宁 | **published** · 待接收。源作者：林澈 · RUN-A；固定资料：REQ-17 r3 · 项目指南 r8；工作摘要：导出重试逻辑已改动，待验证空记录回执 | 接收交接 → `h-accepted`；取消交接 → `h-cancel`。接收确认你愿意接手；变更负责人须等到恢复、就绪和激活均成功。 | M08-F07<br>`packages/application/src/handover-use-cases.ts:515-529` |
| [在设备 B 恢复工作区](delivery.html#h-accepted) · `h-accepted`<br>接手人 · 宋宁 | **accepted** · 待恢复。目标目录：交接专用的独立 worktree；尝试编号：本次示例 ATT-B；所需上下文：固定资料、任务契约、技能版本和代码快照 | 恢复到独立目录 → `h-restoring`；查看异设备回执 → `h-wrong-device`。首次恢复登记 preparing 的目标 Run。已登记后若本机步骤失败，用相同请求键恢复同一次尝试。 | M08-F08<br>`packages/integrations/src/handover-workspace.ts:115-162` |
| [核对恢复回执](delivery.html#h-restoring) · `h-restoring`<br>接手人 · 宋宁 | **restoring** · 待就绪。目标 Run：RUN-B · preparing；设备 / 尝试：设备 B · ATT-B；上下文检查：代码 commit、工作区摘要、上下文哈希均匹配 | 提交就绪回执 → `h-ready`；改用第二台设备提交 → `h-wrong-device`。就绪只记录客户端对本次恢复的确认。此时源 Run 仍 suspended，目标不能续写任务。 | M08-F08、M08-F09<br>`packages/integrations/src/handover-workspace.ts:115-136` |
| [设备与恢复尝试不匹配](delivery.html#h-wrong-device) · `h-wrong-device`<br>接手人 · 宋宁 | **restoring** · 回执被拒绝。错误：handover_receipt_invalid；当前设备：设备 C；绑定设备：设备 B · ATT-B | 回到设备 B → `h-restoring`。切回绑定设备并核对原尝试、commit 和上下文哈希后再提交。 | M08-F08、M08-F09<br>`packages/integrations/src/handover-workspace.ts:115-136` |
| [激活前最终确认](delivery.html#h-ready) · `h-ready`<br>接手人 · 宋宁 | **ready** · 就绪已确认。源 / 目标：RUN-A suspended / RUN-B preparing；当前负责人：林澈；准备交付：交接基线 REQ-17 r3、指南 r8 | 激活目标 Run → `h-active`；指南更新后尝试激活 → `h-drift`；任务契约变更后尝试激活 → `h-contract`。激活会再核对来源、当前成员与设备、回执和两端 Run 状态。 | M08-F09、M08-F10<br>`apps/web/src/HandoverPanel.tsx:157-183` |
| [审阅来源变化](delivery.html#h-drift) · `h-drift`<br>项目管理员 · 周岚 | **ready** · 激活受阻。错误：context_source_changed；冻结 / 当前：项目指南 r8 → r9；示例批准理由：r9 仅调整排版，经逐项核对，本次交接继续采用 r8 | 以示例理由批准沿用 r8 → `h-approved`；取消并重新准备 → `h-cancel`。批准只覆盖本次实际审过的版本，写入理由和版本向量；原先就绪的交接会返回恢复中。 | M08-F10<br>`apps/web/src/HandoverPanel.tsx:157-183` |
| [任务契约变更需要重新准备](delivery.html#h-contract) · `h-contract`<br>项目管理员 · 周岚 | **ready** · 不能豁免。错误：context_contract_changed；冲突来源：任务契约；旧回执：不足以激活 | 取消旧交接 → `h-cancel`。取消原交接，源执行人明确恢复后再按当前契约准备。这里展示守卫对变更的处理，正常任务编辑入口另有状态限制。 | M08-F10、M08-F11<br>`packages/application/src/handover-use-cases.ts:539-562` |
| [接手人重新确认原快照](delivery.html#h-approved) · `h-approved`<br>接手人 · 宋宁 | **restoring** · 需重新就绪。批准理由：排版变更已审阅，继续使用 r8；就绪回执：已清除；目标设备：设备 B · ATT-B | 重新提交就绪回执 → `h-approved-ready`。同一设备重新确认原快照。后续资料若再次改变，批准不会自动涵盖新版本。 | M08-F09、M08-F10<br>`apps/web/src/HandoverPanel.tsx:157-183` |
| [按批准范围激活](delivery.html#h-approved-ready) · `h-approved-ready`<br>接手人 · 宋宁 | **ready** · 已重新就绪。冻结文件：指南 r8；已审阅版本：指南 r9；新回执：设备 B · ATT-B | 激活目标 Run → `h-active`。激活事务同时更新两个 Run、任务负责人及执行代数。 | M08-F09、M08-F10<br>`apps/web/src/HandoverPanel.tsx:157-183` |
| [交接完成](delivery.html#h-active) · `h-active`<br>接手人 · 宋宁 | **completed** · 可以续写。源 Run：RUN-A · transferred；目标 Run：RUN-B · active；租约 / 负责人：设备 B · 新执行代数 · 宋宁 | 继续提交与验证 → `t-building`；重新查看交接 → `h-start`。此后提交产物应使用 B 的 Run。原 Run 或旧租约不能替代该身份提交。 | M08-F09、M07-F07<br>`packages/application/src/task-service.ts:885-955` |
| [交接已取消，源 Run 仍暂停](delivery.html#h-cancel) · `h-cancel`<br>执行人 · 林澈 | **cancelled** · 等待显式恢复。源 Run：RUN-A · suspended；准备授权：已失效；恢复前提：原负责人、有效设备、无待处理交接 | 恢复源 Run → `h-resumed`。包过期时源 Run 同样保持暂停。恢复由原负责人通过本人设备显式办理。 | M08-F11<br>`packages/application/src/handover-use-cases.ts:539-562` |
| [源执行者已恢复](delivery.html#h-resumed) · `h-resumed`<br>执行人 · 林澈 | **active** · 源 Run 恢复。当前负责人：林澈；源 Run：RUN-A · active；旧交接：保留取消记录 | 重新准备交接 → `h-start`。恢复不会把已取消包重新发布。 | M08-F11<br>`packages/application/src/handover-use-cases.ts:539-562` |

### 执行、验证与返工

| 屏幕 / 角色 | 显示字段与当前条件 | 操作与可观察的后继状态 | 验收依据 |
| --- | --- | --- | --- |
| [提交产物和自测证据](delivery.html#t-building) · `t-building`<br>执行人 · 宋宁 | **running** · 准备提交。任务 / Run：TASK-31 · RUN-B；提交产物：commit · 已登记内容摘要；自测：self_test / pass · AC-1 | 提交产物与自测 → `t-submitted`。提交必须引用已知验收项，可以先覆盖部分条件；下一步的 verifier 通过必须覆盖全部条件。 | M07-F07<br>`packages/application/src/task-service.ts:885-955` |
| [独立验证提交](delivery.html#t-submitted) · `t-submitted`<br>验证成员 · 汪宁 | **submitted** · 等待验证结论。执行 / 验证：RUN-B completed / RUN-V active；完整覆盖：AC-1 与 AC-2；验证证据类型：verifier_review | 提交全覆盖通过证据 → `t-verified`；尝试只验证 AC-1 后通过 → `t-partial`；记录验证失败 → `t-rework`。两项全部通过才能标记 verified。提交 fail 或 inconclusive 时原任务进入 failed，供管理者重派。 | M07-F08<br>`packages/application/src/project-use-cases.ts:633-694` |
| [验证覆盖不完整](delivery.html#t-partial) · `t-partial`<br>验证成员 · 汪宁 | **submitted** · 验证被拒绝。错误：acceptance_coverage_incomplete；已覆盖：AC-1；待覆盖：AC-2 | 返回验证证据 → `t-submitted`。补全验收引用后可以重新提交，不应直接关闭。 | M07-F08<br>`packages/application/src/project-use-cases.ts:633-694` |
| [管理者重新分派返工](delivery.html#t-rework) · `t-rework`<br>项目管理员 · 周岚 | **failed** · 待重新分派。验证结论：fail / verifier_review；原产物：保留既有 Run、提交与证据；重入条件：最新任务序号、有效负责人、验收标准 | 重新分派给宋宁 → `t-reassigned`。重新分派得到 assigned，之后执行者重新领取才会创建新的活动 Run。 | M07-F05、M07-F08<br>`packages/application/src/project-use-cases.ts:633-694` |
| [已重新分派](delivery.html#t-reassigned) · `t-reassigned`<br>执行人 · 宋宁 | **assigned** · 待领取。任务：TASK-31 · assigned；历史 Run：原失败验证保留；负责人：宋宁 | 重看首轮提交 → `t-building`。再领取会获得另一编号的新 Run，以下导航可重看首轮示例。 | M07-F05、M07-F06<br>`packages/application/src/task-service.ts:478-565` |
| [确认任务交付](delivery.html#t-verified) · `t-verified`<br>项目管理员 · 周岚 | **verified** · 可以关闭。任务：TASK-31 · verified；证据：verifier_review / pass；Feature：订单导出 · active | 关闭任务 → `t-closed`。样例中同 Feature 的其他任务都已关闭或取消。 | M07-F09<br>`packages/application/src/task-service.ts:502-514` |
| [任务已关闭](delivery.html#t-closed) · `t-closed`<br>项目管理员 · 周岚 | **closed** · 已交付。任务：TASK-31 · closed；Feature：订单导出 · delivered；可追溯内容：Run、产物、自测、验证及关闭审计 | 重看任务验收 → `t-building`；查看缺陷回归 → `q-failed`。关闭任务和关闭缺陷有不同入口和状态条件。 | M07-F09<br>`packages/application/src/task-service.ts:502-514` |

### 测试结果与缺陷回归

| 屏幕 / 角色 | 显示字段与当前条件 | 操作与可观察的后继状态 | 验收依据 |
| --- | --- | --- | --- |
| [从失败结果发起修复](delivery.html#q-failed) · `q-failed`<br>测试成员 · 汪宁 | **fail** · 未关联缺陷。执行记录：EXEC-12 · 预发布 / build-42；固定用例：CASE-06 r2 · 资料 DATA-04 r1；实际 / 预期：无诊断条目 / 应写入一条失败原因 | 新建缺陷并关联 → `q-reported`；关联已有同项目缺陷 → `q-existing`；查看通过结果的限制 → `q-pass`。选择“新建”将使用执行快照拼接复现步骤、环境、实际结果及报告；已有同项目缺陷可直接关联。 | M09-F04、M09-F05、M09-F06<br>`packages/application/src/testing-use-cases.ts:266-306` |
| [通过结果只读](delivery.html#q-pass) · `q-pass`<br>测试成员 · 汪宁 | **pass** · 不可关联缺陷。执行记录：EXEC-12；用例：CASE-02 r1；结果：pass | 返回失败项 → `q-failed`。若另有独立发现，可通过缺陷工作台直接报告。返回失败项可继续本次演练。 | M09-F06、M09-F07<br>`packages/application/src/project-access.ts:22-26` |
| [分诊新报告的缺陷](delivery.html#q-reported) · `q-reported`<br>项目管理员 · 周岚 | **reported** · 待分诊。缺陷：DEF-18 · medium；关联执行：EXEC-12 / CASE-06 r2；发现版本：build-42 | 确认进入分诊 → `q-triaged`；拒绝此报告 → `q-rejected`。管理者决定是否接受修复。已关联结果不可随意改绑另一项。 | M09-F06、M09-F07<br>`packages/application/src/project-access.ts:22-26` |
| [已关联既有缺陷](delivery.html#q-existing) · `q-existing`<br>测试成员 · 汪宁 | **fail** · 关联已保存。关联缺陷：DEF-18 · triaged；测试结果：仍为 fail；再次绑定：同编号重试可用，改绑会冲突 | 打开已分诊的缺陷 → `q-triaged`。进入既有缺陷的处置队列即可安排修复，不重复建单。 | M09-F06<br>`packages/application/src/testing-use-cases.ts:266-306` |
| [建立并指定修复任务](delivery.html#q-triaged) · `q-triaged`<br>项目管理员 · 周岚 | **triaged** · 待安排修复。修复任务：FIX-09 · 来源 defect-fix；验收条件：空集的导出失败写入诊断记录；归属：订单导出 / DEF-18 | 创建合规任务并转修复中 → `q-fixing`。创建任务和变更缺陷状态是两次写入；中途失败应核对现有任务后重试。 | M09-F08、M07-F01<br>`packages/application/src/project-use-cases.ts:484-531` |
| [回归前核对修复状态](delivery.html#q-fixing) · `q-fixing`<br>测试成员 · 汪宁 | **fixing** · 修复已提交。修复任务：FIX-09 · submitted；自测：self_test / pass；缺陷：DEF-18 · fixing | 立即申请回归 → `q-blocked`；查看任务验证完成后的状态 → `q-verified`。此时申请回归仍会被拦截。可查看 verifier 完成 M07 验证后的路径。 | M09-F08、M07-F08<br>`packages/application/src/project-use-cases.ts:633-694` |
| [修复未验证，回归被阻止](delivery.html#q-blocked) · `q-blocked`<br>测试成员 · 汪宁 | **fixing** · 暂不能回归。错误：fix_task_not_completed；修复任务：FIX-09 · submitted；下一操作人：有写权限的 verifier Run 持有人 | 查看修复已验证的样例 → `q-verified`。修复任务应走独立验证。此处切换到已完成验证的样例，再检验回归门槛。 | M09-F08、M07-F08<br>`packages/application/src/project-use-cases.ts:633-694` |
| [修复已经验证](delivery.html#q-verified) · `q-verified`<br>测试成员 · 汪宁 | **fixing** · 可以进入回归。修复任务：FIX-09 · verified；验证证据：verifier_review / pass；缺陷：DEF-18 · fixing | 进入回归 → `q-retest`。验证任务不会自动改变缺陷。需要有写权限的成员显式申请回归。 | M09-F08、M07-F08<br>`packages/application/src/project-use-cases.ts:633-694` |
| [作出回归结论](delivery.html#q-retest) · `q-retest`<br>项目管理员 · 周岚 | **retest** · 待管理者处置。被测版本：build-43；关联修复：FIX-09 · verified；可选决定：关闭 / 回到分诊 | 回归通过，关闭缺陷 → `q-closed`；回归失败，回到分诊 → `q-reopened`。服务要求管理权限和合法状态；不会用一条测试执行自动替管理者关闭。 | M09-F09<br>`apps/web/src/DefectsWorkbench.tsx:273-317` |
| [缺陷已关闭](delivery.html#q-closed) · `q-closed`<br>项目管理员 · 周岚 | **closed** · 终态。失败执行：EXEC-12 · 保留；修复任务：FIX-09 · verified；缺陷：DEF-18 · closed | 重看测试路径 → `q-failed`。该终态不再提供流转操作。 | M09-F09<br>`apps/web/src/DefectsWorkbench.tsx:273-317` |
| [缺陷重新进入分诊](delivery.html#q-reopened) · `q-reopened`<br>项目管理员 · 周岚 | **triaged** · 需要新一轮修复。缺陷：DEF-18 · triaged；当前动作：重新安排修复；既有证据：原结果和修复记录可追溯 | 安排下一轮修复 → `q-triaged`。重开是 retest → triaged，不能从已经 closed 的终态直接重开。 | M09-F09<br>`apps/web/src/DefectsWorkbench.tsx:273-317` |
| [报告已拒绝](delivery.html#q-rejected) · `q-rejected`<br>项目管理员 · 周岚 | **rejected** · 终态。缺陷：DEF-18 · rejected；失败结果：EXEC-12 中的 fail 保留；审计：记录拒绝人和变化 | 重看测试路径 → `q-failed`。如要复查，读取历史报告，不对该终态重复分诊。 | M09-F07、M09-F09<br>`apps/web/src/DefectsWorkbench.tsx:273-317` |

## 对照源码和交互的边界

2026-11-12 使用本机 Edge 和 Playwright，在有项目路径的父页面中，以 `<iframe sandbox="" srcdoc="…">` 实际操作了 35 个屏幕中的 53 条动作分支。每次确认目标后，检查只有预期状态可见。另检查了 Enter、Tab、空格完成一次交接步骤，独立文件以 `#q-retest` 直达，以及 360 像素宽下无水平溢出。该记录验证原型交互；模块说明中的数据库、设备和业务测试仍按各文所标的测试定义阅读。

- 现有产品入口分布在项目任务详情、CLI、交接工作台和测试/缺陷工作台。本原型把跨设备或跨角色操作排成可走查的示例；“查看任务验证完成后的状态”等按钮切换前置情境。该按钮没有把测试成员提升为 verifier。
- 冻结内容、摘要、回执、批准理由以及两个不同版本号以固定样例示意。服务端在真实操作中核验身份、权限、版本与并发条件。错误状态以可见拒绝和可行的下一步演示，未实现联网、进程启动、数据库写入、加密摘要计算或输入持久化。
- 任务关闭、缺陷关闭与交接完成是三种独立的结果。真实接口和更完整的前置条件分别列在 [M07 任务与执行证据](../modules/M07-task.md)、[M08 本地运行与交接](../modules/M08-run-handover.md)、[M09 测试与缺陷](../modules/M09-quality-defect.md)。

