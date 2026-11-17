# M11 代码与资料接入、规则化需求生产：当前代码逆向需求与业务规则

从已绑定仓库、文本材料或明确code run准备候选，Agent读取原始证据形成规则/规格，平台审阅后才发布。所谓固定计划仅为批次版本与决策校验，不新增项目冻结步骤。

## 来源与事实级别

run NSG3TKRB16Y9F6Y203WB；snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；显式工作区草稿，基底提交 92728fbec04cfa34fee4421cb0a9319d1b755164。原始源码 manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；图 artifact SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8。UA 2.9.8 与 codegraph 1.6.2 为导航，Skill 2.2.0 提供逆向方法；事实证据均回查同一 snapshot 的原始文件。图谱解释仍为 inferred。

源码证据为 observed_in_code，只证明当前实现；未获业务批准。docs/experiments 只作全局比较材料，不作为本章新增业务能力的语义权威。

## 能力目录

- REQ-INT-M11-01：准备安全的仓库与文本资料采集包
- REQ-INT-M11-02：从已发布代码分析桥接原始固定快照
- REQ-INT-M11-03：形成可追溯模块、规则、验收与验证计划
- REQ-INT-M11-04：幂等提交并保护已发布项的来源
- REQ-INT-M11-05：逐项审阅并固定批次发布依据
- REQ-INT-M11-06：按固定依赖顺序逐项发布并保存局部结果
- REQ-INT-M11-07：区分运行中恢复与新尝试续传
- REQ-INT-M11-08：停止后续发布并保留来源映射与结果

## 业务规则表

|规则|触发与资格条件|结果/排序/执行约束|例外和保留事项|原始证据|测试断言|
|---|---|---|---|---|---|
|BR-INT-M11-01|在本机绑定项目的Agent或用户；intake prepare；有效平台身份、项目工作空间和明确来源；输出目录不覆盖材料目录。|BR-INT-M11-01：prepare只采集与导航，不生成已批准业务实体；材料正文不能作为Agent指令。；BR-INT-M11-01：来源种类决定assessment：真实源码观察、材料陈述和模型推断分别标记。；状态：仅本地新采集目录，无平台业务写入。|链接、敏感路径、二进制或超限来源→排除或失败并记录，不静默说已全量理解。；enterprise缺少完整档案和规格→候选可在草稿阶段检视质量问题，不能因此自动降档。|apps/cli/src/intake.ts:55–125 @ 5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a；apps/cli/src/intake-materials.ts:1–145 @ 2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70；apps/cli/src/intake-source.ts:1–90 @ c141b183d0e2e6befb182693bc8e1198daa92956efb2adaacb137009c15386db|REQ-INT-M11-01-AC01：prepare产出空候选和来源清单但不提交业务。；REQ-INT-M11-01-AC02：材料包含链接或输出目录覆盖材料时拒绝不安全采集。|
|BR-INT-M11-02|当前有项目权限的本机Agent；intake prepare --code-run RUN；run成功已发布，本机有同一run捕获的完整source与映射；使用固定run不是浮动view。|BR-INT-M11-02：UA/codegraph仅导航，代码事实从该run原始源码查证；知识JSON本身不升级为源码事实。；BR-INT-M11-02：不同分析run可共享稳定namespace/来源身份，但每份证据摘要必须匹配本次固定文件。；状态：只生成新本地采集包，旧run/source不改，项目默认view不改。|snapshot缺失/漂移、额外文件、映射重定向或知识材料漂移→在validate/submit/replace网络写入前拒绝；snapshot标记不能靠删除映射降级成普通来源。；并用include-untracked等不兼容选项→拒绝，因为快照文件集已固定。|apps/cli/src/intake-code-knowledge.ts:14–68 @ 274697e231e69c7286ea79379446c6f1b7e166d0e6a9ad8e6c03a08a29db682a；apps/cli/src/intake-materials.ts:146–169 @ 2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70；apps/cli/src/intake.ts:55–125 @ 5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a|REQ-INT-M11-02-AC01：当前HEAD不同也从明确run快照生成证据。；REQ-INT-M11-02-AC02：删除/修改映射不能把快照候选悄悄降级为当前仓库校验。|
|BR-INT-M11-03|读取采集包的当前Agent；依据固定Skill进行代码逆向并intake validate/export；先读AGENT、Skill、context和来源清单；原始源码作为不可信输入。|BR-INT-M11-03：完整规格与模块规则文档互相引用，来源hash与行号可复验；图谱缺边或分页裁剪不能证明能力不存在。；BR-INT-M11-03：每个验证场景独立声明角色、状态、时钟与外部结果；不能虚构已存在夹具或承诺候选已批准。；状态：本地候选/预览变化，不直接创建项目需求。|只有知识文档没有原始源码→只能documented/inferred，不能observed_in_code。；建议测试未实际执行→保留计划状态；现有测试代码只标defined，不据此声称passed。|apps/cli/src/intake-skill.ts:1–42 @ 920ed9ccb8b7a843ffe18389c9e304fb7b762f199b37320d798b45b501274009；packages/contracts/src/intake.ts:29–61 @ 1144bf8d893db668afebeba0022515b478f64f0442a6f3b134f92b19ef2048e1；apps/cli/src/intake-delivery.ts:1–80 @ b826bb07cb66659dce157c678f7f1a7af2ee1b6982c28bcd0d5634f020c1dda8|REQ-INT-M11-03-AC01：缺失AC对应验证计划的企业候选暴露质量问题。；REQ-INT-M11-03-AC02：导出完整候选保持BR与REQ/AC可追踪。|
|BR-INT-M11-04|具有当前项目write权限的提交者；管理者可管理批次；intake submit/replace 与批次 POST/PUT；来源本机校验通过，包的project/repository/namespace与批次一致。|BR-INT-M11-04：已成功项存在时其内容及整个source不可变；尚无completed行不触发这项保护，替换可更新允许的来源内容。；BR-INT-M11-04：legacy pilot回放兼容旧无profile哈希，不覆盖之后明确确认的enterprise档位。；状态：新批次draft revision1；成功replace revision+1、draft、清空plan/frozen质量依据，保留completed行。|成员替换他人或已审阅批次→拒绝；管理者仍受已发布项保护。；enterprise降为pilot、改变来源归属或已成功项→拒绝。|packages/application/src/intake-use-cases.ts:182–235 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；apps/core-api/src/routes/intake.ts:19–38 @ 316f974a008a9c75019d8b2a1ea671070e0eaeb6cb19e3edbee33b155dc0b623|REQ-INT-M11-04-AC01：同key同包重试只返回原批次。；REQ-INT-M11-04-AC02：有成功项的替换不能修改来源。|
|BR-INT-M11-05|当前项目Owner/Admin；Web review / POST intake/:code/review；批次非applying、applied、cancelled；base_revision匹配。|BR-INT-M11-05：固定的是本批次来源、质量和逐项决策，不冻结项目开发或源码。；BR-INT-M11-05：已completed行不能改变决策；历史无档位批次须显式选择后形成新依据。；状态：成功draft/partial/stopped等→ready，revision+1、plan_hash和frozen质量依据持久化。|enterprise blocker>0→拒绝ready，返回可定位质量报告；不能降档绕过。；已有来源映射→非skip项必须显式bind同一目标；skip仍允许。；父项skip而子项新增/绑定→拒绝不完整计划。|packages/application/src/intake-use-cases.ts:237–277 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9|REQ-INT-M11-05-AC01：已映射来源可以显式跳过，而非强制绑定。；REQ-INT-M11-05-AC02：enterprise结构阻断不能被审阅忽略。|
|BR-INT-M11-06|当前项目Owner/Admin；intake apply 已审阅plan；当前管理权、ready/partial/stopped可新建尝试，plan_hash与质量依据仍匹配。|BR-INT-M11-06：发布不是整批全有全无；单项savepoint失败不回滚此前成功，且不自动停止独立后项。；BR-INT-M11-06：预检拒绝、全局授权/固定依据失效、项内映射漂移分别按发生位置决定作用范围；不能统一描述为停止全部发布。；BR-INT-M11-06：bind只建立/确认映射，不用候选正文覆盖既有目标。；状态：新尝试applying后，逐项保存applied/bound/failed/blocked与收据；所有pending处理完时attempt completed，批次按失败/阻塞为partial或applied。；全局失败清理与项内失败不同；仅项内失败本身不设置stop_requested，已提交目标保留。|新attempt提交前发现映射或目标指纹漂移→预检拒绝，不创建该次attempt，也不进入逐项写入。；逐项savepoint之外发现当前管理权、批次计划/固定质量依据失效→异常退出后续处理；捕获到的durable running attempt由外层清理为stopped，批次按成功数partial或stopped；保留此前提交。；applyNext的item savepoint内发现source binding或bind target/fingerprint漂移等非重试性DomainError→该项failed并写结果；applyNext继续，独立pending项可成功，依赖该失败项的后项blocked，最终可partial/completed。；可重试busy/serialization/deadlock类基础设施错误→向外抛出走有界重试与原key恢复路径，不能当作普通单项失败或保证已全局停止。|packages/application/src/intake-use-cases.ts:299–358 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:376–464 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:325–336 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:405–419 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:453–463 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9|REQ-INT-M11-06-AC01：后项失败只回滚自身并保留前项成功。；REQ-INT-M11-06-AC02：绑定既有目标不覆盖正文。；REQ-INT-M11-06-AC03：预检通过后的项内绑定目标漂移使该项failed，独立后项仍继续且失败依赖blocked。；REQ-INT-M11-06-AC04：同样漂移若在新attempt预检之前发生则拒绝该次开始。|
|BR-INT-M11-07|当前仍有管理权的原操作者；apply重试/恢复；相同key必须对应同一principal与plan；网络重试并不代替授权。|BR-INT-M11-07：执行状态、请求身份与冻结依据决定是否恢复，不能把所有重试解释成重新发布全部项。；BR-INT-M11-07：历史兼容路径不等于所有旧运行都有现行企业质量门禁。；状态：恢复只处理pending；新尝试将failed/blocked重置pending，成功项保留。|相同key不同操作者或plan→冲突。；有界busy/serialization/deadlock重试耗尽→保留已经提交结果，提示原key重试；可能保留running而非一律stopped。；初始权限检查在attemptId捕获前失败→不声称旧running尝试一定被自动停止。|packages/application/src/intake-use-cases.ts:299–373 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:147–156 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:376–390 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9|REQ-INT-M11-07-AC01：停止attempt的同key回放不继续，新key才可续传。；REQ-INT-M11-07-AC02：attempt提交后发生material busy时保留可恢复事实。|
|BR-INT-M11-08|草稿创建者或当前项目管理者；intake stop/list/preview/result及API读取；读需当前项目访问且拒绝Viewer；stop需write，已审阅计划只允许管理者；base_revision匹配。|BR-INT-M11-08：stop不是回滚；source mapping与已提交真实资料保留。；BR-INT-M11-08：变更namespace产生新来源身份，旧映射不会自动接管；读/写/管理权限分别判断。；状态：stop revision+1（applied no-op除外）；attempt running→stopped；先前成功不撤销。|无当前权限或旧revision→拒绝。；重复stop零成功cancelled→现实现可能再变stopped，不能承诺所有stop状态完全幂等。|packages/application/src/intake-use-cases.ts:72–83 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:158–181 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；packages/application/src/intake-use-cases.ts:281–296 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9；apps/cli/src/intake.ts:170–194 @ 5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a|REQ-INT-M11-08-AC01：部分成功批次停止保留目标和收据。；REQ-INT-M11-08-AC02：普通提交者只能停止本人尚无计划草稿。|

## BR → REQ / AC / 验证矩阵

|BR|REQ|Feature|AC|计划状态|
|---|---|---|---|---|
|BR-INT-M11-01|REQ-INT-M11-01|tsp-feature-intake-capture|REQ-INT-M11-01-AC01|not_run，未来计划|
|BR-INT-M11-01|REQ-INT-M11-01|tsp-feature-intake-capture|REQ-INT-M11-01-AC02|not_run，未来计划|
|BR-INT-M11-02|REQ-INT-M11-02|tsp-feature-intake-capture|REQ-INT-M11-02-AC01|not_run，未来计划|
|BR-INT-M11-02|REQ-INT-M11-02|tsp-feature-intake-capture|REQ-INT-M11-02-AC02|not_run，未来计划|
|BR-INT-M11-03|REQ-INT-M11-03|tsp-feature-intake-capture|REQ-INT-M11-03-AC01|not_run，未来计划|
|BR-INT-M11-03|REQ-INT-M11-03|tsp-feature-intake-capture|REQ-INT-M11-03-AC02|not_run，未来计划|
|BR-INT-M11-04|REQ-INT-M11-04|tsp-feature-intake-review|REQ-INT-M11-04-AC01|not_run，未来计划|
|BR-INT-M11-04|REQ-INT-M11-04|tsp-feature-intake-review|REQ-INT-M11-04-AC02|not_run，未来计划|
|BR-INT-M11-05|REQ-INT-M11-05|tsp-feature-intake-review|REQ-INT-M11-05-AC01|not_run，未来计划|
|BR-INT-M11-05|REQ-INT-M11-05|tsp-feature-intake-review|REQ-INT-M11-05-AC02|not_run，未来计划|
|BR-INT-M11-06|REQ-INT-M11-06|tsp-feature-intake-review|REQ-INT-M11-06-AC01|not_run，未来计划|
|BR-INT-M11-06|REQ-INT-M11-06|tsp-feature-intake-review|REQ-INT-M11-06-AC02|not_run，未来计划|
|BR-INT-M11-06|REQ-INT-M11-06|tsp-feature-intake-review|REQ-INT-M11-06-AC03|not_run，未来计划|
|BR-INT-M11-06|REQ-INT-M11-06|tsp-feature-intake-review|REQ-INT-M11-06-AC04|not_run，未来计划|
|BR-INT-M11-07|REQ-INT-M11-07|tsp-feature-intake-review|REQ-INT-M11-07-AC01|not_run，未来计划|
|BR-INT-M11-07|REQ-INT-M11-07|tsp-feature-intake-review|REQ-INT-M11-07-AC02|not_run，未来计划|
|BR-INT-M11-08|REQ-INT-M11-08|tsp-feature-intake-review|REQ-INT-M11-08-AC01|not_run，未来计划|
|BR-INT-M11-08|REQ-INT-M11-08|tsp-feature-intake-review|REQ-INT-M11-08-AC02|not_run，未来计划|

详细结构化REQ/AC/计划在同模块需求条目与本地章节；均未执行，不构成批准或安全证明。
