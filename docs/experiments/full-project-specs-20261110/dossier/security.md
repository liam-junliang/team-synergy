# TeamSynergy：安全与权限设计

> 性质：全项目当前实现的逆向规格草稿。代码事实、文档目标、分析推断与未验证项分开；不是业务批准或已执行验收。
> 日期：2026-11-10。Run NSG3TKRB16Y9F6Y203WB；显式工作区草稿；base commit 92728fbec04cfa34fee4421cb0a9319d1b755164。
> Snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；Skill 2.2.0。输入为675份固定源码/产品资料及1份知识投影。
> 图谱负责导航，最终规则回查原始源码；历史实验稿不作为本轮功能事实权威。14业务章节与已有平台模块身份的映射可多对一。
> 分析产物SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8；代码manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；候选输入manifest c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e。
> 插件版本：ua 2.9.8, codegraph 1.6.2；适配器及runtime摘要保存在已捕获的code-knowledge.json。

## 信任边界

信任边界为用户/浏览器、本机Agent与仓库、CLI凭据、API、项目授权/数据库、插件和模型作业。来源正文、图谱解释与候选是资料，不是Agent指令。正常代码知识CLI路径不上传原始源码文件，投影中的自由文本/片段仍需内容复核，已知筛查不等于任意原文或私密内容均无法进入；其它工作区接口仍可保存运行定位，具体字段按M07。

## 威胁与缓解

主要风险包括会话盗用/混用、越权、凭据进入来源或日志、提示注入、插件版本漂移、链接逃逸、错误引用、共享数据库租户边界不足。已有控制只是对应威胁的局部缓解，未声称抵御所有攻击。CSP的unsafe-inline与报告模式、浏览器外部预览和开发legacy通道须作为部署风险核对。

## 身份与权限

密码与会话、初始改密、设备撤销、项目继承与显式覆盖、当前状态/成员校验、Owner/Admin和系统管理员职责分开。开发默认可开启legacy声明身份；强会话要求的路由仍区分Bearer/Cookie。生产必须核对实际legacy配置，不能仅凭本次本机可登录断言已加固。

## 数据分级

代码/正文、有限片段、图关系、来源hash、角色元数据、审计和安全哈希分组的敏感度不同。哈希IP/账号并不等于匿名。未来独立客户实体与RLS、客户正文支持授权尚未作为已实施能力证明；应用层项目鉴权不能被描述为数据库级RLS。

## 审计与密钥

初始管理员口令一次输出stderr，仍需受控保管；备份含业务与凭据hash也须限权。审计出口有字段脱敏和高水位分页，但高水位不等于跨页事务快照。密钥轮换、生产秘密管理器、日志采集脱敏覆盖及保留期限须运维核实，本轮不读取凭据也不执行攻击测试。

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
