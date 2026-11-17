# TeamSynergy：系统上下文与角色

> 性质：全项目当前实现的逆向规格草稿。代码事实、文档目标、分析推断与未验证项分开；不是业务批准或已执行验收。
> 日期：2026-11-10。Run NSG3TKRB16Y9F6Y203WB；显式工作区草稿；base commit 92728fbec04cfa34fee4421cb0a9319d1b755164。
> Snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；Skill 2.2.0。输入为675份固定源码/产品资料及1份知识投影。
> 图谱负责导航，最终规则回查原始源码；历史实验稿不作为本轮功能事实权威。14业务章节与已有平台模块身份的映射可多对一。
> 分析产物SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8；代码manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；候选输入manifest c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e。
> 插件版本：ua 2.9.8, codegraph 1.6.2；适配器及runtime摘要保存在已捕获的code-knowledge.json。

## 系统上下文

共享控制面管理项目事实；本机执行面管理代码、进程与索引。Web、普通tsp CLI、Core API、业务用例、PostgreSQL是主要组件；服务器巡检有只读数据库例外。新代码理解流程在分析成功后仍需显式选择视图，不覆盖历史知识。

## 外部系统

外部边界包括Git仓库、本机文件系统、PostgreSQL、已配置的模型引擎和操作者浏览器。代码理解的语义由当前Agent完成；系统原生文档修改稿可由另一个受限作业运行时生成，两者不能混为一个自动全仓分析服务。外部模型真实质量与网络结果本轮未测。

## 用户角色

团队角色、项目继承/覆盖、任务承担人、Profile和系统管理员分别承担不同权限。全局管理员不应被文字概括为客户正文的无限访问主体；具体已有管理端权限见M13，未来客户支持授权还不能当作已实施策略。

## 关键场景

完整正常与异常场景在下列14章逐项展开。涉及未知目标的内容明确待确认，未执行的计划不进入通过统计。

| 章节 | 业务范围 | 结构化需求数 | 主要平台父模块键 | 主要规则文档键 | 单条需求导航例外（实际父关系） |
| --- | --- | ---: | --- | --- | --- |
| M01 | 身份、会话与账号生命周期 | 11 | GOV-M01 | GOV-M01-RULES | 无 |
| M02 | 团队、项目与权限治理 | 8 | tsp-module-collaboration | GOV-M02-RULES | 无 |
| M03 | 项目结构与首页 | 6 | tsp-module-collaboration | GOV-M03-RULES | tsp-req-home-binding → tsp-module-documents / tsp-doc-documents |
| M04 | 需求发现、决策与评审 | 5 | tsp-module-collaboration | GOV-M04-RULES | 无 |
| M05 | 需求文档、结构化需求与基线 | 7 | tsp-module-collaboration | GOV-M05-RULES | 无 |
| M06 | 任务执行与 Run | 10 | tsp-module-collaboration | tsp-doc-collaboration | 无 |
| M07 | 交接恢复与本机工作空间 | 10 | tsp-module-workspace | tsp-doc-workspace | 无 |
| M08 | 项目资料与设计资产 | 8 | tsp-module-documents | tsp-doc-documents | 无 |
| M09 | 测试与缺陷 | 5 | DEL-M09 | DEL-M09-RULES | 无 |
| M10 | 技能版本与交付 | 7 | DEL-M10 | DEL-M10-RULES | 无 |
| M11 | 代码与资料接入、规则化需求生产 | 8 | tsp-module-intake | tsp-doc-intake | 无 |
| M12 | 系统文档 Agent 修改稿 | 6 | INT-MODULE-M12 | INT-DOC-M12 | 无 |
| M13 | 平台治理与运维 | 13 | INT-MODULE-M13 | INT-DOC-M13 | 无 |
| M14 | 项目代码理解与插件知识 | 8 | INT-MODULE-M14 | INT-DOC-M14 | 无 |

## 运行约束

平台版本、项目/仓库身份、源码快照与每次分析产物版本分开。原始代码留本机的承诺针对代码理解来源；Task/Run的历史workspaces.path接口仍会保存工作区定位，不能泛化为所有本机路径绝不进入服务。跨仓关系必须有依据，本轮只分析一个仓库。

## 来源索引

- README.md:7-25 (SHA-256 e184bee4116f2e9a8a39f3380746f563bcafbe73effc6b947e63b29dbe6ae900)
- apps/core-api/src/server.ts:58-79 (SHA-256 3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada)
- scripts/deploy-runtime.ps1:7-25 (SHA-256 08f61ec5fd1357d742b1cf324022b489a5e055884e30f6e0940aad61ab8b8a55)
- scripts/backup-database.ps1:13-25 (SHA-256 d075d59168bd29f39b9e073bd69bd78a2fbf51ae8cb9b80aa109f97ac316ffd8)
- packages/persistence/src/db.ts:39-56 (SHA-256 c75d60506a2a31687fb7484fab4dc3e7abc5db26aee0c8fcd72e0437b9d6915a)
- apps/core-api/src/metrics.ts:51-67 (SHA-256 71530541540cb0c55d057450e4a38c0999ec4ad294c3be04ef29b5c859c3a5be)
- apps/core-api/src/security-headers.ts:4-16 (SHA-256 e813b19fa0ef575830b8a47afccb830087f9942d4a8e0e8ad2bd3228f84542d4)
- apps/web/security-headers.mjs:2-14 (SHA-256 83cf612dc0a27a843b8aa4a9da92398c358224dcb4add564f78495b04c484a0a)
- apps/core-api/src/auth.ts:125-130 (SHA-256 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8)
- apps/core-api/src/auth.ts:25-34 (SHA-256 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8)
- docs/ops/runbook.md:3-18 (SHA-256 a5b05ba062ca88580fb620547d89b6d4ad0562399607cf04a784a3fc3f9475cf)
- docs/ops/runbook.md:44-53 (SHA-256 a5b05ba062ca88580fb620547d89b6d4ad0562399607cf04a784a3fc3f9475cf)
- apps/cli/src/db-plan-tenants.ts:4-23 (SHA-256 eddd756cfbbb85b73a3e686e5adfac09a10f478dab717b550995154d09dea6bb)
- packages/persistence/src/tenant-inventory-catalog.ts:2-10 (SHA-256 364db9ab615d42345226f2339b300bede6d42b717b0fbd324d9aa6fbb73c16c6)
- packages/domain/src/task-state-machine.ts:17-29 (SHA-256 2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26)
- packages/contracts/src/schemas.ts:81-83 (SHA-256 7b6e3612dd96c833a0cc802c582c400c81ec7fac6cd8ffc8b6ba0a77c76349f2)
- packages/application/src/user-use-cases.ts:80-119 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/user-use-cases.ts:125-154 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/user-use-cases.ts:231-259 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/auth-device.ts:75-80 (SHA-256 3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9)
- packages/application/src/team-use-cases.ts:48-64 (SHA-256 ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2)
- packages/application/src/team-use-cases.ts:35-38 (SHA-256 ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2)
- packages/application/src/team-use-cases.ts:148-187 (SHA-256 ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2)
- packages/application/src/project-structure-use-cases.ts:146-177 (SHA-256 040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13)
- packages/application/src/intake-entity-writers.ts:23-33 (SHA-256 bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696)
- packages/application/src/project-use-cases.ts:90-138 (SHA-256 e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6)
- packages/application/src/intake-entity-writers.ts:35-47 (SHA-256 bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696)
- packages/application/src/requirement-collaboration-use-cases.ts:164-200 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-collaboration-use-cases.ts:204-221 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-collaboration-use-cases.ts:240-263 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-collaboration-use-cases.ts:382-406 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-document-use-cases.ts:75-112 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/requirement-document-use-cases.ts:206-245 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/requirement-document-use-cases.ts:368-451 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/requirement-document-use-cases.ts:384-413 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/task-service.ts:234-323 (SHA-256 54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f)
- packages/application/src/task-service.ts:570-591 (SHA-256 54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f)
- packages/application/src/project-use-cases.ts:359-527 (SHA-256 e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6)
- apps/core-api/src/routes/tasks.ts:122-149 (SHA-256 5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa)
- apps/cli/src/project-workspace.ts:23-85 (SHA-256 aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143)
- apps/cli/src/project-binding.ts:37-95 (SHA-256 355a4849a0840b43c797ba0466f462a4a67a14ff55a0c089d505fd1f5ae71871)
- apps/cli/src/project-workspace.ts:98-151 (SHA-256 aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143)
- apps/cli/src/project-workspace.ts:155-244 (SHA-256 aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143)
- packages/application/src/project-document-use-cases.ts:193-250 (SHA-256 bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317)
- packages/application/src/project-document-use-cases.ts:428-510 (SHA-256 bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317)
- packages/application/src/project-document-use-cases.ts:252-355 (SHA-256 bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317)
- packages/application/src/project-document-folders.ts:1-77 (SHA-256 c50e6f6a5c975a8ef69e9f9bbb981177d8ff038d46f3fc54a778b92c5be5974b)
- packages/application/src/testing-use-cases.ts:24-65 (SHA-256 370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858)
- packages/application/src/testing-use-cases.ts:67-169 (SHA-256 370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858)
- packages/application/src/testing-content.ts:22-51 (SHA-256 7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7)
- packages/application/src/testing-content.ts:70-86 (SHA-256 7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7)
- packages/application/src/skills-content.ts:5-95 (SHA-256 4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983)
- packages/application/src/skills-use-cases.ts:112-128 (SHA-256 3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6)
- packages/application/src/skills-use-cases.ts:37-110 (SHA-256 3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6)
- packages/application/src/skills-access.ts:54-74 (SHA-256 3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d)
- apps/cli/src/intake.ts:55-125 (SHA-256 5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a)
- apps/cli/src/intake-materials.ts:1-145 (SHA-256 2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70)
- apps/cli/src/intake-code-knowledge.ts:14-68 (SHA-256 274697e231e69c7286ea79379446c6f1b7e166d0e6a9ad8e6c03a08a29db682a)
- apps/cli/src/intake-materials.ts:146-169 (SHA-256 2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70)
- packages/application/src/system-agent-use-cases.ts:139-174 (SHA-256 fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148)
- apps/core-api/src/routes/system-agent.ts:6-18 (SHA-256 629772266060f896c2be9803c00f7e15555071269067b51675106679ae6e2829)
- packages/application/src/system-agent-use-cases.ts:219-280 (SHA-256 fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148)
- packages/application/src/system-agent-use-cases.ts:312-322 (SHA-256 fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148)
- packages/application/src/admin-governance-use-cases.ts:12-102 (SHA-256 5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a)
- apps/core-api/src/routes/admin-governance.ts:8-23 (SHA-256 81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3)
- packages/application/src/admin-governance-use-cases.ts:105-159 (SHA-256 5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a)
- apps/core-api/src/routes/admin-governance.ts:24-48 (SHA-256 81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3)
- apps/cli/src/code-understanding-plugins.ts:90-154 (SHA-256 71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1)
- apps/cli/src/code-understanding.ts:101-128 (SHA-256 d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4)
- apps/cli/src/code-understanding-snapshot.ts:26-112 (SHA-256 4699f4308d3e615009be35781c8b52029569dc2f73371d9c490ff639dc2980e9)
- apps/cli/src/code-understanding.ts:130-164 (SHA-256 d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4)
