# Governance targeted recheck

**Verdict: reviewed_with_limits.** 原五项发现全部在静态规格/验证设计范围内关闭；本轮无未关闭项。原initial的needs_revision结论保留为首稿记录，不被覆盖。

## 固定输入与边界

- 当前候选：`parts/governance.json`，SHA-256 `28234b3e230c819e263bc3173886ddbfe7996074db1979c0bb7e41587a565596`。
- 固定源码：run `NSG3TKRB16Y9F6Y203WB`，raw manifest `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`。
- 企业混合输入 manifest：`c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e`；Skill `2.2.0`。
- 作者修订映射仅作导航；下列判定以当前候选、同步章节及重新打开的固定源码为依据。
- 本轮只覆盖原五项，不扩展为新的全量审查。没有API、真实业务测试、数据库写入或候选修改。

## 逐项结论

| 原发现 | 状态 | 定向结论 |
| --- | --- | --- |
| GOV-INITIAL-001 | **closed_static** | HTTP与应用图片限制已分层，计划可明确观察各自边界。 |
| GOV-INITIAL-002 | **closed_static** | HTTP无权名册改为project_forbidden，内部[]行为单独解释。 |
| GOV-INITIAL-003 | **closed_static** | 移除管理员唯一恢复结论，补充有效旧session自行改密路径。 |
| GOV-INITIAL-004 | **closed_static** | approved fixture已修正，拒绝分支独立且错误层级明确。 |
| GOV-INITIAL-005 | **closed_static** | 分钟/小时/scope/留存清理均有独立可观察计划。 |

### GOV-INITIAL-001 — closed_static

- 候选：`REQ-GOV-TOPIC-DECISIONS`。
- 复核字段：BR/AC/TC IMAGES 与新增 IMAGES-HTTP；specification.main_flow/exceptions/data_contracts、content_markdown、GOV-M04-RULES/矩阵。

修订明确应用用例单张2MiB/合计5MiB与公开HTTP整体JSON 1048576字节是两层边界。应用计划直接调用固定用例，精确构造1字节、2MiB、5MiB与超限合成base64；HTTP计划使用默认实例、pad(L−1/L/L+1)及1MiB decoded图片，分别观测可进入用例或413/request_body_too_large。合成字节不冒称有效PNG，隔离夹具明确尚未建设/运行；没有把提高HTTP限制写成现状。

重新读取并核对的固定源码证据：

- `apps/core-api/src/server.ts` L67–74，SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`。
- `apps/core-api/src/routes/requirement-collaboration.ts` L50–53，SHA-256 `cbd63cdecc412dc8121925a1df0dc70f7054d8ccbfa4bd3c1fc598d8601cf406`。
- `packages/application/src/requirement-collaboration-use-cases.ts` L27–51，SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`。

限制：未执行实际HTTP边界、直接应用用例或数据库保持状态断言；关闭的是规格的入口层级混淆。

### GOV-INITIAL-002 — closed_static

- 候选：`REQ-GOV-PROJECT-EFFECTIVE-MEMBERS`。
- 复核字段：BR/AC/TC ROSTER；specification.exceptions/business_rules、content_markdown、GOV-M02-RULES/矩阵。

HTTP名册规则与计划已改为：有效但无项目访问的Y先被getProject拒绝，ok=false/error.code=project_forbidden且无名册data；内部listMembers→[]被明确保留为内部行为。夹具明确Y无团队、explicit或owner访问，U/X的正向名册与外部标记对照也独立可观察。

重新读取并核对的固定源码证据：

- `apps/core-api/src/routes/projects.ts` L167–171，SHA-256 `4f016bc1bf57e3a429142799654121e533907397263aae7cf82bf47c857c75eb`。
- `packages/application/src/project-use-cases-project.ts` L310–315，SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`。
- `packages/application/src/member-use-cases.ts` L103–108，SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`。

限制：未执行HTTP请求或权限/名册数据断言；关闭的是错误的HTTP空列表预期。

### GOV-INITIAL-003 — closed_static

- 候选：`REQ-GOV-PASSWORD-LOGIN; REQ-GOV-PASSWORD-CHANGE`。
- 复核字段：EXPIRED、EXPIRED-SESSION 的BR/AC/plan；PASSWORD-CHANGE.data_contracts、状态描述、content_markdown、GOV-M01-RULES/矩阵。

管理员重签已描述为一条恢复路径，不再宣称唯一。新增计划先在t0取得S，再推进至t0+16分钟，新口令登录401后以S和当前初始密码改密，验证两个标志清除、新密码登录与S保留；会话有效、用户/设备未失效及hash未变等资格明确。源码仅新登录检查初始expiry，改密入口验证当前口令并清除标志，Bearer首次改密门禁允许此入口。

重新读取并核对的固定源码证据：

- `packages/application/src/auth-use-cases.ts` L79–85，SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`。
- `packages/application/src/auth-use-cases.ts` L90–110，SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`。
- `apps/core-api/src/auth.ts` L76–95，SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`。
- `apps/core-api/src/routes/auth.ts` L98–127，SHA-256 `16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8`。

限制：未建设或运行受控服务器时钟及会话改密夹具；关闭的是唯一恢复结论，不证明线上恢复成功。

### GOV-INITIAL-004 — closed_static

- 候选：`REQ-GOV-BASELINE-FREEZE`。
- 复核字段：保留INVALID与新增11个命名拒绝/边界BR/AC/plan；specification.exceptions/business_rules、content_markdown、GOV-M05-RULES/矩阵。

无效approved状态已移除；有效基准由正常draft R1＋合法AC/无问题转换confirmed形成。空选择、重复、未知需求、未知revision、跨项目、draft、member、archived、未知字段、字符数、1001选择数量及空白元数据均给出独立复位/单一变化/准确错误与header/items保持断言。HTTP形状拒绝和应用用例错误层级与源码一致；1000项正向对照和大集合夹具明确为未来准备。

重新读取并核对的固定源码证据：

- `packages/application/src/requirement-use-cases.ts` L18–37，SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`。
- `packages/application/src/requirement-use-cases.ts` L740–753，SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`。
- `apps/core-api/src/routes/baselines.ts` L24–38，SHA-256 `8f7b71495d6f52cee8a6c54eeb54a738d53a82f118f1a124a87929a916b9ed70`。
- `packages/application/src/baseline-use-cases.ts` L36–45，SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`。
- `packages/application/src/baseline-use-cases.ts` L68–83，SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`。
- `packages/application/src/baseline-use-cases.ts` L169–198，SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`。

限制：未实际准备1001条需求、运行迁移/SQL或发送基线请求；关闭的是无效fixture及多错误分支含混。

### GOV-INITIAL-005 — closed_static

- 候选：`REQ-GOV-PASSWORD-LOGIN`。
- 复核字段：QUOTA、QUOTA-HOUR、QUOTA-SCOPE、QUOTA-RETENTION 的BR/AC/plan；specification状态/数据、content_markdown、GOV-M01-RULES/矩阵。

分钟用例在固定t0第6次拒绝并读取两个hash键计数；小时用例在四个分钟各5次、t0+240秒第21次429/Retry-After=3360；第二scope使用同IP和相同键文本验证独立计数；清理用例以t0−3600001/−3600000/−3599999毫秒行验证严格lt和全表清理。拒绝请求也增计数已明示。服务器Date/Date.now、request.ip和隔离数据库可读夹具均声明尚未建设/运行。

重新读取并核对的固定源码证据：

- `packages/application/src/auth-rate-limit.ts` L5–24，SHA-256 `5cb59034dd5df29f8e37fdc2de4ebfb960e82cdfdad67aa195cca9d36aebb634`。
- `apps/core-api/src/routes/auth.ts` L84–112，SHA-256 `16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8`。

限制：未执行限额、scope隔离、时钟或留存清理测试；关闭的是步骤无法观察全部expected的设计缺口。

## 同步与机械核对证据

- 37条REQ身份保持；当前共有126条AC和126条链接计划。本次阅读五个受影响REQ的34条AC/plan。
- 对五个REQ逐项核对spec main_flow/business_rules/state_changes/data_contracts与requirement content_markdown，并核对各BR条件/结果、plan.expected、专用步骤及BR→REQ→AC→TC→not_run矩阵；未发现本轮修订内容遗漏或相反表达。
- 四个受影响章节GOV-M01/M02/M04/M05的候选规则文档与modules文件按行归一化比较一致；M03不在本轮修订范围。126条矩阵均为not_run，所有tests仍defined。
- 所有上述证据的实际SHA-256与pack source.files匹配，行范围有效；这证明证据资格，不代替语义或运行验证。
- recheck JSON按canonical evaluation.schema.json验证通过；findings为空表示本次定向复核没有未关闭的原发现，逐项closed_static记录在本Markdown中，避免把已关闭项伪装成当前blocker。

## 保留文件

- `parts/governance.first-pass.json` SHA-256 `eeab65e53ba1e73d98a0c6371a1d225f532c27dfc96105d77717481382a1ed4a`（未改变）。
- `review/governance-initial.json` SHA-256 `bd0a4142ac4aadc8642c285bc2cbcef72c0f5e08a5dbf5fb663da61740b4f031`（未改变）。
- `review/governance-initial.md` SHA-256 `fe679c5351bd74d18e4fcac5301f14d8dac784131d2200e08ca73f135b2ecacd`（未改变）。

## 未执行与范围限制

- GOV-INITIAL-001：静态关闭；HTTP/app图片边界与数据库保持状态计划未运行，尚需建设声明的隔离夹具。
- GOV-INITIAL-002：静态关闭；HTTP名册拒绝与数据不泄露/不变化断言未运行。
- GOV-INITIAL-003：静态关闭；控制服务器时钟后以有效旧session改密的计划未运行。
- GOV-INITIAL-004：静态关闭；逐分支基线fixture、1001条数据与1000条正向对照未准备或执行。
- GOV-INITIAL-005：静态关闭；分钟/小时/scope/retention四类配额夹具及读表断言未执行。
- 126条验收矩阵仍not_run；tests字段仅defined。未调用API、执行真实业务测试、数据库写入或迁移；未更改候选或固定源码。
- 五个受影响REQ的34条AC/plan及相关正文/BR/章节矩阵做重复表达核对；其他未受影响REQ未重新做源码语义全审。业务目标、批准和部署保证不由本报告建立。

## 本轮输入哈希

- `review/governance-repair-map.md` SHA-256 `818a9e7c8986f566467851bcd25f339659e79b44e0baf45ecf0eaa2a28cf82ec`。
- `modules/m01-identity.md` SHA-256 `72f982aea4014d9947a3255ac33b2138d5dcb497fc79c3eee30f403edf168def`。
- `modules/m02-governance.md` SHA-256 `65e8807554ec085d64066be39c9b05d9810662bd66f06cf434c67160aefd7ad8`。
- `modules/m03-structure.md` SHA-256 `af0ec19f9efe8ad8832aae5d5af5fd7602320039bbd921c4661b5f3ecf55226b`。
- `modules/m04-discovery.md` SHA-256 `c8245b870db0621dddb3a6a9f000a5d2970032a649e88043a1fe60e2d274b164`。
- `modules/m05-requirements.md` SHA-256 `9b3d115614de26a85599f54d842a8cf228eff9228eb0f6ca994c35b901b7fd34`。
