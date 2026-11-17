# Intelligence 初审修复映射

状态：10项文档调和已完成，等待原reviewer定向复核；不是业务批准、应用测试通过或安全证明。

初稿part SHA-256 `0da4754ca520d77d34599151d4330df3df105a26bb6ffb6c874b4459c4b4666e`，保留于 parts/intelligence.first-pass.json。五模块初稿保留于 modules-first-pass/；初始独立报告原样保留。最终part SHA-256 `0c9290779e9022d50b8110a31de6ea908dda78376271ad4d5464ddb228653aef`。

|初审项|相关REQ/BR|文档调整与计划|仍保留的边界|
|---|---|---|---|
|INT-INITIAL-001|REQ-INT-M08-05 / BR-INT-M08-05|区分write Member创建与负责人/管理者修订；新增AC03覆盖创建及他人修订权限。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-002|REQ-INT-M08-05 / BR-INT-M08-05|XML只描述根/尾标签及DOCTYPE/ENTITY浅筛；新增AC04静态反例计划；完整解析/渲染安全列gap。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-003|REQ-INT-M08-08 / BR-INT-M08-08|下载应用证据改为getPrototypeFile L408–435，保留route L67–82；所有来源列同步。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-004|REQ-INT-M11-06 / BR-INT-M11-06|分开提交前预检、savepoint外全局失效和项内漂移；新增AC03确定性预检后漂移/独立继续及AC04提交前拒绝。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-005|REQ-INT-M13-09 / BR-INT-M13-09|AC01先证明同角色对普通非TEMP表有INSERT权限，再隔离READ ONLY/25006；新增AC03独立deadline夹具。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-006|REQ-INT-M13-12 / BR-INT-M13-12|明确仅两文件存在检查及Windows/POSIX不同marker；新增AC03缺agentd入口但保留launchers的未来故障计划，完整载荷缺口仍gap。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-007|REQ-INT-M14-03 / BR-INT-M14-03|采用真实8值enum、初始preparing及允许前向跳态；新增AC03注册/跳态/回退计划。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-008|REQ-INT-M14-04 / BR-INT-M14-04|分开snippet1200字符/30行与累计2400/60/少于整文件；新增AC03/04单条边界计划。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-009|REQ-INT-M14-04 / BR-INT-M14-04|收窄模块/Feature/REQ/规则文档隐私措辞至已知模式和可选UA精确hash；新增AC05有限筛查计划，任意自由文本DLP保持unknown/gap。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|
|INT-INITIAL-010|REQ-INT-M14-07 / BR-INT-M14-07|运行仅HTTP成功/text；构建版本与digest为来源记录；新增AC03对比404/200变更资源，不虚构运行摘要拒绝。|仅修改part、模块MD/规则表/AC矩阵与发现记录；源实现未改；新增夹具未创建，verification_plan均not_run。|

## 同步与验证

每项结构化spec、BR、AC和逐AC计划与REQ正文、章节BR表、AC矩阵及持久规则文档同步。REQ/Feature/module/document身份、43个REQ与43个capability不变；新增AC只追加稳定编号。引用仍为原run/snapshot/source哈希。strict schema/hash/range/父链/AC/章节同步结果由 validate-intelligence.mjs输出，后续附在discovery-intelligence.md；原初审不被覆盖。

## 原始报告与初稿完整性

- review/intelligence-initial.json SHA-256 `ab9da796a4999f979bef884c9ad650d1b138a88ff66ad2be9c4e6ec735848515`（修前/修后相同）。
- review/intelligence-initial.md SHA-256 `79af232833b4edb980d310152a3a9b8f27c7a6b365d98810972d03e67b608be9`（修前/修后相同）。
- modules-first-pass/m08-intelligence.md SHA-256 `6d366d85d46f008467cc16b0dc8f4d7ef279ab55d232ec872239553b0638a93d`。
- modules-first-pass/m11-intelligence.md SHA-256 `79a412144c7e6a9e40640721d845cac040adebbc703c79f6dd609b81e090a8c9`。
- modules-first-pass/m12-intelligence.md SHA-256 `a605c1a0b03c4b278c187890b7f99bf431ab5c30006bb3d56cbdb750ccfeb9b4`。
- modules-first-pass/m13-intelligence.md SHA-256 `1f998ccb56b29d0aee7ba20637e19a001b01ca93facc62cb0e41c8f532ca678c`。
- modules-first-pass/m14-intelligence.md SHA-256 `d52d421984c229c25a668e5984a29835ddea8d6d39bd02f2a0eb740cddb6067c`。

## 定向复核证据

### INT-INITIAL-001

- packages/application/src/architecture-document-use-cases.ts:103–118 @ 07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592
- packages/application/src/architecture-document-use-cases.ts:122–129 @ 07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592

### INT-INITIAL-002

- packages/application/src/architecture-document-content.ts:25–33 @ 4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7
- packages/application/src/architecture-document-content.ts:58–69 @ 4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7

### INT-INITIAL-003

- packages/application/src/design-prototype-use-cases.ts:217–252 @ 8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c
- packages/application/src/design-prototype-use-cases.ts:408–435 @ 8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c
- apps/core-api/src/routes/design-prototypes.ts:67–82 @ 26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f

### INT-INITIAL-004

- packages/application/src/intake-use-cases.ts:325–336 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9
- packages/application/src/intake-use-cases.ts:376–388 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9
- packages/application/src/intake-use-cases.ts:405–419 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9
- packages/application/src/intake-use-cases.ts:453–463 @ b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9

### INT-INITIAL-005

- packages/persistence/src/read-only-snapshot.ts:17–34 @ 119e24194766f4055441ee4fddc9964b53b9eb245515db773c9ba4afa2cca6b6

### INT-INITIAL-006

- scripts/cli-install/install.ps1:57–72 @ 9cab5570cf3f5e30139422f0033324c95925f57ced690dad7a6744b4bc279298
- scripts/cli-install/install.sh:33–40 @ edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f
- scripts/cli-install/install.sh:68–80 @ edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f

### INT-INITIAL-007

- packages/contracts/src/code-understanding.ts:41–44 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696
- packages/application/src/code-understanding-use-cases.ts:119–136 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628

### INT-INITIAL-008

- packages/contracts/src/code-understanding.ts:16–16 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696
- packages/contracts/src/code-understanding.ts:137–150 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696
- packages/application/src/code-understanding-use-cases.ts:80–98 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628

### INT-INITIAL-009

- packages/contracts/src/code-understanding.ts:16–18 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696
- packages/contracts/src/code-understanding.ts:79–83 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696
- packages/contracts/src/code-understanding.ts:131–150 @ ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696
- packages/application/src/code-understanding-use-cases.ts:69–77 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628
- packages/application/src/code-understanding-use-cases.ts:139–150 @ f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628

### INT-INITIAL-010

- apps/web/src/UaNativeReader.tsx:19–29 @ 9d51872ebca91cdf7b90a04693e46f041a8671b0b257249995f56c524c2fc0a1
- scripts/build-ua-reader.mjs:16–18 @ 9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3
- scripts/build-ua-reader.mjs:70–78 @ 9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3
- scripts/build-ua-reader.mjs:111–117 @ 9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3


## 修后实测静态校验结果

validate-intelligence.mjs 已完成：IntakeItem / Production / Bundle严格schema均通过；43 REQ、43 BR、97 AC及97逐AC计划；312处证据hash/行界、所有父链、候选身份与5模块正文/BR表/AC矩阵同步检查通过。初稿SHA及模块成员不变；本lane条目blocker=0。72个检视文件与5条真实查询日志hash复验通过。全部计划not_run，现有测试引用仍defined，未执行业务API或修改实现。

11个合并前缺档blocker来自本lane不包含root负责的全局档案；不据此宣称整个合并候选已合格。后续由原reviewer对10项逐一复核。
