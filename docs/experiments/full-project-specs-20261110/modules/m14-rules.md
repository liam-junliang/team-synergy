# M14 项目代码理解与插件知识：当前代码逆向需求与业务规则

统一CLI调用本机UA/codegraph、当前Agent解释，Web原生UA阅读并定位代码证据；按快照/插件锁追溯。设计上完整快照留本机、服务端保存图与限额片段；现有严格字段/已知模式/可选UA精确hash筛查有限，未证明任意自由文本不含私密语义。发布和选择项目视图分开。

## 来源与事实级别

run NSG3TKRB16Y9F6Y203WB；snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；显式工作区草稿，基底提交 92728fbec04cfa34fee4421cb0a9319d1b755164。原始源码 manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；图 artifact SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8。UA 2.9.8 与 codegraph 1.6.2 为导航，Skill 2.2.0 提供逆向方法；事实证据均回查同一 snapshot 的原始文件。图谱解释仍为 inferred。

源码证据为 observed_in_code，只证明当前实现；未获业务批准。docs/experiments 只作全局比较材料，不作为本章新增业务能力的语义权威。

## 能力目录

- REQ-INT-M14-01：注册旁路插件并锁定兼容版本和摘要
- REQ-INT-M14-02：捕获提交快照与显式草稿快照
- REQ-INT-M14-03：以创建者和版本控制分析生命周期及检查点
- REQ-INT-M14-04：发布经结构与证据预算验证的图产物
- REQ-INT-M14-05：组合多仓库不可变视图并分离草稿与提交指针
- REQ-INT-M14-06：统一CLI查询整体关系与原生代码符号
- REQ-INT-M14-07：以原生UA阅读整体关系并定位codegraph证据
- REQ-INT-M14-08：保留文档导出与原始源码桥接的可信度边界

## 业务规则表

|规则|触发与资格条件|结果/排序/执行约束|例外和保留事项|原始证据|测试断言|
|---|---|---|---|---|---|
|BR-INT-M14-01|本机Agent或工作空间用户；code plugins list/doctor/register 与分析prepare；本机安装UA/codegraph及需要的runtime；登记路径在本机配置中，不能将其当源码上传。|BR-INT-M14-01：当前adapter明确支持UA2.9.8/codegraph1.6.2，插件式并不等于任意上游版本即刻兼容。；BR-INT-M14-01：更新通过兼容检查和新run接入，避免旧分析身份含糊。；状态：本机registry更新；分析持久记录固定plugin locks，项目源码不变。|版本不受支持、文件/依赖/runtime摘要漂移→拒绝执行，不能静默换新版本继续旧run。；插件升级→另行注册兼容版本并新建分析，旧run继续保留旧锁。|apps/cli/src/code-understanding-plugins.ts:90–154 @ 71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1；apps/cli/src/code-understanding.ts:101–128 @ d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4|REQ-INT-M14-01-AC01：运行后插件字节漂移阻止继续旧run。；REQ-INT-M14-01-AC02：不支持版本不能被标为已兼容。|
|BR-INT-M14-02|有项目write权限并拥有绑定workspace的当前用户；code analyze prepare [--workspace-draft --include-untracked]；真实Git仓库与当前项目repository绑定；默认提交快照，草稿需显式。|BR-INT-M14-02：branch名是浮动标签，真正版本由commit或draft内容manifest/snapshot定义。；BR-INT-M14-02：草稿与提交分析分离，EOL字节变化必须新摘要，不沿用旧证据hash。；状态：本机只读捕获后创建不可变source缓存；不git commit、reset或修改用户源码。|快照漂移/链接/文件超2MiB、总量超128MiB→拒绝或记录排除，不能混入浮动checkout。；未显式include-untracked→不把所有新文件自动视为已捕获。|apps/cli/src/code-understanding-snapshot.ts:26–112 @ 4699f4308d3e615009be35781c8b52029569dc2f73371d9c490ff639dc2980e9；apps/cli/src/code-understanding.ts:130–164 @ d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4|REQ-INT-M14-02-AC01：默认提交快照不误取本机未提交正文。；REQ-INT-M14-02-AC02：复验拒绝快照额外文件与目录链接。|
|BR-INT-M14-03|run创建者；其他项目协作者只有相应读取/视图权；code analyze prepare/checkpoint/resume/status/cancel 与progress API；当前有效projectwrite；repository active且workspace属于当前principal。|BR-INT-M14-03：没有项目冻结状态；awaiting_agent是分析批次等待解释，不阻止项目开发。；BR-INT-M14-03：已提交进度精确重试可返回，修改内容不能冒用相同版本。；BR-INT-M14-03：非终态允许前向跳转，除preparing/failed/cancelled外推进必须已有或提交snapshot；状态序列不是严格逐阶段工作流。；状态：注册保存preparing；实际enum为preparing/indexing/awaiting_agent/validating/uploading/succeeded/failed/cancelled。扫描/注册是操作说明，不是registered/scanning持久状态。；progress按顺序禁止向后，满足snapshot与revision条件时可跳过中间非终态；不保证每个阶段都经过。成功由publish写succeeded，failed/cancelled为终态。|非创建者推进/发布→拒绝，即使同项目管理者可读也不取得创建者角色。；取消后迟到完成→拒绝发布；旧revision冲突不覆盖其他检查点。|packages/application/src/code-understanding-use-cases.ts:105–145 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；apps/cli/src/code-understanding.ts:56–76 @ d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4；apps/cli/src/code-understanding.ts:130–205 @ d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4；packages/contracts/src/code-understanding.ts:41–44 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696；packages/application/src/code-understanding-use-cases.ts:119–136 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628|REQ-INT-M14-03-AC01：相同注册输入回放同run，不同输入同key冲突。；REQ-INT-M14-03-AC02：协作者不能推进或发布他人run。；REQ-INT-M14-03-AC03：注册为preparing，合法前向跳过中间态可接受，向后推进拒绝。|
|BR-INT-M14-04|run创建者且当前仍有write权限；code analyze validate/publish 与publish API；快照、插件及本机产物验证通过；完整UA解释与图关系合法。|BR-INT-M14-04：每个含snippet证据最多1200字符、行区间至多30行且不可覆盖整文件；无snippet的定位行号不是正文片段。；BR-INT-M14-04：单artifact按path累计片段最多2400字符、60个不同行且少于源文件总行数；服务端跨run按project+file SHA累计不同片段声明，同摘要改路径不重置预算，完全相同声明去重。；BR-INT-M14-04：已知路径/凭据模式筛查覆盖产物字符串；额外整源码检查只递归可选ua_graph的字符串，对已知≥16字节文件做整字节hash相等判断，不是分段/变形/任意自由文本的DLP证明。；BR-INT-M14-04：schema当前最多25000节点/100000边/20000证据，HTTP 32MiB；解释仍为inferred，不因发布自动变代码事实或业务批准。；状态：run→succeeded并锁artifact_sha256；默认view不随publish改变。|严格字段/引用/身份/已知敏感模式或片段预算校验失败→拒绝发布；可选ua_graph中字符串与已知≥16字节文件整字节摘要精确相同时亦拒绝。这些有限机制不能推导任意私密内容必然被发现。；成功run换不同artifact重传→冲突，不替换不可变结果。|apps/cli/src/code-understanding-plugins.ts:242–321 @ 71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1；packages/application/src/code-understanding-use-cases.ts:80–100 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；packages/application/src/code-understanding-use-cases.ts:147–161 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；packages/contracts/src/code-understanding.ts:1–162 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696；apps/core-api/src/routes/code-understanding.ts:1–32 @ d2c8bcf363474fb736078a9191044aac1eed7abb2f0811798b1a45af06fb106d；packages/contracts/src/code-understanding.ts:16–18 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696；packages/contracts/src/code-understanding.ts:67–83 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696；packages/contracts/src/code-understanding.ts:131–150 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696；packages/application/src/code-understanding-use-cases.ts:69–98 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；packages/application/src/code-understanding-use-cases.ts:139–150 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；packages/contracts/src/code-understanding.ts:94–105 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696|REQ-INT-M14-04-AC01：重复run或改路径不能突破同源摘要片段总预算。；REQ-INT-M14-04-AC02：发布成功不自动切换项目当前视图。；REQ-INT-M14-04-AC03：单片段1200字符可符合schema，1201字符拒绝；不混用累计2400阈值。；REQ-INT-M14-04-AC04：含snippet的30行区间可符合范围限制，31行拒绝。；REQ-INT-M14-04-AC05：有限已知模式与可选UA整字节筛查可触发拒绝，但不证明通用私密内容阻断。|
|BR-INT-M14-05|有项目write权限的有效成员；code view compose/select 及view API；组成run均成功且归同项目与对应repository；base view明确；最多50仓。|BR-INT-M14-05：draft指针永不替换committed指针；不带run/view的远端默认查询取current committed。；BR-INT-M14-05：多仓汇总不是自动确认跨仓调用，跨仓业务关系必须有明确证据。；状态：新增immutable view；明确select后仅对应kind selection变化，旧run/view保留。|跨项目/仓库错配、不成功run→拒绝组合。；旧expected current view→冲突，不覆盖并发新选择。|packages/application/src/code-understanding-use-cases.ts:162–191 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；packages/application/src/code-understanding-use-cases.ts:205–241 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628|REQ-INT-M14-05-AC01：草稿选择不覆盖提交选择。；REQ-INT-M14-05-AC02：并发选择旧CAS失败。|
|BR-INT-M14-06|当前有代码知识读取权的Agent；code overview/search/node/relations/context/callers/callees/impact/affected-tests；显式run或view用于版本固定；当前project读权且非Viewer。|BR-INT-M14-06：原生query可在本机awaiting_agent阶段帮助当前Agent；发布后仍读取固定同run来源。；BR-INT-M14-06：返回节点ID需真实查询获得；cg前缀与原生ID不能混用/猜造；缺关系或结果裁剪不代表不存在。；状态：query不改变平台run/default view；可丢弃副本与查询日志只在本地。|远端请求不支持的native context/callers等→明确不支持，不伪装投影为原生深层查询。；Viewer、无关系统管理员、跨项目run→拒绝，不因知识不是完整源码而放宽正文权限。；旧native数据库需要迁移→不修改旧index；拒绝或在可丢弃副本处理支持查询。|apps/cli/src/code-understanding.ts:224–258 @ d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4；apps/cli/src/code-understanding-plugins.ts:323–374 @ 71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1；packages/application/src/code-understanding-use-cases.ts:33–41 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；packages/application/src/code-understanding-use-cases.ts:205–241 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628|REQ-INT-M14-06-AC01：本机native查询不迁移或修改旧索引。；REQ-INT-M14-06-AC02：Viewer与无关管理员不能读代码知识。|
|BR-INT-M14-07|有项目代码知识读取权的Web用户；项目“代码理解”页面与native reader；明确run/view/repository；图为已发布成功原生UA；构建脚本固定UA版本并记录资源摘要，运行加载未比较这些摘要。|BR-INT-M14-07：构建脚本约束UA2.9.8、资源自包含并写摘要，属于构建来源记录；React运行加载只检查HTTP成功，不实施资源摘要校验。iframe仅allow-scripts，文档CSP connect-src none；这些是静态控制配置，未执行实时浏览器安全测试。；BR-INT-M14-07：Web第一版只查看，解释更新由Agent重分析后发布；图上的业务推断不当成已批准需求。；状态：页面选择与URL变化；不自动修改run或项目默认view。|reader.js/css HTTP非成功或fetch/read失败→显示资源加载错误；现有运行加载器没有读取manifest并比较资源digest，HTTP200的改动资源不保证触发完整性错误。构建阶段版本/打包检查另行约束。；伪造postMessage→按source/channel/node存在性及null origin边界拒绝。|apps/web/src/UaNativeReader.tsx:1–63 @ 9d51872ebca91cdf7b90a04693e46f041a8671b0b257249995f56c524c2fc0a1；apps/web/src/uaReaderBridge.ts:1–36 @ d561d3671f5b16e5498ba9a6dbea9dfc32f05cbd751eb46cede924996d795998；apps/web/ua-reader/bridge.tsx:1–107 @ ab7722a48599be73a2bb8889b999c0dc98acb869c78a3e7c9b96ecaa701ebd43；apps/web/src/CodeUnderstandingWorkbench.tsx:1–148 @ d0bf9a141792b39138cb3c0d8baeb29e960716934cd04ec26b087d143bb8e0cd；scripts/build-ua-reader.mjs:1–118 @ 9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3；packages/application/src/code-understanding-use-cases.ts:192–204 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628；apps/web/src/UaNativeReader.tsx:19–29 @ 9d51872ebca91cdf7b90a04693e46f041a8671b0b257249995f56c524c2fc0a1；scripts/build-ua-reader.mjs:16–18 @ 9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3；scripts/build-ua-reader.mjs:70–78 @ 9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3；scripts/build-ua-reader.mjs:111–117 @ 9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3|REQ-INT-M14-07-AC01：原生完整图不受普通分页上限丢失节点。；REQ-INT-M14-07-AC02：外部消息和iframe网络能力不能修改平台。；REQ-INT-M14-07-AC03：运行加载对HTTP失败报错，但没有摘要比较来拒绝HTTP200的变更资源。|
|BR-INT-M14-08|有已发布知识读取权的Agent；code requirements-context 与intake普通material模式；明确成功run/view；新输出目录，导出文档≤2MiB。|BR-INT-M14-08：两种intake入口互补：旧文档导出供材料阅读，新2.2.0原始快照桥接可供源码证据。；BR-INT-M14-08：导出知识不创建需求、不自动submit/apply。；状态：本地只新增知识导出目录；平台业务和默认视图不变。|未成功run或缺少明确范围→拒绝导出。；把导出知识作为observed_in_code证据→候选需改为documented/inferred或补原始source，不升级可信度。|apps/cli/src/code-understanding-context.ts:1–70 @ 571add5c2e1a300c1d8e40b9071fb4d84e23726f7e54db605ec0970c9bb04769；apps/cli/src/intake-code-knowledge.ts:14–68 @ 274697e231e69c7286ea79379446c6f1b7e166d0e6a9ad8e6c03a08a29db682a|REQ-INT-M14-08-AC01：文档导出清楚声明未复验原始源码。；REQ-INT-M14-08-AC02：原始观察需要code-run桥接而不是改文档标签。|

## BR → REQ / AC / 验证矩阵

|BR|REQ|Feature|AC|计划状态|
|---|---|---|---|---|
|BR-INT-M14-01|REQ-INT-M14-01|INT-FEAT-M14-analysis|REQ-INT-M14-01-AC01|not_run，未来计划|
|BR-INT-M14-01|REQ-INT-M14-01|INT-FEAT-M14-analysis|REQ-INT-M14-01-AC02|not_run，未来计划|
|BR-INT-M14-02|REQ-INT-M14-02|INT-FEAT-M14-analysis|REQ-INT-M14-02-AC01|not_run，未来计划|
|BR-INT-M14-02|REQ-INT-M14-02|INT-FEAT-M14-analysis|REQ-INT-M14-02-AC02|not_run，未来计划|
|BR-INT-M14-03|REQ-INT-M14-03|INT-FEAT-M14-analysis|REQ-INT-M14-03-AC01|not_run，未来计划|
|BR-INT-M14-03|REQ-INT-M14-03|INT-FEAT-M14-analysis|REQ-INT-M14-03-AC02|not_run，未来计划|
|BR-INT-M14-03|REQ-INT-M14-03|INT-FEAT-M14-analysis|REQ-INT-M14-03-AC03|not_run，未来计划|
|BR-INT-M14-04|REQ-INT-M14-04|INT-FEAT-M14-analysis|REQ-INT-M14-04-AC01|not_run，未来计划|
|BR-INT-M14-04|REQ-INT-M14-04|INT-FEAT-M14-analysis|REQ-INT-M14-04-AC02|not_run，未来计划|
|BR-INT-M14-04|REQ-INT-M14-04|INT-FEAT-M14-analysis|REQ-INT-M14-04-AC03|not_run，未来计划|
|BR-INT-M14-04|REQ-INT-M14-04|INT-FEAT-M14-analysis|REQ-INT-M14-04-AC04|not_run，未来计划|
|BR-INT-M14-04|REQ-INT-M14-04|INT-FEAT-M14-analysis|REQ-INT-M14-04-AC05|not_run，未来计划|
|BR-INT-M14-05|REQ-INT-M14-05|INT-FEAT-M14-views|REQ-INT-M14-05-AC01|not_run，未来计划|
|BR-INT-M14-05|REQ-INT-M14-05|INT-FEAT-M14-views|REQ-INT-M14-05-AC02|not_run，未来计划|
|BR-INT-M14-06|REQ-INT-M14-06|INT-FEAT-M14-query|REQ-INT-M14-06-AC01|not_run，未来计划|
|BR-INT-M14-06|REQ-INT-M14-06|INT-FEAT-M14-query|REQ-INT-M14-06-AC02|not_run，未来计划|
|BR-INT-M14-07|REQ-INT-M14-07|INT-FEAT-M14-query|REQ-INT-M14-07-AC01|not_run，未来计划|
|BR-INT-M14-07|REQ-INT-M14-07|INT-FEAT-M14-query|REQ-INT-M14-07-AC02|not_run，未来计划|
|BR-INT-M14-07|REQ-INT-M14-07|INT-FEAT-M14-query|REQ-INT-M14-07-AC03|not_run，未来计划|
|BR-INT-M14-08|REQ-INT-M14-08|INT-FEAT-M14-views|REQ-INT-M14-08-AC01|not_run，未来计划|
|BR-INT-M14-08|REQ-INT-M14-08|INT-FEAT-M14-views|REQ-INT-M14-08-AC02|not_run，未来计划|

详细结构化REQ/AC/计划在同模块需求条目与本地章节；均未执行，不构成批准或安全证明。
