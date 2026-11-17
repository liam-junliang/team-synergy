# M10 技能版本与交付：业务规则与需求

## 来源与解释边界

固定run `NSG3TKRB16Y9F6Y203WB` revision4，project `19Q4K7PDARXQ9JHW6R6F`，repository `P1KRPDABN4RD0YXMX64E`，namespace `source-04d73353-be80-4433-8c5e-0b49a9c12c63`，snapshot `06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa`，DRAFT commit `92728fbec04cfa34fee4421cb0a9319d1b755164`，源码manifest `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`，混合接入manifest `c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e`。分支名称不作版本证明。UA供业务导航，codegraph供符号导航，以下判断均回到固定原始源码。

发布知识artifact SHA256 `691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8`；UA 2.9.8 adapter1.0.0 digest `d22a4a731809299030ee783710407af1e4ce37d5f1930345cb1d4b6a8cfb39a5`；codegraph 1.6.2 adapter1.0.0 digest `c7ce675c6c763726449fccb22159735859ad17eccbce1475c9617287479bf8da`；protocol1。发布交接仅包含12043节点中的前100且truncated=true、complete_repository_analysis=false，不能将未返回节点解释为不存在。

实际查询：UA overview及“任务执行/交接/测试/技能”search；relations来自返回节点 `ua:flow:cross-person-handover`、`ua:flow:test-execution-defect`、`ua:flow:skill-publish-share-install`，图边与evidence_ids保存在本次query-delivery-ua-*.json导航记录；native CG context从相同run返回claim/verify/submit、Git交接、testing与Run skills符号。图推断不代替下表原始证据。

assessment=observed_in_code仅描述实现；不代表产品预期、业务批准、运行期验收通过。现有测试标为defined，以下验证全部未执行。每个测试场景从独立种子/身份/权限开始，跨步骤继承只在该场景内明确列出。

## 角色、入口、实体与范围

规范技能包校验与草稿创建；技能目录、版本可见性与授权读取；技能修订、明确发布与归档恢复；精确版本共享、项目交付资格与撤销；项目技能安装、升级、别名及受限停用；项目与Run固定技能清单、继承及当前授权重检；本机技能清单检查、受管同步与失败恢复。

## 规则及双向追溯

|稳定业务规则|资格/选择/运行控制与结果|异常或保留状态|来源|REQ / AC / 计划用例|
|---|---|---|---|---|
|BR-DEL-M10-01-01|路径：相对NFC路径≤240字符，不含反斜线/绝对路径/控制字符/保留设备名/..或.git；大小写重复/目录拼写冲突及文件父路径冲突拒绝。|越界、大小写冲突、缺元数据、超限或hash不符→skill_invalid，不存部分技能/修订；来源无写权→skill_forbidden|`packages/application/src/skills-content.ts:5-95` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/application/src/skills-use-cases.ts:112-128` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:11-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)<br>`apps/core-api/src/server.ts:67-75` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/server.ts:155-167` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/auth.ts:98-128` (sha256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`)|REQ-DEL-M10-01 / AC-M10-01-01, AC-M10-01-02 / TC-M10-01-*|
|BR-DEL-M10-01-02|包：不支持symlink/特殊文件；规范Base64；文件可选size/hash必须匹配；总解码≤6MiB且文件1至200。|越界、大小写冲突、缺元数据、超限或hash不符→skill_invalid，不存部分技能/修订；来源无写权→skill_forbidden|`packages/application/src/skills-content.ts:5-95` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/application/src/skills-use-cases.ts:112-128` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:11-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)<br>`apps/core-api/src/server.ts:67-75` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/server.ts:155-167` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/auth.ts:98-128` (sha256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`)|REQ-DEL-M10-01 / AC-M10-01-01, AC-M10-01-02 / TC-M10-01-*|
|BR-DEL-M10-01-03|元数据：SKILL.md必在根且严格UTF-8，YAML frontmatter含唯一name与description标量；name为≤64字符小写字母数字单连字符且不为设备保留名，description≤1024。|越界、大小写冲突、缺元数据、超限或hash不符→skill_invalid，不存部分技能/修订；来源无写权→skill_forbidden|`packages/application/src/skills-content.ts:5-95` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/application/src/skills-use-cases.ts:112-128` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:11-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)<br>`apps/core-api/src/server.ts:67-75` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/server.ts:155-167` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/auth.ts:98-128` (sha256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`)|REQ-DEL-M10-01 / AC-M10-01-01, AC-M10-01-02 / TC-M10-01-*|
|BR-DEL-M10-01-04|运行边界：解析不求值YAML标签/别名/包代码；创建为初稿，不自动发布或执行脚本。|越界、大小写冲突、缺元数据、超限或hash不符→skill_invalid，不存部分技能/修订；来源无写权→skill_forbidden|`packages/application/src/skills-content.ts:5-95` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/application/src/skills-use-cases.ts:112-128` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:11-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)<br>`apps/core-api/src/server.ts:67-75` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/server.ts:155-167` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/auth.ts:98-128` (sha256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`)|REQ-DEL-M10-01 / AC-M10-01-01, AC-M10-01-02 / TC-M10-01-*|
|BR-DEL-M10-01-05|HTTP预算/错误：包解码总6MiB与JSON请求10MiB为不同限制；create需scope_type/scope_code/files，revise需base_revision/files/change_summary，version为≥1整数、base_generation≥0。超body预算全局返回413 request_body_too_large；JSON schema异常沿Fastify错误处理，不能假定均为skill_invalid或统一业务envelope。|越界、大小写冲突、缺元数据、超限或hash不符→skill_invalid，不存部分技能/修订；来源无写权→skill_forbidden|`packages/application/src/skills-content.ts:5-95` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/application/src/skills-use-cases.ts:112-128` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:11-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)<br>`apps/core-api/src/server.ts:67-75` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/server.ts:155-167` (sha256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`)<br>`apps/core-api/src/auth.ts:98-128` (sha256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`)|REQ-DEL-M10-01 / AC-M10-01-01, AC-M10-01-02 / TC-M10-01-*|
|BR-DEL-M10-02-01|草稿：来源管理者及有写权的原作者可见草稿；来源普通读者仅发布版；目标共享不带编辑或再共享权。|显式project不存在或无其当前read→project_not_found/project_forbidden，在返回详情字节之前拒绝，即使actor有source.read；无可见版本或无其他scope读权→skill_forbidden；目录排除该技能；多个/无范围、无效view→skill_invalid|`packages/application/src/skills-use-cases.ts:37-110` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:54-74` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-access.ts:103-129` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-02 / AC-M10-02-01, AC-M10-02-02, AC-M10-02-03 / TC-M10-02-*|
|BR-DEL-M10-02-02|请求资格与可见性优先级：show/详情若显式传project_code，先检查该项目存在和actor当前项目read，source.read不绕过该请求scope守卫；通过后source.read优先保留来源可见发布版/获准草稿，只有无source.read的目标分支才按manager/安装版及projectGrant限版本。非自有project catalog/search和安装列表仍各自收窄，不等同详情。|显式project不存在或无其当前read→project_not_found/project_forbidden，在返回详情字节之前拒绝，即使actor有source.read；无可见版本或无其他scope读权→skill_forbidden；目录排除该技能；多个/无范围、无效view→skill_invalid|`packages/application/src/skills-use-cases.ts:37-110` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:54-74` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-access.ts:103-129` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-02 / AC-M10-02-01, AC-M10-02-02, AC-M10-02-03 / TC-M10-02-*|
|BR-DEL-M10-02-03|顺序：摘要/详情修订revision DESC；目录底层按skill.updated_at DESC无最终ID tie-break；不能保证同时间技能的稳定顺序。|显式project不存在或无其当前read→project_not_found/project_forbidden，在返回详情字节之前拒绝，即使actor有source.read；无可见版本或无其他scope读权→skill_forbidden；目录排除该技能；多个/无范围、无效view→skill_invalid|`packages/application/src/skills-use-cases.ts:37-110` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:54-74` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-access.ts:103-129` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-02 / AC-M10-02-01, AC-M10-02-02, AC-M10-02-03 / TC-M10-02-*|
|BR-DEL-M10-02-04|保护：详情下载先核对显式项目上下文的当前读权，再持用户/来源/目标scope锁至选取字节；来源草稿权不替代项目请求资格，隐藏草稿计数及目标-only期待仍按各分支适用。|显式project不存在或无其当前read→project_not_found/project_forbidden，在返回详情字节之前拒绝，即使actor有source.read；无可见版本或无其他scope读权→skill_forbidden；目录排除该技能；多个/无范围、无效view→skill_invalid|`packages/application/src/skills-use-cases.ts:37-110` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:54-74` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-access.ts:103-129` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-02 / AC-M10-02-01, AC-M10-02-02, AC-M10-02-03 / TC-M10-02-*|
|BR-DEL-M10-03-01|权限：修订需source.write且是作者或source.manage；发布/归档仅source.manage，目标项目管理员没有来源管理权。|过期base_revision或作者被撤权→revision_conflict/forbidden，旧包不变；归档状态发布/修订→skill_archived|`packages/application/src/skills-use-cases.ts:20-30` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-use-cases.ts:130-169` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:27-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/persistence/src/schema.ts:1363-1374` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-03 / AC-M10-03-01, AC-M10-03-02 / TC-M10-03-*|
|BR-DEL-M10-03-02|版本：base_revision必须当前；旧发布包从不覆盖，修订保存新包与change_summary。|过期base_revision或作者被撤权→revision_conflict/forbidden，旧包不变；归档状态发布/修订→skill_archived|`packages/application/src/skills-use-cases.ts:20-30` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-use-cases.ts:130-169` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:27-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/persistence/src/schema.ts:1363-1374` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-03 / AC-M10-03-01, AC-M10-03-02 / TC-M10-03-*|
|BR-DEL-M10-03-03|归档：已归档技能拒绝修订/发布/共享并阻止新交付；历史留存，来源权限仍能读历史；恢复只改archived标记，不自动恢复已撤销share。|过期base_revision或作者被撤权→revision_conflict/forbidden，旧包不变；归档状态发布/修订→skill_archived|`packages/application/src/skills-use-cases.ts:20-30` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-use-cases.ts:130-169` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:27-46` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/persistence/src/schema.ts:1363-1374` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-03 / AC-M10-03-01, AC-M10-03-02 / TC-M10-03-*|
|BR-DEL-M10-04-01|精确授权：只能共享已发布版本，grant并不自动跟随新修订；完全相同目标/版本/flags不会重复插入。|draft版本、自身scope或未授权外部成员→拒绝共享/交付，不扩大权限；share不存在→skill_share_not_found|`packages/application/src/skills-use-cases.ts:172-208` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:81-102` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-run.ts:18-35` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-04 / AC-M10-04-01, AC-M10-04-02 / TC-M10-04-*|
|BR-DEL-M10-04-02|资格：本项目自有技能发布版直接可交付；本团队技能对无外部active成员的团队项目隐式可交付；一旦有外部成员需显式allow_external。|draft版本、自身scope或未授权外部成员→拒绝共享/交付，不扩大权限；share不存在→skill_share_not_found|`packages/application/src/skills-use-cases.ts:172-208` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:81-102` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-run.ts:18-35` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-04 / AC-M10-04-01, AC-M10-04-02 / TC-M10-04-*|
|BR-DEL-M10-04-03|团队接收：team share默认仅发现；向其项目交付须allow_projects且匹配该project.team；project share直接指向项目；任一种仍按精确版本及外部成员flag限制。|draft版本、自身scope或未授权外部成员→拒绝共享/交付，不扩大权限；share不存在→skill_share_not_found|`packages/application/src/skills-use-cases.ts:172-208` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:81-102` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-run.ts:18-35` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-04 / AC-M10-04-01, AC-M10-04-02 / TC-M10-04-*|
|BR-DEL-M10-04-04|撤销：soft revoke可重复；当前grant失败后阻断字节、manifest和新启动/恢复，不能远程收回已下载文件。|draft版本、自身scope或未授权外部成员→拒绝共享/交付，不扩大权限；share不存在→skill_share_not_found|`packages/application/src/skills-use-cases.ts:172-208` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-access.ts:81-102` (sha256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`)<br>`packages/application/src/skills-run.ts:18-35` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-04 / AC-M10-04-01, AC-M10-04-02 / TC-M10-04-*|
|BR-DEL-M10-05-01|资格：安装/升级/别名/启停要求项目manage且活动；只选准确发布版本，不自动选latest。|代数过期→skill_generation_conflict，安装集合不变；别名冲突/版本未授权→alias_conflict/delivery_blocked，不部分更新|`packages/application/src/skills-use-cases.ts:215-268` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-content.ts:12-19` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/persistence/drizzle/0036_skills.sql:29-38` (sha256 `6bba7f49d770b9306c5e1a45aa09c1f1e14170865d4eb92b37e09140e38a8afa`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-05 / AC-M10-05-01, AC-M10-05-02 / TC-M10-05-*|
|BR-DEL-M10-05-02|并发：base_generation为非负整数并严格匹配；同代数并发更新只一成功，成功每次generation+1。|代数过期→skill_generation_conflict，安装集合不变；别名冲突/版本未授权→alias_conflict/delivery_blocked，不部分更新|`packages/application/src/skills-use-cases.ts:215-268` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-content.ts:12-19` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/persistence/drizzle/0036_skills.sql:29-38` (sha256 `6bba7f49d770b9306c5e1a45aa09c1f1e14170865d4eb92b37e09140e38a8afa`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-05 / AC-M10-05-01, AC-M10-05-02 / TC-M10-05-*|
|BR-DEL-M10-05-03|例外：授权撤销后仅允许对既有安装保持原revision/alias并enabled=false；不能借停用请求窥选其他隐藏版本。|代数过期→skill_generation_conflict，安装集合不变；别名冲突/版本未授权→alias_conflict/delivery_blocked，不部分更新|`packages/application/src/skills-use-cases.ts:215-268` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-content.ts:12-19` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/persistence/drizzle/0036_skills.sql:29-38` (sha256 `6bba7f49d770b9306c5e1a45aa09c1f1e14170865d4eb92b37e09140e38a8afa`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-05 / AC-M10-05-01, AC-M10-05-02 / TC-M10-05-*|
|BR-DEL-M10-05-04|顺序与冲突：安装按alias排序；不同skill不能同alias；alias为≤64小写字母数字单连字符且避开设备保留名。|代数过期→skill_generation_conflict，安装集合不变；别名冲突/版本未授权→alias_conflict/delivery_blocked，不部分更新|`packages/application/src/skills-use-cases.ts:215-268` (sha256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`)<br>`packages/application/src/skills-content.ts:12-19` (sha256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`)<br>`packages/persistence/drizzle/0036_skills.sql:29-38` (sha256 `6bba7f49d770b9306c5e1a45aa09c1f1e14170865d4eb92b37e09140e38a8afa`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-05 / AC-M10-05-01, AC-M10-05-02 / TC-M10-05-*|
|BR-DEL-M10-06-01|项目：仅enabled安装进入清单；任一引用缺失/归档/撤销/外部资格不符即整份清单拒绝，不能悄悄丢项。|任何固定版本失去资格/hash不符→skill_delivery_blocked；claim时事务回滚，其后操作保持已有Run等待修复；目标已有固定快照/跨项目复制→revision_conflict/forbidden|`packages/application/src/skills-run.ts:8-83` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/application/src/task-service.ts:215-230` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/handover-use-cases.ts:398-402` (sha256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`)<br>`packages/application/src/execution-use-cases.ts:88-92` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-06 / AC-M10-06-01, AC-M10-06-02 / TC-M10-06-*|
|BR-DEL-M10-06-02|固定：Run保存generation和准确revision/alias/hash metadata；项目升级仅影响后续Run，不改旧Run。|任何固定版本失去资格/hash不符→skill_delivery_blocked；claim时事务回滚，其后操作保持已有Run等待修复；目标已有固定快照/跨项目复制→revision_conflict/forbidden|`packages/application/src/skills-run.ts:8-83` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/application/src/task-service.ts:215-230` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/handover-use-cases.ts:398-402` (sha256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`)<br>`packages/application/src/execution-use-cases.ts:88-92` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-06 / AC-M10-06-01, AC-M10-06-02 / TC-M10-06-*|
|BR-DEL-M10-06-03|重检：固定不是永久授权；下载、Session start、resume、handover restore/ready/activate再查当前grant，hash不符拒绝；handover禁止跨项目复制。|任何固定版本失去资格/hash不符→skill_delivery_blocked；claim时事务回滚，其后操作保持已有Run等待修复；目标已有固定快照/跨项目复制→revision_conflict/forbidden|`packages/application/src/skills-run.ts:8-83` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/application/src/task-service.ts:215-230` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/handover-use-cases.ts:398-402` (sha256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`)<br>`packages/application/src/execution-use-cases.ts:88-92` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-06 / AC-M10-06-01, AC-M10-06-02 / TC-M10-06-*|
|BR-DEL-M10-06-04|legacy：没有run_skill_manifest的历史Run解析为generation0空清单，从不套用当前项目安装。|任何固定版本失去资格/hash不符→skill_delivery_blocked；claim时事务回滚，其后操作保持已有Run等待修复；目标已有固定快照/跨项目复制→revision_conflict/forbidden|`packages/application/src/skills-run.ts:8-83` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/application/src/task-service.ts:215-230` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/handover-use-cases.ts:398-402` (sha256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`)<br>`packages/application/src/execution-use-cases.ts:88-92` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`apps/core-api/src/routes/skills.ts:7-65` (sha256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`)|REQ-DEL-M10-06 / AC-M10-06-01, AC-M10-06-02 / TC-M10-06-*|
|BR-DEL-M10-07-01|保护：拒绝摘要/路径/大小写/特殊文件及祖先链接冲突；本地受管文件增删改或额外目录均拒绝，未管理同名目录不能覆盖。|本地修改/未管理冲突/mutex→明确错误并保留原文件；manifest获取被授权撤销拒绝→不开始本机替换；回滚失败→保留恢复文件而不自动清除现场|`apps/cli/src/skill-sync.ts:135-199` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skill-sync.ts:205-307` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skills.ts:134-170` (sha256 `e617ea4e7b769d189b2431fa41252aacd6ef11ab0be18ca7f870f940f9fcea77`)|REQ-DEL-M10-07 / AC-M10-07-01, AC-M10-07-02 / TC-M10-07-*|
|BR-DEL-M10-07-02|锁与引导：mutex已存在拒绝；版本控制lock先到但整个managed root完全缺失可bootstrap，局部树缺失仍视修改而保护。|本地修改/未管理冲突/mutex→明确错误并保留原文件；manifest获取被授权撤销拒绝→不开始本机替换；回滚失败→保留恢复文件而不自动清除现场|`apps/cli/src/skill-sync.ts:135-199` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skill-sync.ts:205-307` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skills.ts:134-170` (sha256 `e617ea4e7b769d189b2431fa41252aacd6ef11ab0be18ca7f870f940f9fcea77`)|REQ-DEL-M10-07 / AC-M10-07-01, AC-M10-07-02 / TC-M10-07-*|
|BR-DEL-M10-07-03|运行控制：--check无写；仅同步.tsp/skills及lock，不改变平台选定版本、Agent配置或执行包内脚本；--run使用Run独立目录与固定清单。|本地修改/未管理冲突/mutex→明确错误并保留原文件；manifest获取被授权撤销拒绝→不开始本机替换；回滚失败→保留恢复文件而不自动清除现场|`apps/cli/src/skill-sync.ts:135-199` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skill-sync.ts:205-307` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skills.ts:134-170` (sha256 `e617ea4e7b769d189b2431fa41252aacd6ef11ab0be18ca7f870f940f9fcea77`)|REQ-DEL-M10-07 / AC-M10-07-01, AC-M10-07-02 / TC-M10-07-*|
|BR-DEL-M10-07-04|恢复：stage前后两次核验；替换异常反向rename原包及lock；回滚失败skill_sync_recovery_required保留旧内容stage与mutex，要求保留现场人工恢复。|本地修改/未管理冲突/mutex→明确错误并保留原文件；manifest获取被授权撤销拒绝→不开始本机替换；回滚失败→保留恢复文件而不自动清除现场|`apps/cli/src/skill-sync.ts:135-199` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skill-sync.ts:205-307` (sha256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`)<br>`apps/cli/src/skills.ts:134-170` (sha256 `e617ea4e7b769d189b2431fa41252aacd6ef11ab0be18ca7f870f940f9fcea77`)|REQ-DEL-M10-07 / AC-M10-07-01, AC-M10-07-02 / TC-M10-07-*|

## 完整场景与数据契约

### REQ-DEL-M10-01 规范技能包校验与草稿创建

参与者：来源团队成员或活动项目可写成员。触发：skill create提交目录/文件包。

前置条件：当前active且未删除用户，有来源写权；1至200普通文件，总解码字节≤6MiB，根SKILL.md存在且UTF-8。

主流程：规范化安全路径与Base64，拒绝重复/目录冲突/链接；校验文件字节大小/hash，按path字典序排列；解析根SKILL.md的name/description文本元数据；事务保存技能与revision1草稿、计算package_sha256及审计。

状态变化/保留：新Skill current_revision1、archived=false；新修订published_at为空。

数据契约：输入scope_type/team或project、scope_code、files[{path,content_base64,size_bytes?,sha256?}]；输出规范files/size_bytes/package_sha256/name/description；HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。。

验收标准：AC-M10-01-01 合法规范技能包保存为可追溯未发布草稿。；AC-M10-01-02 不安全或超过限制的技能包在持久化前被整体拒绝。。

### REQ-DEL-M10-02 技能目录、版本可见性与授权读取

参与者：来源成员、接收团队成员或目标项目成员。触发：skill catalog/search/show/list及Web目录。

前置条件：目录只选一个team/project范围且当前有对应访问权；详情请求显式传project_code时，lockSkillReadScopes先要求项目存在且actor具有该项目当前read，不论是否有独立source.read；通过请求scope资格后才按source.read优先选版本，无source.read再按目标交付资格选择。未传project可独立使用来源读取权。。

主流程：按owned/available/shared视图选取来源或接收技能；详情如传project，先核对该项目存在及当前读权，再计算source.read并优先返回来源可见修订；没有source.read才按目标share/安装交付资格；非自有项目目录另行过滤：普通项目成员仅安装的获准发布版本，管理者可发现获准升级版；显式项目请求读资格通过后，详情来源分支不被目录的安装版本过滤收窄；安装列表普通读者available_revisions仅当前获准安装版本；返回可见摘要/详情版本并过滤关键词。

状态变化/保留：只读，无修改技能修订/共享/安装。

数据契约：视图owned/available/shared；summary.current_revision为可见最新，published_revision/available_revisions亦限可见范围；shares仅来源manager可见；HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。。

验收标准：AC-M10-02-01 无独立来源权限的普通接收者只能读取安装交付版本；来源非作者也不见草稿。；AC-M10-02-02 在无来源权限的目标分支，升级发现由项目管理者持有，且发现新版不自动升级。；AC-M10-02-03 显式project请求先要求该项目当前read；通过后来源权限优先决定详情版本，无项目权的来源读者不能借source.read绕过请求scope资格。。

### REQ-DEL-M10-03 技能修订、明确发布与归档恢复

参与者：来源作者或管理者修订；来源管理者发布/归档。触发：skill revise/publish/archive --restore。

前置条件：当前来源维护权有效；修订技能未归档且base_revision当前；发布指定已存在修订；归档参数明确boolean。

主流程：锁来源scope及技能，重查作者/管理权；修订创建新不可变包版本并推进current_revision；管理者发布指定修订，重复发布已发布修订不重复写发布审计；管理者归档/恢复保留所有历史。

状态变化/保留：revise current_revision+1；publish只设指定修订published_at；archive/unarchive标记及审计。

数据契约：base_revision/files/change_summary；publish.revision；archive.archived；包hash随新版本而非覆盖旧版；HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。。

验收标准：AC-M10-03-01 技能新修订保持发布历史不可变，发布和归档均受来源管理权约束。；AC-M10-03-02 目标管理权不赋予来源技能发布或归档权。。

### REQ-DEL-M10-04 精确版本共享、项目交付资格与撤销

参与者：来源管理者；接收团队/项目按当前资格使用。触发：skill share/revoke及交付校验。

前置条件：技能未归档；目标scope存在且不是来源自身；共享列表1至200个已发布正整数修订。

主流程：版本去重升序并明确allow_projects/allow_external（默认false）；按目标团队或项目保存精确授权；完全相同未撤销授权重放不新增；交付时独立判断项目资格、外部活跃成员及版本授权；撤销授权阻止后续字节交付/新执行，保留历史及已下载副本。

状态变化/保留：新增或撤销share，不修改原包字节；历史安装可保留blocked状态。

数据契约：target_type/target_code/revisions[]/allow_projects/allow_external；revoked_at/by；外部资格依据active未删除项目成员/owner是否有当前团队角色；HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。。

验收标准：AC-M10-04-01 团队发现、项目采用与外部成员交付需要各自明确授权。；AC-M10-04-02 项目已启用团队技能后加入未获外部交付授权的成员，会阻止后续清单交付且保留安装元数据。。

### REQ-DEL-M10-05 项目技能安装、升级、别名及受限停用

参与者：活动项目管理者。触发：skill install/update/disable或更新项目采用集。

前置条件：输入当前base_generation、准确revision、合法alias及明确enabled；技能修订存在且交付资格有效，受限停用例外。

主流程：锁项目与安装集合generation；校验准确版本授权及项目内别名唯一；upsert项目/技能安装并generation+1；返回安装状态、blocked原因和管理者获授权升级版本。

状态变化/保留：安装upsert并generation+1；停用不删除历史安装；项目升级不改已固定Run。

数据契约：revision/alias/enabled/base_generation；输出generation/installations[].blocked/blocked_reason/available_revisions；HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。。

验收标准：AC-M10-05-01 安装集合使用代数防止过期写覆盖其他修改。；AC-M10-05-02 撤销后允许原版本原别名停用，不能借停用改变未授权版本。。

### REQ-DEL-M10-06 项目与Run固定技能清单、继承及当前授权重检

参与者：当前项目可读用户；领取/交接/启动Run的执行者。触发：读取project/run manifest及capture/copy。

前置条件：当前项目访问有效；所有被交付版本当前grant有效；Run属于项目；固定hash和已发布包一致。

主流程：项目清单按alias读取enabled安装及准确文件；claim事务固定metadata清单至Run；后续Run读取按固定修订取字节并核对package hash及当前授权；handover复制源Run同一固定清单；legacy无快照显式空。

状态变化/保留：一次capture或copy固定Run metadata；只读解析不修改已固定版本。

数据契约：ProjectSkillManifest包含project_code/generation/skills[].files；Run metadata去除files但保留hash与版本；下载按固定版本恢复字节；HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。。

验收标准：AC-M10-06-01 Run清单固定原版本，legacy Run保持空且不跟随项目升级。；AC-M10-06-02 固定Run仍在交付和启动时重查当前授权。。

### REQ-DEL-M10-07 本机技能清单检查、受管同步与失败恢复

参与者：当前项目/Run清单可读的本机CLI操作者。触发：skill manifest/sync，可用--check或--run。

前置条件：目标为普通本机工作区，manifest全部路径/别名/摘要已校验；同步目录及所有祖先不是symlink/junction；本机受管文件未修改。

主流程：全量校验清单再读取本机lock和受管树；check报告add/update/remove且不写；真实同步独占mutex；先stage新文件与lock，重查本机树后替换受管包与lock；失败只回滚本次移动路径；回滚不成保留stage和mutex要求人工恢复。

状态变化/保留：成功替换受管包及skills.lock.json；check不变更；失败恢复原树或明确保留人工恢复现场。

数据契约：lock format1/project_code/generation/skills摘要；结果check/changed/added/updated/removed/directory/lock_path；包字节完全按已验清单。

验收标准：AC-M10-07-01 检查和同步分别提供无写预览及准确受管替换，重复同步保持一致。；AC-M10-07-02 本地修改导致同步拒绝并保留现场。。

## 计划测试矩阵（未执行）

|用例 / 优先级 / 状态|BR / REQ / AC|独立种子、Actor及权限|动作|可观察断言|
|---|---|---|---|---|
|TC-M10-01-01 / P1建议 / not_run|BR-DEL-M10-01-01, BR-DEL-M10-01-02, BR-DEL-M10-01-03, BR-DEL-M10-01-04, BR-DEL-M10-01-05 / REQ-DEL-M10-01 / AC-M10-01-01|执行前独立重置；活动来源团队成员A；新合法包有SKILL.md和references/a.txt，字节及hash已知|创建技能并下载r1；对照规范path顺序和package_sha256|revision1草稿、作者A，文件字节/摘要匹配且无脚本执行|
|TC-M10-01-02 / P1建议 / not_run|BR-DEL-M10-01-01, BR-DEL-M10-01-02, BR-DEL-M10-01-03, BR-DEL-M10-01-04, BR-DEL-M10-01-05 / REQ-DEL-M10-01 / AC-M10-01-02|执行前独立重置；独立来源可写A；分别准备../x路径、大小写冲突及6MiB+1包|每次独立提交非法包并查询新记录数|每次skill_invalid，无Skill/修订部分记录|
|TC-M10-02-01 / P1建议 / not_run|BR-DEL-M10-02-01, BR-DEL-M10-02-02, BR-DEL-M10-02-03, BR-DEL-M10-02-04 / REQ-DEL-M10-02 / AC-M10-02-01|执行前独立重置；未来隔离种子须建设，not_run：来源作者A、普通来源成员B；目标普通成员C/管理者O均无任何source scope read；技能发布r1、草稿r2；目标只安装r1且明确授权该版本交付；当前身份均有效|B以来源身份读取详情；目标-only C在project上下文读取详情并检查版本/摘要；O查看项目可用修订|B/C只见发布r1及相应可见计数，C不能见来源草稿；A来源作者权独立保留，不套用C的目标-only期待|
|TC-M10-02-02 / P1建议 / not_run|BR-DEL-M10-02-01, BR-DEL-M10-02-02, BR-DEL-M10-02-03, BR-DEL-M10-02-04 / REQ-DEL-M10-02 / AC-M10-02-02|执行前独立重置；未来独立种子须建设，not_run：目标P安装r1且enabled，r1/r3均已明确授权向P及其成员交付；普通C和项目管理者O均无source.read；r2仍草稿|分别查询P的安装列表及非自有available目录；以C/O读取项目上下文详情|C只发现/读取安装r1；O可发现获授权发布r3，双方都不能读r2；平台安装仍r1|
|TC-M10-02-03 / P1建议 / not_run|BR-DEL-M10-02-01, BR-DEL-M10-02-02, BR-DEL-M10-02-03, BR-DEL-M10-02-04 / REQ-DEL-M10-02 / AC-M10-02-03|执行前独立重置；未来受控种子尚待建设，not_run：来源T1技能发布r1/r3、草稿r2；P属T2且安装r1、enabled、grant授权r1/r3及外部交付；S为T1普通成员兼P普通成员；A为来源作者且有P读权；目标-only C无source.read；另N为active T1普通成员但非T2成员、P成员或owner，P对N无继承或其他当前read；所有身份/设备有效|S以project=P读详情及P非自有catalog/安装列表；A/C分别以project=P读详情；独立比较N：先不传project读取同一技能详情，再显式project=P读取；记录响应是否包含任何文件字节；比较版本集合、拒绝结果及安装状态|S详情r1/r3且非自有catalog/安装升级集合仍限r1；A可见r2草稿，C只r1；N不传project可读来源发布r1/r3，传P则project_forbidden且不下发字节；安装仍r1|
|TC-M10-03-01 / P1建议 / not_run|BR-DEL-M10-03-01, BR-DEL-M10-03-02, BR-DEL-M10-03-03 / REQ-DEL-M10-03 / AC-M10-03-01|执行前独立重置；来源作者A与管理者O；技能r1已发布且未归档|A用base1修订成r2；O发布r2两次；O归档后尝试新修订，再恢复归档|r1字节不变，r2明确发布；重复发布不新增发布事件；归档拒绝写且历史仍可读，恢复保留版本|
|TC-M10-03-02 / P1建议 / not_run|BR-DEL-M10-03-01, BR-DEL-M10-03-02, BR-DEL-M10-03-03 / REQ-DEL-M10-03 / AC-M10-03-02|执行前独立重置；目标项目管理者M仅有交付权，无来源scope权；技能已共享安装|M尝试发布或归档该技能|skill_forbidden；来源标记/修订/审计保持|
|TC-M10-04-01 / P1建议 / not_run|BR-DEL-M10-04-01, BR-DEL-M10-04-02, BR-DEL-M10-04-03, BR-DEL-M10-04-04 / REQ-DEL-M10-04 / AC-M10-04-01|执行前独立重置；来源管理者O；团队技能r1发布；目标外团队项目P含active外部成员；无share|先创建默认team share并尝试P采用；另创建明确r1、allow_projects=true、allow_external=true的目标team share；重试采用并撤销该share后请求manifest|默认交付拒绝；明确授权允许精确r1；撤销后manifest拒绝，包历史和本机已下载副本仍留存|
|TC-M10-04-02 / P1建议 / not_run|BR-DEL-M10-04-01, BR-DEL-M10-04-02, BR-DEL-M10-04-03, BR-DEL-M10-04-04 / REQ-DEL-M10-04 / AC-M10-04-02|执行前独立重置；未来隔离种子须建设，not_run：活动同团队项目P初无外部active成员；团队技能S r1已发布；明确存在ProjectSkillInstallation(project=P,skill=S,revision=1,alias=review,enabled=true)，generation=3；active请求者C仍有P读权；没有任何显式allow_external授权；外部用户X active且无来源团队角色|C先请求manifest，确认包含S r1/alias review/generation3作为基准；保持此顺序场景，增加X为P的active项目成员且不授予团队角色或技能share；C再请求同一project manifest并读取安装集合元数据|基准清单明确包含S r1；新增外部成员后整份manifest返回skill_delivery_blocked而非空清单/静默跳项；安装仍enabled r1、generation3，已下载副本不承诺回收|
|TC-M10-05-01 / P1建议 / not_run|BR-DEL-M10-05-01, BR-DEL-M10-05-02, BR-DEL-M10-05-03, BR-DEL-M10-05-04 / REQ-DEL-M10-05 / AC-M10-05-01|执行前独立重置；项目管理者O；generation3，已安装A r1 alias=a；r2已获授权；另技能B alias=b|以base_generation3把A升级r2；再次使用base3更改B|A r2且generation4；第二请求generation_conflict，B不变|
|TC-M10-05-02 / P1建议 / not_run|BR-DEL-M10-05-01, BR-DEL-M10-05-02, BR-DEL-M10-05-03, BR-DEL-M10-05-04 / REQ-DEL-M10-05 / AC-M10-05-02|执行前独立重置；独立项目generation4，A r1 alias=a已失去grant|保持r1/a停用A；重置后尝试以隐藏r2/a停用|前者成功generation5且enabled=false；后者delivery_blocked并保持原安装|
|TC-M10-06-01 / P1建议 / not_run|BR-DEL-M10-06-01, BR-DEL-M10-06-02, BR-DEL-M10-06-03, BR-DEL-M10-06-04 / REQ-DEL-M10-06 / AC-M10-06-01|执行前独立重置；项目安装A r1 generation1，写成员B；新任务可领取；另有无技能快照的legacy Run L|领取新Run R并读取manifest；项目管理者升级A r2后再次读取R和L|R仍r1/hash原值；L generation0/skills=[]；后续新Run才r2|
|TC-M10-06-02 / P1建议 / not_run|BR-DEL-M10-06-01, BR-DEL-M10-06-02, BR-DEL-M10-06-03, BR-DEL-M10-06-04 / REQ-DEL-M10-06 / AC-M10-06-02|执行前独立重置；独立R固定跨团队A r1且当前share有效；可用设备D|撤销A r1的唯一share；请求R manifest并尝试Session start|均delivery_blocked且没有新增Session；旧Run元数据不改写|
|TC-M10-07-01 / P1建议 / not_run|BR-DEL-M10-07-01, BR-DEL-M10-07-02, BR-DEL-M10-07-03, BR-DEL-M10-07-04 / REQ-DEL-M10-07 / AC-M10-07-01|执行前独立重置；本机独立普通工作区，已受管A r1未修改且lock正确；授权manifest要求A r2与新增B|sync --check并比较完整目录hash；sync后核对包/lock；再次sync|check只报告不写；真实同步字节/hash与manifest匹配；再次无差异；不执行包脚本|
|TC-M10-07-02 / P1建议 / not_run|BR-DEL-M10-07-01, BR-DEL-M10-07-02, BR-DEL-M10-07-03, BR-DEL-M10-07-04 / REQ-DEL-M10-07 / AC-M10-07-02|执行前独立重置；独立受管A r1；手工修改A文件；manifest要求r2|sync并读取错误和文件hash|skill_local_modified，手改内容/旧lock保持，不覆盖；需操作者先处理本地修改|

## 现有测试证据及限制

- REQ-DEL-M10-01：`packages/application/tests/skills.test.mjs` — package validation fixes hashes and rejects traversal, case collisions, malformed metadata and oversize；defined / not_run。
- REQ-DEL-M10-02：`packages/application/tests/skills.test.mjs` — published files are immutable, revisions conflict correctly and hidden drafts do not leak newest counters；defined / not_run。
- REQ-DEL-M10-03：`packages/application/tests/skills.test.mjs` — archive blocks delivery without deleting published history; role downgrade invalidates maintenance；defined / not_run。
- REQ-DEL-M10-04：`packages/application/tests/skills.test.mjs` — team shares default to discovery only; project use and external membership require explicit policy；defined / not_run。
- REQ-DEL-M10-05：`packages/application/tests/skills.test.mjs` — installation optimistic generation serializes concurrent updates and explicit aliases prevent collisions；defined / not_run。
- REQ-DEL-M10-06：`packages/application/tests/skills-run.test.mjs` — claim pins exact skill bytes and metadata; project upgrades affect only subsequent Runs；defined / not_run。

## 未决风险和未检查项

- REQ-DEL-M10-01：公共HTTP边界仅静态核对：未执行请求预算、Fastify schema/额外字段处理、错误形状或legacy配置组合验证；认证通道策略见身份模块，不能把允许legacy的开发配置说成仅设备凭据。
- REQ-DEL-M10-07：未执行真实文件替换或故障注入；跨平台rename和断电时恢复有效性未实测。
- 远端Git/HTTP/数据库/本机文件权限及真实Actor运行期结果未执行验证；无性能或恢复时限SLO推断。
- 没有把文档提议当作已实现目标；源中缺少入口不是全产品不存在的证明。
