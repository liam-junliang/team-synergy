# Governance repair map — GOV-INITIAL-001 至 005

本轮仅修订独立初始复核的五项发现及其重复表达。所有新增/细化场景都是未来验证计划，状态仍为 **not_run**；已有测试字段仅 **defined**。本报告记录作者修订及静态检查结果，交由原 reviewer 定向复核，不覆盖或改写初始 needs_revision 判定，不构成业务批准。

## 保留的首稿与版本

- parts/governance.first-pass.json 保持 SHA-256 eeab65e53ba1e73d98a0c6371a1d225f532c27dfc96105d77717481382a1ed4a。
- 五份原始章节已在修订前按同名复制到 modules-first-pass/，检查结果与初始报告列出的五个哈希完全一致；M03现稿仍与首稿字节相同。
- query-governance-build.first-pass.mjs 保留原生成脚本；未覆盖 review/governance-initial.json/.md。
- 初始报告当前 SHA-256：JSON bd0a4142ac4aadc8642c285bc2cbcef72c0f5e08a5dbf5fb663da61740b4f031；Markdown fe679c5351bd74d18e4fcac5301f14d8dac784131d2200e08ca73f135b2ecacd。本轮没有写入这两个文件。
- 当前候选 parts/governance.json：SHA-256 **28234b3e230c819e263bc3173886ddbfe7996074db1979c0bb7e41587a565596**。
- 固定 run NSG3TKRB16Y9F6Y203WB，原始源码 manifest=0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；enterprise混合输入 manifest=c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e，均保持不变。

## 逐项映射与同步范围

| 初始发现 | 修订及当前观察 | 稳定追溯 / 同步载体 |
| --- | --- | --- |
| GOV-INITIAL-001 blocker | 将应用用例每图2MiB/合计5MiB与公开HTTP整体JSON 1MiB明确分层。原IMAGES只断言隔离夹具直接调用应用用例的声明格式/长度检查；新增IMAGES-HTTP断言默认路由超1MiB先413。给出Buffer.alloc(n).toString(base64)、4×ceil(n/3)、UTF-8 JSON总字节及pad(L±1)构造；1MiB decoded图片对应1398104字符base64，仍在HTTP先拒绝。没有把提高HTTP上限写成当前实现或已批准建议。 | REQ-GOV-TOPIC-DECISIONS：BR/AC/TC-GOV-TOPIC-DECISIONS-IMAGES及新增IMAGES-HTTP；main_flow/data_contracts/state相关例外、content_markdown、verification_plan、GOV-M04-RULES的规则/计划/矩阵、Feature/能力证据同步。 |
| GOV-INITIAL-002 warning | 公共GET名册无访问权时先getProject并返回ok=false/project_forbidden，不再断言HTTP空列表。保留内部listMembers→[]的层级说明，计划只验证公开HTTP，不声称额外内部检查已运行。 | REQ-GOV-PROJECT-EFFECTIVE-MEMBERS，BR/AC/TC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROSTER；spec、正文、plan.expected、GOV-M02-RULES及证据同步。 |
| GOV-INITIAL-003 warning | 原EXPIRED限定无有效旧会话且管理员重签是恢复路径，不作唯一性结论。新增EXPIRED-SESSION：到期前取得S→超过15分钟→旧初始密码新登录401→S携当前密码自行改密→标志清空→新密码可登录，S保留。PASSWORD-CHANGE的数据合同也明确不检查初始expiry。 | REQ-GOV-PASSWORD-LOGIN的BR/AC/TC EXPIRED及EXPIRED-SESSION、REQ-GOV-PASSWORD-CHANGE.data_contracts、GOV-M01-RULES规则/流程/计划/矩阵同步。 |
| GOV-INITIAL-004 warning | 删除虚构的“R approved”初态，改为正常create draft R1、合法AC且无问题、再transition confirmed的独立基准。原INVALID稳定ID收窄为空数组HTTP拒绝，另以11个命名分支分别覆盖重复/未知需求、未知修订、跨项目、draft状态、普通成员、归档、未知字段、元数据长度、1001选择数量、空白元数据。每次仅改指定因素，记录准确错误码和header/items不增加；1000选择对照另行复位，明确大量数据尚需准备。 | REQ-GOV-BASELINE-FREEZE新增及细化共12个拒绝/边界AC，加保留FREEZE/PARENT/IMMUTABLE共15条；spec/BR/正文/计划、GOV-M05-RULES和矩阵同步。错误码baseline_requirement_not_approved不被当成approved状态。 |
| GOV-INITIAL-005 warning | 原QUOTA只负责分钟场景；另加QUOTA-HOUR、QUOTA-SCOPE、QUOTA-RETENTION。小时用t0/60/120/180秒各5次，t0+240秒第21次预期429/3360秒；scope用同IP/相同账号文本对password与bind分别计数；清理夹具使用t0−3600001/−3600000/−3599999毫秒三行验证严格lt。每条都观测持久计数且记录拒绝请求也增计数。 | REQ-GOV-PASSWORD-LOGIN的BR/AC/TC QUOTA及三个新增QUOTA-*，spec数据与状态、GOV-M01-RULES、计划/矩阵同步。四条计划均独立重置限流表和受控时钟。 |

## 基线拒绝分支的实际错误模型

所有分支均位于 /projects/P/requirement-baselines，P初始active，O有效Owner，R confirmed且只存在R1，元数据与parent=null合法；除本行因素外不变。P/P2均无基线，失败后P header/items计数各0，关联需求不变。各分支独立复位，不能继承此前已成功基线。

| AC后缀 | 唯一变化 / 入口层级 | 预期错误或对照 |
| --- | --- | --- |
| INVALID | HTTP requirements=[] | validation_failed |
| SELECTION-DUPLICATE | 两项均同一真实R/R1，HTTP形状合法 | 应用baseline_invalid_selection |
| UNKNOWN-REQUIREMENT | 格式合法、库内不存在的Z/R1 | baseline_invalid_selection |
| UNKNOWN-REVISION | 真实confirmed R选不存在R2 | baseline_revision_not_found |
| CROSS-PROJECT | 选择P2内confirmed R2的真实R1 | baseline_requirement_project_mismatch |
| STATE-DRAFT | 选择P内draft Rd的真实R1 | baseline_requirement_not_approved |
| ROLE-MEMBER | 仅认证操作者改为有效member U | baseline_owner_required |
| PROJECT-ARCHIVED | 仅将P先由O归档 | project_archived |
| UNKNOWN-FIELD | body或单个选择额外unexpected:true；两个独立复位分支 | validation_failed |
| FIELD-SIZE | name=201 / scope=2001 / reason=4001个ASCII字符；三个独立分支，总JSON远小于1MiB | validation_failed |
| SELECTION-SIZE | 正常流程准备1001个不同confirmed需求，均选真实R1 | 1001项validation_failed且0写；独立复位后1000项合法对照header=1/items=1000 |
| METADATA-EMPTY | name/scope/reason之一空白，三个独立分支 | validation_failed |

## 夹具建设前提与未执行边界

- 配额和初始口令过期场景需要控制服务器new Date与Date.now、固定request.ip、隔离PostgreSQL、只读查询hash定位行并重置数据的夹具；本次没有提供或运行该夹具。夹具只能在专用测试环境建设，不能假定生产具备控制时钟/读表接口。
- 图片应用边界需要直接调用固定用例的隔离夹具；HTTP边界需要实际使用默认server.ts配置且不覆盖bodyLimit的隔离实例。二者未提供或运行。合成base64只证明声明/推算字节路径，不冒称有效PNG内容。
- 1001项选择场景需要先按当前正常需求生命周期准备不同的confirmed记录；未发明批量seed API、approved状态或成功测试收据。
- 所有126条验证计划仍not_run；本轮未执行业务HTTP/CLI写入、真实验收、迁移、数据库夹具或任何产品源代码变更。原始五项判定是否关闭，等待独立定向复核。

## 本轮复读的核心源码证据

- apps/core-api/src/server.ts L67-74，SHA-256 3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada。
- apps/core-api/src/routes/requirement-collaboration.ts L50-53，SHA-256 cbd63cdecc412dc8121925a1df0dc70f7054d8ccbfa4bd3c1fc598d8601cf406。
- packages/application/src/requirement-collaboration-use-cases.ts L27-50，SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710。
- apps/core-api/src/routes/projects.ts L167-171，SHA-256 4f016bc1bf57e3a429142799654121e533907397263aae7cf82bf47c857c75eb。
- packages/application/src/project-use-cases-project.ts L310-315，SHA-256 141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44。
- packages/application/src/member-use-cases.ts L103-108，SHA-256 37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28。
- packages/application/src/auth-use-cases.ts L79-85，SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab。
- packages/application/src/auth-use-cases.ts L90-110，SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab。
- apps/core-api/src/auth.ts L76-95，SHA-256 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8。
- packages/application/src/auth-rate-limit.ts L7-24，SHA-256 5cb59034dd5df29f8e37fdc2de4ebfb960e82cdfdad67aa195cca9d36aebb634。
- packages/application/src/requirement-use-cases.ts L18-37，SHA-256 403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612。
- packages/application/src/baseline-use-cases.ts L171-185，SHA-256 b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193。
- apps/core-api/src/routes/baselines.ts L24-38，SHA-256 8f7b71495d6f52cee8a6c54eeb54a738d53a82f118f1a124a87929a916b9ed70。

## 静态检查与交接

执行了文档生成与 query-governance-repair-check.mjs，结果见 query-governance-repair-check.json；这些是候选/证据检查，不是产品验收测试。

- 62项候选，37组需求，37项included能力，126条BR/AC、126条链接验证计划；仍1项文案/权限冲突。
- 当前IntakeItemSchema和IntakeProductionSchema通过；664处引用的捕获路径/SHA-256/真实行范围检查通过，证据涉及42个文件。
- 原62个item key及module/feature/document父引用全部保持；仅5个requirement正文/结构字段改变：REQ-GOV-BASELINE-FREEZE、REQ-GOV-PASSWORD-CHANGE、REQ-GOV-PASSWORD-LOGIN、REQ-GOV-PROJECT-EFFECTIVE-MEMBERS、REQ-GOV-TOPIC-DECISIONS。
- 相关Feature/能力证据、4章规则稿及矩阵同步；M03未改变。各章requirement_keys与原平台身份保留。
- 首稿JSON及5章备份哈希通过；初始报告未覆盖。source/run/pack及其他lane内容没有写入。
- 最终SHA-256：28234b3e230c819e263bc3173886ddbfe7996074db1979c0bb7e41587a565596。下一步由主agent把本修订稿与初始报告交给原reviewer做五项定向复核；本作者到此停写。
