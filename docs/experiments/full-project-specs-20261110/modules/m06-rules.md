# M06 任务执行与 Run：业务规则与需求

## 来源与解释边界

固定run `NSG3TKRB16Y9F6Y203WB` revision4，project `19Q4K7PDARXQ9JHW6R6F`，repository `P1KRPDABN4RD0YXMX64E`，namespace `source-04d73353-be80-4433-8c5e-0b49a9c12c63`，snapshot `06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa`，DRAFT commit `92728fbec04cfa34fee4421cb0a9319d1b755164`，源码manifest `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`，混合接入manifest `c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e`。分支名称不作版本证明。UA供业务导航，codegraph供符号导航，以下判断均回到固定原始源码。

发布知识artifact SHA256 `691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8`；UA 2.9.8 adapter1.0.0 digest `d22a4a731809299030ee783710407af1e4ce37d5f1930345cb1d4b6a8cfb39a5`；codegraph 1.6.2 adapter1.0.0 digest `c7ce675c6c763726449fccb22159735859ad17eccbce1475c9617287479bf8da`；protocol1。发布交接仅包含12043节点中的前100且truncated=true、complete_repository_analysis=false，不能将未返回节点解释为不存在。

实际查询：UA overview及“任务执行/交接/测试/技能”search；relations来自返回节点 `ua:flow:cross-person-handover`、`ua:flow:test-execution-defect`、`ua:flow:skill-publish-share-install`，图边与evidence_ids保存在本次query-delivery-ua-*.json导航记录；native CG context从相同run返回claim/verify/submit、Git交接、testing与Run skills符号。图推断不代替下表原始证据。

assessment=observed_in_code仅描述实现；不代表产品预期、业务批准、运行期验收通过。现有测试标为defined，以下验证全部未执行。每个测试场景从独立种子/身份/权限开始，跨步骤继承只在该场景内明确列出。

## 角色、入口、实体与范围

任务看板、详情与依赖审计查询；创建带来源及依赖的任务合同；按当前状态修改合同或取消、首次绑定需求基线；分派与失败任务返工重入；领取任务与独立验证Run；自测证据与产物提交；验证、失败退回与管理关闭；本机领取、外部工作区附着与上下文失败恢复；设备租约、会话启动幂等与状态写入；本机Agent托管、停止、同步与租约丢失保护。

## 规则及双向追溯

|稳定业务规则|资格/选择/运行控制与结果|异常或保留状态|来源|REQ / AC / 计划用例|
|---|---|---|---|---|
|BR-DEL-M06-01-01|资格：不可见项目或无效身份返回空列表/空图，详情拒绝访问；不能凭任务编码越权。|非法分页值→validation_failed；不改变任务；无项目访问权→列表/图为空，详情 project_forbidden|`packages/application/src/task-service.ts:234-323` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:570-591` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:659-742` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`apps/core-api/src/routes/tasks.ts:77-120` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-01 / AC-M06-01-01, AC-M06-01-02 / TC-M06-01-*|
|BR-DEL-M06-01-02|选择/顺序：列表以 created_at DESC、id DESC 排序；limit 默认50且为1至500整数，offset为0至2147483647整数。|非法分页值→validation_failed；不改变任务；无项目访问权→列表/图为空，详情 project_forbidden|`packages/application/src/task-service.ts:234-323` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:570-591` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:659-742` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`apps/core-api/src/routes/tasks.ts:77-120` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-01 / AC-M06-01-01, AC-M06-01-02 / TC-M06-01-*|
|BR-DEL-M06-01-03|运行控制：完成/取消时间从对应审计事件取最新时间；有固定需求修订时详情保留该修订，并提示当前源是否变化。|非法分页值→validation_failed；不改变任务；无项目访问权→列表/图为空，详情 project_forbidden|`packages/application/src/task-service.ts:234-323` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:570-591` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:659-742` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`apps/core-api/src/routes/tasks.ts:77-120` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-01 / AC-M06-01-01, AC-M06-01-02 / TC-M06-01-*|
|BR-DEL-M06-02-01|资格：非ad-hoc来源仅项目管理者可创建；ad-hoc允许可写成员；viewer不允许。|无验收标准或依赖缺失/跨项目→拒绝创建，不留下任务及依赖；基线不含需求/修订无效→拒绝该事务|`packages/application/src/project-use-cases.ts:359-527` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:122-149` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-02 / AC-M06-02-01, AC-M06-02-02 / TC-M06-02-*|
|BR-DEL-M06-02-02|关联：defect-fix必须绑定同Feature缺陷；其他来源携带defect_code拒绝；依赖必须存在且同项目。|无验收标准或依赖缺失/跨项目→拒绝创建，不留下任务及依赖；基线不含需求/修订无效→拒绝该事务|`packages/application/src/project-use-cases.ts:359-527` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:122-149` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-02 / AC-M06-02-01, AC-M06-02-02 / TC-M06-02-*|
|BR-DEL-M06-02-03|基线：选择需求基线要求活动项目的有效管理者；关联需求必须包含于该基线；固定基线需求修订并不跟随今日需求文档头。|无验收标准或依赖缺失/跨项目→拒绝创建，不留下任务及依赖；基线不含需求/修订无效→拒绝该事务|`packages/application/src/project-use-cases.ts:359-527` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:122-149` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-02 / AC-M06-02-01, AC-M06-02-02 / TC-M06-02-*|
|BR-DEL-M06-02-04|运行控制：任务/依赖/审计在创建事务内保存；创建不代表已分派或启动。|无验收标准或依赖缺失/跨项目→拒绝创建，不留下任务及依赖；基线不含需求/修订无效→拒绝该事务|`packages/application/src/project-use-cases.ts:359-527` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:122-149` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-02 / AC-M06-02-01, AC-M06-02-02 / TC-M06-02-*|
|BR-DEL-M06-03-01|资格：只有管理者可改合同、绑定基线和取消；合同必须保留非空标题与验收标准。|运行中、存在Run的基线重绑、版本过期→返回对应locked/started/mismatch，保存旧合同；基线缺需求或固定修订不符→baseline_requirement_missing或baseline_revision_mismatch|`packages/application/src/task-service.ts:966-1096` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:366-379` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-baseline-use-cases.ts:11-61` (sha256 `cb7014fb111f34118d49d0393e0bec1c9031f6a4c99f91b6c2ca4b76b8a405ec`)|REQ-DEL-M06-03 / AC-M06-03-01, AC-M06-03-02, AC-M06-03-03 / TC-M06-03-*|
|BR-DEL-M06-03-02|基线：只允许当前draft/ready/assigned且没有任何历史Run；关联需求必须在同项目基线中且匹配任务已固定的修订。|运行中、存在Run的基线重绑、版本过期→返回对应locked/started/mismatch，保存旧合同；基线缺需求或固定修订不符→baseline_requirement_missing或baseline_revision_mismatch|`packages/application/src/task-service.ts:966-1096` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:366-379` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-baseline-use-cases.ts:11-61` (sha256 `cb7014fb111f34118d49d0393e0bec1c9031f6a4c99f91b6c2ca4b76b8a405ec`)|REQ-DEL-M06-03 / AC-M06-03-01, AC-M06-03-02, AC-M06-03-03 / TC-M06-03-*|
|BR-DEL-M06-03-03|运行控制：乐观base_snapshot与任务行锁保护；pending交接禁止修改；重复绑定同一基线不增加快照，但仍先检查无历史Run等资格。|运行中、存在Run的基线重绑、版本过期→返回对应locked/started/mismatch，保存旧合同；基线缺需求或固定修订不符→baseline_requirement_missing或baseline_revision_mismatch|`packages/application/src/task-service.ts:966-1096` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:366-379` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-baseline-use-cases.ts:11-61` (sha256 `cb7014fb111f34118d49d0393e0bec1c9031f6a4c99f91b6c2ca4b76b8a405ec`)|REQ-DEL-M06-03 / AC-M06-03-01, AC-M06-03-02, AC-M06-03-03 / TC-M06-03-*|
|BR-DEL-M06-03-04|当前状态：合同编辑/取消只检查当前draft/ready/assigned，不检查是否曾执行；失败后重新分派到assigned的返工任务即使有completed历史Run仍可编辑或取消。当前running等状态拒绝。仅基线绑定另有无任何历史Run限制。|运行中、存在Run的基线重绑、版本过期→返回对应locked/started/mismatch，保存旧合同；基线缺需求或固定修订不符→baseline_requirement_missing或baseline_revision_mismatch|`packages/application/src/task-service.ts:966-1096` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:366-379` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-baseline-use-cases.ts:11-61` (sha256 `cb7014fb111f34118d49d0393e0bec1c9031f6a4c99f91b6c2ca4b76b8a405ec`)|REQ-DEL-M06-03 / AC-M06-03-01, AC-M06-03-02, AC-M06-03-03 / TC-M06-03-*|
|BR-DEL-M06-04-01|资格：actor必须为项目管理者；assignee为可写项目成员，viewer或非成员拒绝。|无权限、被分派人不可写→assign_forbidden/assignee_not_member或项目权限拒绝；过期版本或未完成交接→保持原指派及状态|`packages/application/src/task-service.ts:326-408` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/domain/src/task-state-machine.ts:17-29` (sha256 `2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26`)<br>`apps/core-api/src/routes/tasks.ts:178-188` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-04 / AC-M06-04-01, AC-M06-04-02 / TC-M06-04-*|
|BR-DEL-M06-04-02|状态：draft/failed通过ready验收标准门槛后进入assigned；其他状态必须符合邻接状态机。|无权限、被分派人不可写→assign_forbidden/assignee_not_member或项目权限拒绝；过期版本或未完成交接→保持原指派及状态|`packages/application/src/task-service.ts:326-408` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/domain/src/task-state-machine.ts:17-29` (sha256 `2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26`)<br>`apps/core-api/src/routes/tasks.ts:178-188` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-04 / AC-M06-04-01, AC-M06-04-02 / TC-M06-04-*|
|BR-DEL-M06-04-03|运行控制：锁定后重查权限；base_snapshot不符或CAS失败拒绝；不创建Run。|无权限、被分派人不可写→assign_forbidden/assignee_not_member或项目权限拒绝；过期版本或未完成交接→保持原指派及状态|`packages/application/src/task-service.ts:326-408` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/domain/src/task-state-machine.ts:17-29` (sha256 `2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26`)<br>`apps/core-api/src/routes/tasks.ts:178-188` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-04 / AC-M06-04-01, AC-M06-04-02 / TC-M06-04-*|
|BR-DEL-M06-05-01|资格：普通领取必须assigned、本人Assignee及Profile一致，所有已解析依赖closed。|已有active Run→claim_run_conflict，不创建第二Run；依赖未closed、身份/Profile不符或版本过期→拒绝并保留assigned；技能交付不可用→事务回滚任务、Run、工作区|`packages/application/src/task-service.ts:178-231` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:415-567` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/skills-run.ts:18-46` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/persistence/src/schema.ts:990-1033` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-05 / AC-M06-05-01, AC-M06-05-02, AC-M06-05-03 / TC-M06-05-*|
|BR-DEL-M06-05-02|例外：submitted状态的verifier领取仍要求写权/版本/无活跃Run，但绕过普通assigned/Assignee/Profile匹配与依赖检查。|已有active Run→claim_run_conflict，不创建第二Run；依赖未closed、身份/Profile不符或版本过期→拒绝并保留assigned；技能交付不可用→事务回滚任务、Run、工作区|`packages/application/src/task-service.ts:178-231` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:415-567` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/skills-run.ts:18-46` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/persistence/src/schema.ts:990-1033` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-05 / AC-M06-05-01, AC-M06-05-02, AC-M06-05-03 / TC-M06-05-*|
|BR-DEL-M06-05-03|运行控制：Run/工作区编码全新且路径与Git基线非空；事务内创建互绑记录，技能授权失败回滚整个领取。|已有active Run→claim_run_conflict，不创建第二Run；依赖未closed、身份/Profile不符或版本过期→拒绝并保留assigned；技能交付不可用→事务回滚任务、Run、工作区|`packages/application/src/task-service.ts:178-231` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:415-567` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/skills-run.ts:18-46` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/persistence/src/schema.ts:990-1033` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-05 / AC-M06-05-01, AC-M06-05-02, AC-M06-05-03 / TC-M06-05-*|
|BR-DEL-M06-05-04|状态：普通领取快照+1；验证领取保持submitted且不增加任务快照。|已有active Run→claim_run_conflict，不创建第二Run；依赖未closed、身份/Profile不符或版本过期→拒绝并保留assigned；技能交付不可用→事务回滚任务、Run、工作区|`packages/application/src/task-service.ts:178-231` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/task-service.ts:415-567` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`packages/application/src/skills-run.ts:18-46` (sha256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`)<br>`packages/persistence/src/schema.ts:990-1033` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-05 / AC-M06-05-01, AC-M06-05-02, AC-M06-05-03 / TC-M06-05-*|
|BR-DEL-M06-06-01|资格：Run本人才能提交；租约/权限/交接栅栏均适用。|fail/inconclusive、错误类型、空或未知AC→拒绝且不新增产物/证据；身份、版本、租约失效→拒绝原子提交并保留原状态|`packages/application/src/task-service.ts:811-960` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`apps/core-api/src/routes/tasks.ts:210-248` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-06 / AC-M06-06-01, AC-M06-06-02 / TC-M06-06-*|
|BR-DEL-M06-06-02|证据：仅self_test且pass；acceptance_refs至少一条且不能引用未知AC；此入口不强制覆盖全部AC。|fail/inconclusive、错误类型、空或未知AC→拒绝且不新增产物/证据；身份、版本、租约失效→拒绝原子提交并保留原状态|`packages/application/src/task-service.ts:811-960` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`apps/core-api/src/routes/tasks.ts:210-248` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-06 / AC-M06-06-01, AC-M06-06-02 / TC-M06-06-*|
|BR-DEL-M06-06-03|状态：一事务内任务running→submitted、快照+1、Run→completed；self_tested保留为两段审计而非单独停留。|fail/inconclusive、错误类型、空或未知AC→拒绝且不新增产物/证据；身份、版本、租约失效→拒绝原子提交并保留原状态|`packages/application/src/task-service.ts:811-960` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`apps/core-api/src/routes/tasks.ts:210-248` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-06 / AC-M06-06-01, AC-M06-06-02 / TC-M06-06-*|
|BR-DEL-M06-06-04|边界：服务保存客户端报告的测试结果、命令与产物URI/hash，本身不执行测试或证明产物正确。|fail/inconclusive、错误类型、空或未知AC→拒绝且不新增产物/证据；身份、版本、租约失效→拒绝原子提交并保留原状态|`packages/application/src/task-service.ts:811-960` (sha256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`)<br>`apps/core-api/src/routes/tasks.ts:210-248` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|REQ-DEL-M06-06 / AC-M06-06-01, AC-M06-06-02 / TC-M06-06-*|
|BR-DEL-M06-07-01|资格：builder Run不能验证；验证要求active verifier Run本人；关闭要求当前管理权。实现隔离的是Run Profile，没有检查Verifier与先前Builder必须为不同自然人。|pass未覆盖全部AC→acceptance_coverage_incomplete，任务仍submitted且Run active；非verified关闭或非管理者→拒绝且不关闭|`packages/application/src/project-use-cases.ts:541-769` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:251-283` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|tsp-req-task-verification / AC-M06-07-01, AC-M06-07-02, AC-M06-07-03 / TC-M06-07-*|
|BR-DEL-M06-07-02|证据：未知引用总是拒绝；pass按去重AC集合全覆盖；fail/inconclusive不要求全覆盖。|pass未覆盖全部AC→acceptance_coverage_incomplete，任务仍submitted且Run active；非verified关闭或非管理者→拒绝且不关闭|`packages/application/src/project-use-cases.ts:541-769` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:251-283` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|tsp-req-task-verification / AC-M06-07-01, AC-M06-07-02, AC-M06-07-03 / TC-M06-07-*|
|BR-DEL-M06-07-03|状态：pass→verified，fail/inconclusive→failed，均完成验证Run并快照+1；failed可重新分派返工；关闭仅verified且快照匹配。|pass未覆盖全部AC→acceptance_coverage_incomplete，任务仍submitted且Run active；非verified关闭或非管理者→拒绝且不关闭|`packages/application/src/project-use-cases.ts:541-769` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:251-283` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|tsp-req-task-verification / AC-M06-07-01, AC-M06-07-02, AC-M06-07-03 / TC-M06-07-*|
|BR-DEL-M06-07-04|边界：验证接口保存报告并流转；测试执行记录不自动触发verify/close。|pass未覆盖全部AC→acceptance_coverage_incomplete，任务仍submitted且Run active；非verified关闭或非管理者→拒绝且不关闭|`packages/application/src/project-use-cases.ts:541-769` (sha256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`)<br>`apps/core-api/src/routes/tasks.ts:251-283` (sha256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`)|tsp-req-task-verification / AC-M06-07-01, AC-M06-07-02, AC-M06-07-03 / TC-M06-07-*|
|BR-DEL-M06-08-01|模式：claim与run共享worktree领取实现；attach不创建或改写Git worktree，状态仍经服务领取校验。|服务器领取拒绝→本机worktree尝试回收；无服务Run；领取成功后本地上下文准备失败→claim_context_failed并保留现场|`apps/cli/src/index.ts:478-594` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)<br>`apps/cli/src/index.ts:598-683` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)|REQ-DEL-M06-08 / AC-M06-08-01, AC-M06-08-02 / TC-M06-08-*|
|BR-DEL-M06-08-02|运行控制：服务领取之前失败尝试回收本机半成品；服务已成功后上下文/技能写失败返回claim_context_failed并保留已创建Run与工作区。|服务器领取拒绝→本机worktree尝试回收；无服务Run；领取成功后本地上下文准备失败→claim_context_failed并保留现场|`apps/cli/src/index.ts:478-594` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)<br>`apps/cli/src/index.ts:598-683` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)|REQ-DEL-M06-08 / AC-M06-08-01, AC-M06-08-02 / TC-M06-08-*|
|BR-DEL-M06-08-03|恢复：返回run_code/workspace_code/workspace_path和原因用于人工检查权限/本地文件；不自动回滚服务器领取。|服务器领取拒绝→本机worktree尝试回收；无服务Run；领取成功后本地上下文准备失败→claim_context_failed并保留现场|`apps/cli/src/index.ts:478-594` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)<br>`apps/cli/src/index.ts:598-683` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)|REQ-DEL-M06-08 / AC-M06-08-01, AC-M06-08-02 / TC-M06-08-*|
|BR-DEL-M06-08-04|渲染：attach将project-state置于Run独立目录；生成工作空间guidance为best effort，不阻断已完成任务包。|服务器领取拒绝→本机worktree尝试回收；无服务Run；领取成功后本地上下文准备失败→claim_context_failed并保留现场|`apps/cli/src/index.ts:478-594` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)<br>`apps/cli/src/index.ts:598-683` (sha256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`)|REQ-DEL-M06-08 / AC-M06-08-01, AC-M06-08-02 / TC-M06-08-*|
|BR-DEL-M06-09-01|身份：execution/lease/sessions接口仅接受中间件解析的bearer设备凭据，不接受cookie或body声明的Principal；与handover允许bearer/cookie不同。租约有效期绑定一设备；同设备mint返回相同token，其他设备在有效期内拒绝；过期后撤销旧租约并签发新租约；renew延长30秒不轮换token。|权限/设备撤销→相应读取或写入均按当前权限制止；Run不active或代数不匹配本身不禁止有权读取context/sessions；写入遇Run不active、旧代数/过期token→拒绝mint/续租或执行写；不把此限制套到历史读取；重复key不同负载/重复活跃会话→conflict且不新增Session|`packages/application/src/execution-use-cases.ts:14-56` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-use-cases.ts:63-127` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-guard.ts:9-54` (sha256 `0a7208e9b9f1a3729b53397505a44a2ff0f3920017686f91d7443d6d49df7ec5`)<br>`apps/core-api/src/routes/execution.ts:6-33` (sha256 `cdb3e1867162f1b10638ff450a30aa01f711c573e2a1ef72c73fc8ce4ef104b4`)<br>`packages/persistence/src/schema.ts:1097-1114` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-09 / AC-M06-09-01, AC-M06-09-02, AC-M06-09-03 / TC-M06-09-*|
|BR-DEL-M06-09-02|启动：先验当前写栅栏、租约及固定技能授权，再按start_key查重；同key命令/Prompt不同为conflict；同代数已有starting/running会话拒绝新启动。|权限/设备撤销→相应读取或写入均按当前权限制止；Run不active或代数不匹配本身不禁止有权读取context/sessions；写入遇Run不active、旧代数/过期token→拒绝mint/续租或执行写；不把此限制套到历史读取；重复key不同负载/重复活跃会话→conflict且不新增Session|`packages/application/src/execution-use-cases.ts:14-56` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-use-cases.ts:63-127` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-guard.ts:9-54` (sha256 `0a7208e9b9f1a3729b53397505a44a2ff0f3920017686f91d7443d6d49df7ec5`)<br>`apps/core-api/src/routes/execution.ts:6-33` (sha256 `cdb3e1867162f1b10638ff450a30aa01f711c573e2a1ef72c73fc8ce4ef104b4`)<br>`packages/persistence/src/schema.ts:1097-1114` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-09 / AC-M06-09-01, AC-M06-09-02, AC-M06-09-03 / TC-M06-09-*|
|BR-DEL-M06-09-03|状态：Session仅同设备与代数可写，终态更新为只读返回；last_error最多4000字符，last_output保留尾部32000字符；会话列表按ID降序。|权限/设备撤销→相应读取或写入均按当前权限制止；Run不active或代数不匹配本身不禁止有权读取context/sessions；写入遇Run不active、旧代数/过期token→拒绝mint/续租或执行写；不把此限制套到历史读取；重复key不同负载/重复活跃会话→conflict且不新增Session|`packages/application/src/execution-use-cases.ts:14-56` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-use-cases.ts:63-127` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-guard.ts:9-54` (sha256 `0a7208e9b9f1a3729b53397505a44a2ff0f3920017686f91d7443d6d49df7ec5`)<br>`apps/core-api/src/routes/execution.ts:6-33` (sha256 `cdb3e1867162f1b10638ff450a30aa01f711c573e2a1ef72c73fc8ce4ef104b4`)<br>`packages/persistence/src/schema.ts:1097-1114` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-09 / AC-M06-09-01, AC-M06-09-02, AC-M06-09-03 / TC-M06-09-*|
|BR-DEL-M06-09-04|兼容：业务执行写在task/run epoch均0时免租约，但仍查当前项目写权和pending交接；Session启动另行强制有效租约。|权限/设备撤销→相应读取或写入均按当前权限制止；Run不active或代数不匹配本身不禁止有权读取context/sessions；写入遇Run不active、旧代数/过期token→拒绝mint/续租或执行写；不把此限制套到历史读取；重复key不同负载/重复活跃会话→conflict且不新增Session|`packages/application/src/execution-use-cases.ts:14-56` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-use-cases.ts:63-127` (sha256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`)<br>`packages/application/src/execution-guard.ts:9-54` (sha256 `0a7208e9b9f1a3729b53397505a44a2ff0f3920017686f91d7443d6d49df7ec5`)<br>`apps/core-api/src/routes/execution.ts:6-33` (sha256 `cdb3e1867162f1b10638ff450a30aa01f711c573e2a1ef72c73fc8ce4ef104b4`)<br>`packages/persistence/src/schema.ts:1097-1114` (sha256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`)|REQ-DEL-M06-09 / AC-M06-09-01, AC-M06-09-02, AC-M06-09-03 / TC-M06-09-*|
|BR-DEL-M06-10-01|启动恢复：相同本机start_key对应存活监督进程直接返回；服务已登记但本机无journal拒绝重复启动；启动失败终止进程并保留失败journal。|服务重复登记但journal缺失→session_already_registered，不启动第二进程；续租明确拒绝或到期→终止进程，保存失败诊断；服务不能写时保留本机结果；暂停Run resume仍有pending交接→服务拒绝，不启动新Agent|`apps/agentd/src/index.ts:17-108` (sha256 `3a13c99cadace468ca30cd740340bb0930a9eb06eb53c358bce451a565936fc3`)<br>`apps/agentd/src/supervisor.ts:7-83` (sha256 `649d870072b6cd0764ad8d3e39907093c493860e8d759647244d13b98e67f703`)<br>`apps/agentd/src/runtime.ts:17-51` (sha256 `8deba2d435aca0ccdf7dd2434b019d076e98a6176e3f5e230b7c4bf578be26b4`)|REQ-DEL-M06-10 / AC-M06-10-01, AC-M06-10-02 / TC-M06-10-*|
|BR-DEL-M06-10-02|监督：轮询间隔夹在250至5000ms；传输不可达仅可使用未到期租约，明确拒绝或到期终止托管进程树。|服务重复登记但journal缺失→session_already_registered，不启动第二进程；续租明确拒绝或到期→终止进程，保存失败诊断；服务不能写时保留本机结果；暂停Run resume仍有pending交接→服务拒绝，不启动新Agent|`apps/agentd/src/index.ts:17-108` (sha256 `3a13c99cadace468ca30cd740340bb0930a9eb06eb53c358bce451a565936fc3`)<br>`apps/agentd/src/supervisor.ts:7-83` (sha256 `649d870072b6cd0764ad8d3e39907093c493860e8d759647244d13b98e67f703`)<br>`apps/agentd/src/runtime.ts:17-51` (sha256 `8deba2d435aca0ccdf7dd2434b019d076e98a6176e3f5e230b7c4bf578be26b4`)|REQ-DEL-M06-10 / AC-M06-10-01, AC-M06-10-02 / TC-M06-10-*|
|BR-DEL-M06-10-03|输出与终态：合并stdout/stderr最后50行且≤32000字符为诊断尾部；正常无错exit0→finished，否则failed；不能声称完整会话转移。|服务重复登记但journal缺失→session_already_registered，不启动第二进程；续租明确拒绝或到期→终止进程，保存失败诊断；服务不能写时保留本机结果；暂停Run resume仍有pending交接→服务拒绝，不启动新Agent|`apps/agentd/src/index.ts:17-108` (sha256 `3a13c99cadace468ca30cd740340bb0930a9eb06eb53c358bce451a565936fc3`)<br>`apps/agentd/src/supervisor.ts:7-83` (sha256 `649d870072b6cd0764ad8d3e39907093c493860e8d759647244d13b98e67f703`)<br>`apps/agentd/src/runtime.ts:17-51` (sha256 `8deba2d435aca0ccdf7dd2434b019d076e98a6176e3f5e230b7c4bf578be26b4`)|REQ-DEL-M06-10 / AC-M06-10-01, AC-M06-10-02 / TC-M06-10-*|
|BR-DEL-M06-10-04|停止/同步：stop仅匹配本人设备指纹的本机journal，恰选session或run；被服务栅栏后仍能本机停止并保留journal；sync传输失败向上报错，其他服务拒绝可保留现场继续。|服务重复登记但journal缺失→session_already_registered，不启动第二进程；续租明确拒绝或到期→终止进程，保存失败诊断；服务不能写时保留本机结果；暂停Run resume仍有pending交接→服务拒绝，不启动新Agent|`apps/agentd/src/index.ts:17-108` (sha256 `3a13c99cadace468ca30cd740340bb0930a9eb06eb53c358bce451a565936fc3`)<br>`apps/agentd/src/supervisor.ts:7-83` (sha256 `649d870072b6cd0764ad8d3e39907093c493860e8d759647244d13b98e67f703`)<br>`apps/agentd/src/runtime.ts:17-51` (sha256 `8deba2d435aca0ccdf7dd2434b019d076e98a6176e3f5e230b7c4bf578be26b4`)|REQ-DEL-M06-10 / AC-M06-10-01, AC-M06-10-02 / TC-M06-10-*|

## 完整场景与数据契约

### REQ-DEL-M06-01 任务看板、详情与依赖审计查询

参与者：具有项目读取权的有效用户。触发：查询任务列表、状态、依赖图、历史及证据。

前置条件：使用当前认证身份；可选项目、状态、指派人及分页参数。

主流程：计算可见项目集合及指派人条件；按创建时间降序、内部 ID 降序分页并返回 total/has_more；详情合并合同、Run、工作区、证据、产物及固定需求来源；依赖图只返回可见任务间的边。

状态变化/保留：只读查询不推进任务状态或 base_snapshot。

数据契约：公开返回 task_code/feature_code、status、acceptance、base_snapshot、Run/工作区与产物证据；图边为 from/to。

验收标准：AC-M06-01-01 同时间任务分页保持确定ID次序，计数及依赖图只覆盖当前用户可见任务。；AC-M06-01-02 无项目访问权不能通过列表、图或详情读取任务数据。。

### REQ-DEL-M06-02 创建带来源及依赖的任务合同

参与者：项目负责人/管理员；可写成员可提出 ad-hoc。触发：通过任务创建入口提交合同。

前置条件：目标Feature存在且属于可写的活动项目；acceptance非空；profile及source采用合同枚举。

主流程：校验来源对应权限；解析关联需求并固定其当前修订/文档修订，或按已选基线固定需求修订；校验缺陷与依赖归属；事务保存draft任务、依赖及审计，基线版本为0。

状态变化/保留：新任务 status=draft、base_snapshot=0；尚无Run。

数据契约：输入feature_code、title、brief、profile、source、acceptance[{id,text}]、depends_on_codes及可选需求/基线/缺陷、scope、validation_seams。

验收标准：AC-M06-02-01 可写成员创建ad-hoc任务后形成未执行合同。；AC-M06-02-02 跨项目依赖和不匹配缺陷不会形成任务。。

### REQ-DEL-M06-03 按当前状态修改合同或取消、首次绑定需求基线

参与者：活动项目负责人或管理员。触发：编辑合同、选择基线或取消当前可管理状态的任务。

前置条件：持有当前base_snapshot；合同编辑/取消限draft、ready、assigned；基线绑定还要求从未有Run。

主流程：重查管理权限并锁任务；拒绝未完成交接或版本不匹配；修改合同/基线时推进快照并写审计；取消转cancelled；相同基线绑定为不推进版本的返回。

状态变化/保留：编辑/不同基线绑定 base_snapshot+1；取消→cancelled且base_snapshot+1；相同基线保持版本。

数据契约：合同字段title、brief、acceptance、validation_seams、scope；基线输入baseline_code及base_snapshot。

验收标准：AC-M06-03-01 首次基线绑定推进合同版本，重复绑定同一基线保持版本。；AC-M06-03-02 当前running状态拒绝合同编辑、基线绑定和取消；此断言不扩展为曾执行过即永久不可改。；AC-M06-03-03 曾执行并重新分派到assigned的返工任务可按当前状态编辑/取消，而任何历史Run仍阻止基线绑定。。

### REQ-DEL-M06-04 分派与失败任务返工重入

参与者：当前项目管理者及具有写权的被分派人。触发：分派任务。

前置条件：任务可按状态机进入assigned；当前版本可用；无未完成交接。

主流程：校验管理者与被分派人的当前项目权限；用户→团队→项目→任务加锁后重查权限；draft/failed先经ready门槛，再变为assigned；更新指派人、版本及审计。

状态变化/保留：→assigned、assignee变更、base_snapshot+1；Run数量保持。

数据契约：输入task、assignee_principal_code、base_snapshot；HTTP兼容user_code作为指派人后备字段。

验收标准：AC-M06-04-01 失败任务经ready门槛重新分派后可进入返工队列。；AC-M06-04-02 普通成员不能分派，viewer不能成为执行者。。

### REQ-DEL-M06-05 领取任务与独立验证Run

参与者：匹配Profile的任务执行者；submitted任务的verifier。触发：使用全新Run/工作区编码领取。

前置条件：当前写权限、无未完成交接、无active Run；提供非空工作区路径与git_base；普通领取为assigned且本人为Assignee。

主流程：锁任务并核对版本、身份、Profile及已关闭依赖；普通领取推进running并创建互绑Run/工作区；submitted+verifier走验证领取分支，保留任务状态与版本；固定本次Run技能清单，记录领取审计。

状态变化/保留：普通assigned→running且Run active；验证任务仍submitted且Run profile=verifier。

数据契约：run_code/workspace_code唯一；workspace_path、git_base；Run固定principal/profile/base_snapshot及execution_epoch。

验收标准：AC-M06-05-01 符合身份、Profile及依赖条件的领取原子生成执行Run。；AC-M06-05-02 验证领取允许其他可写成员取得verifier Run并保持任务已提交状态。；AC-M06-05-03 重复领取不能创建第二个活动Run。。

### REQ-DEL-M06-06 自测证据与产物提交

参与者：活动Run本人且仍有项目写权。触发：从running任务提交Artifact及self_test Evidence。

前置条件：任务running，Run属于任务且active，当前base_snapshot；通过执行写栅栏；非legacy代数提供当前设备租约。

主流程：校验Run身份、状态、版本和执行栅栏；要求self_test/pass且非空AC引用全部为任务已知ID；逻辑经self_tested再submitted；事务保存published产物、证据、两段审计，完成Run。

状态变化/保留：running→submitted；Run active→completed；新增published Artifact、self_test Evidence及两段审计。

数据契约：artifact.kind/uri/content_hash；evidence.type/result/acceptance_refs/command/summary；兼容camelCase引用及contentHash字段。

验收标准：AC-M06-06-01 通过自测提交可引用非空已知AC子集并原子保存产物与两段状态审计。；AC-M06-06-02 非通过自测或未知AC引用不产生提交副作用。。

### tsp-req-task-verification 验证、失败退回与管理关闭

参与者：active verifier Run本人；关闭由项目管理者。触发：提交verifier_review结果，随后管理者关闭。

前置条件：验证任务submitted、Run profile=verifier且属于本人/任务；关闭任务verified且持当前快照；无未完成交接。

主流程：验证时校验写栅栏、Run身份/Profile和AC引用；pass必须覆盖所有AC；fail/inconclusive转failed；保存验证证据、完成verifier Run并推进版本；管理者独立执行verified→closed。

状态变化/保留：submitted→verified或failed；verifier Run→completed；verified→closed由后续管理操作。

数据契约：evidence固定verifier_review，result为pass/fail/inconclusive；输入task/run/base_snapshot与已知AC ID。

验收标准：AC-M06-07-01 验证通过要求全部AC覆盖，且只有管理者能继续关闭。；AC-M06-07-02 不确定的验证结果进入failed返工分支且保留验证证据。；AC-M06-07-03 当前实现按Run Profile隔离，未禁止同一自然人先后担任Builder与Verifier。。

### REQ-DEL-M06-08 本机领取、外部工作区附着与上下文失败恢复

参与者：已设备登录的CLI执行者；外部编排器操作者。触发：task claim/run/attach。

前置条件：有可读取项目与任务，源Git仓库HEAD有效；claim/run目标工作区新建；attach接受已有Git工作区并由调用者隔离文件范围。

主流程：读取项目首页、需求文档、交接材料与任务合同；claim创建独立worktree后调用服务领取；attach直接登记已有路径；同步Run固定技能并渲染本机任务上下文；已服务领取后失败保留工作区与Run，返回恢复所需编码。

状态变化/保留：服务领取状态由REQ-DEL-M06-05定义；本机新增隔离worktree或附着目录下的Run状态材料。

数据契约：新Run/工作区编码；任务包包含brief、项目/需求/设计/交接/技能索引路径；workspace_path传给服务并保存于Run工作区记录，不能宣称所有本机路径都不出本机。

验收标准：AC-M06-08-01 本机领取生成可继续执行的上下文及隔离工作区。；AC-M06-08-02 服务器领取后本机上下文失败保留已创建执行现场并暴露恢复身份。。

### REQ-DEL-M06-09 设备租约、会话启动幂等与状态写入

参与者：Run本人及其未撤销设备。触发：读取执行上下文/会话、领取续租或登记Agent Session。

前置条件：所有入口要求Run本人、有效归属设备、active用户及当前项目读权；context/sessions读取不要求Run active或task/Run代数相等；mint/renew/start/state写另要求写权、active及各自租约/代数校验，epoch0兼容按下述规则。

主流程：锁任务并校验Run本人、设备和当前项目读权限；只读context/sessions可返回暂停/历史或代数不匹配Run，不签发执行权；写请求另查项目写权、Run状态/代数和有效租约，领取/续租30秒租约；按Run、设备、代数、start_key登记会话并更新starting/running状态和诊断输出。

状态变化/保留：context/sessions只读不改Run、epoch或租约；mint创建或重放租约；续租只延长expires_at；新Session starting；状态→running/finished/failed/cancelled。

数据契约：start_key非空且≤128字符，agent_command非空且≤100000；epoch、lease_token；会话公开诊断不等于可移植完整对话。

验收标准：AC-M06-09-01 同设备租约领取和相同启动请求重试复用身份，不会增加会话。；AC-M06-09-02 有效租约拒绝同用户另一设备，过期交替后旧token不能继续写入。；AC-M06-09-03 暂停或代数不匹配的本人Run仍可读取上下文及会话历史，读取成功不代表取得执行写权。。

### REQ-DEL-M06-10 本机Agent托管、停止、同步与租约丢失保护

参与者：持有Run本人设备凭据的本机操作者。触发：agentd start/resume/sessions/sync/stop。

前置条件：本机存在执行仓库；默认模式有Prompt文件；当前服务Run可执行；journal与当前API/设备凭据指纹匹配。

主流程：读取Run执行上下文和租约，服务端幂等登记Session；写本地journal再启动隐藏监督进程；默认Codex从stdin接收完整Prompt；监督进程定期续租并保存尾部诊断；退出/显式停止后写journal并尽力报告；sync补报，resume显式恢复暂停Run。

状态变化/保留：本机journal记录完成/错误/exitCode；Session按可报告结果终态；stop不自动恢复源Run或回滚业务。

数据契约：托管环境含Run/task/workspace/brief/租约/代数；删除TSP_DATABASE_URL传递；默认Prompt不插值到shell参数。

验收标准：AC-M06-10-01 受控进程结束后同步保存会话终态及诊断。；AC-M06-10-02 明确租约丢失后监督器终止本机托管进程并保留诊断。。

## 计划测试矩阵（未执行）

|用例 / 优先级 / 状态|BR / REQ / AC|独立种子、Actor及权限|动作|可观察断言|
|---|---|---|---|---|
|TC-M06-01-01 / P1建议 / not_run|BR-DEL-M06-01-01, BR-DEL-M06-01-02, BR-DEL-M06-01-03 / REQ-DEL-M06-01 / AC-M06-01-01|执行前独立重置；有效项目成员；播种同一创建时间的3个可见任务、1个不可见项目任务|查询limit=2再以offset=2查询；读取total及依赖图|两页顺序按ID降序无重复，total=3，图中无不可见任务或跨可见域边，数据库不变|
|TC-M06-01-02 / P1建议 / not_run|BR-DEL-M06-01-01, BR-DEL-M06-01-02, BR-DEL-M06-01-03 / REQ-DEL-M06-01 / AC-M06-01-02|执行前独立重置；无项目读取权用户；另存任务基线及记录计数|列表及图查询指定项目；读取该任务详情|列表和图为空；详情拒绝；任务基线/状态/记录数不变|
|TC-M06-02-01 / P1建议 / not_run|BR-DEL-M06-02-01, BR-DEL-M06-02-02, BR-DEL-M06-02-03, BR-DEL-M06-02-04 / REQ-DEL-M06-02 / AC-M06-02-01|执行前独立重置；活动项目写成员；已存在Feature F；无同名任务；两条AC|以ad-hoc来源创建任务并读取详情|保存draft及两条AC，base_snapshot=0，作者审计正确，无Run|
|TC-M06-02-02 / P1建议 / not_run|BR-DEL-M06-02-01, BR-DEL-M06-02-02, BR-DEL-M06-02-03, BR-DEL-M06-02-04 / REQ-DEL-M06-02 / AC-M06-02-02|执行前独立重置；活动项目管理者；同项目依赖D和另一项目依赖X；缺陷Z属于另一Feature|分别在独立重置状态提交跨项目依赖或不匹配defect-fix任务|每次拒绝且无新任务/依赖/审计部分写入|
|TC-M06-03-01 / P1建议 / not_run|BR-DEL-M06-03-01, BR-DEL-M06-03-02, BR-DEL-M06-03-03, BR-DEL-M06-03-04 / REQ-DEL-M06-03 / AC-M06-03-01|执行前独立重置；活动项目管理者；assigned任务、无Run，base_snapshot=4；已存在同项目匹配基线B|绑定B读取版本，再用最新版本重复绑定B|首次版本5，重复仍5且基线身份不变|
|TC-M06-03-02 / P1建议 / not_run|BR-DEL-M06-03-01, BR-DEL-M06-03-02, BR-DEL-M06-03-03, BR-DEL-M06-03-04 / REQ-DEL-M06-03 / AC-M06-03-02|执行前独立重置；活动项目管理者；当前running任务且有active Run；无pending交接；保存合同/基线/状态快照|分别在独立重置的running种子上尝试改合同、绑定基线、取消|均拒绝；原合同/基线/状态及快照版本保持|
|TC-M06-03-03 / P1建议 / not_run|BR-DEL-M06-03-01, BR-DEL-M06-03-02, BR-DEL-M06-03-03, BR-DEL-M06-03-04 / REQ-DEL-M06-03 / AC-M06-03-03|执行前独立重置；未来隔离验收夹具须建设，not_run：管理者O；任务有completed builder/verifier历史Run，验证失败后重新分派已为assigned、快照8、无active Run或pending交接；分别复制独立A/B/C种子且需求基线不变|种子A：O以base_snapshot8修改标题及非空AC；重置独立种子B：O以base_snapshot8取消；重置独立种子C：O以base_snapshot8绑定同项目匹配基线；逐项读取任务、历史Run和审计|A仍assigned、合同已修改且快照9；B cancelled快照9；C baseline_task_started且快照8/基线不变；所有历史Run及既有证据保留|
|TC-M06-04-01 / P1建议 / not_run|BR-DEL-M06-04-01, BR-DEL-M06-04-02, BR-DEL-M06-04-03 / REQ-DEL-M06-04 / AC-M06-04-01|执行前独立重置；活动管理者A、写成员B；failed任务含AC且无pending交接，快照7|将任务分派给B并读取任务和审计|状态assigned，assignee=B，快照8，新增task.assigned审计而无Run|
|TC-M06-04-02 / P1建议 / not_run|BR-DEL-M06-04-01, BR-DEL-M06-04-02, BR-DEL-M06-04-03 / REQ-DEL-M06-04 / AC-M06-04-02|执行前独立重置；普通写成员A、viewer B；draft任务快照0|分别以A分派和以管理者分派给B|均拒绝，任务仍draft且快照0、无Run|
|TC-M06-05-01 / P1建议 / not_run|BR-DEL-M06-05-01, BR-DEL-M06-05-02, BR-DEL-M06-05-03, BR-DEL-M06-05-04 / REQ-DEL-M06-05 / AC-M06-05-01|执行前独立重置；写成员B为assigned builder任务Assignee；依赖均closed；快照2；有效项目技能清单|以全新Run/工作区编码builder领取并查询记录|任务running、快照3；恰一active Run与工作区互绑；技能固定|
|TC-M06-05-02 / P1建议 / not_run|BR-DEL-M06-05-01, BR-DEL-M06-05-02, BR-DEL-M06-05-03, BR-DEL-M06-05-04 / REQ-DEL-M06-05 / AC-M06-05-02|执行前独立重置；写成员V不是原builder Assignee；submitted任务快照5、无active Run|以verifier领取且读取任务与Run|任务仍submitted快照5，新增V的active verifier Run|
|TC-M06-05-03 / P1建议 / not_run|BR-DEL-M06-05-01, BR-DEL-M06-05-02, BR-DEL-M06-05-03, BR-DEL-M06-05-04 / REQ-DEL-M06-05 / AC-M06-05-03|执行前独立重置；assigned任务已有active Run；另准备不同Run和工作区编码|再次领取|claim_run_conflict，原Run保持，未新增Run/工作区|
|TC-M06-06-01 / P1建议 / not_run|BR-DEL-M06-06-01, BR-DEL-M06-06-02, BR-DEL-M06-06-03, BR-DEL-M06-06-04 / REQ-DEL-M06-06 / AC-M06-06-01|执行前独立重置；Run本人B具有写权；running任务AC1/AC2、快照3、epoch0；有效产物元数据|提交pass self_test，仅引用AC1；读取任务、Run、产物、证据和审计|任务submitted快照4、Run completed，新增一产物一证据及self_tested/submitted审计；AC2未引用不使该入口拒绝|
|TC-M06-06-02 / P1建议 / not_run|BR-DEL-M06-06-01, BR-DEL-M06-06-02, BR-DEL-M06-06-03, BR-DEL-M06-06-04 / REQ-DEL-M06-06 / AC-M06-06-02|执行前独立重置；独立running任务快照3及本人active Run；无其他产物/证据|提交self_test fail后查询；重置后提交未知AC引用|两次均拒绝，任务/Run/版本、产物和证据计数不变|
|TC-M06-07-01 / P1建议 / not_run|BR-DEL-M06-07-01, BR-DEL-M06-07-02, BR-DEL-M06-07-03, BR-DEL-M06-07-04 / tsp-req-task-verification / AC-M06-07-01|执行前独立重置；verifier V可写；submitted任务AC1/AC2、快照5与V的active verifier Run|提交pass仅覆盖AC1读取拒绝；同一场景随后使用当前快照提交pass覆盖AC1/AC2；管理者以返回快照关闭|先保持submitted/active，再verified/Run completed快照6，关闭后closed快照7|
|TC-M06-07-02 / P1建议 / not_run|BR-DEL-M06-07-01, BR-DEL-M06-07-02, BR-DEL-M06-07-03, BR-DEL-M06-07-04 / tsp-req-task-verification / AC-M06-07-02|执行前独立重置；独立submitted任务AC1/AC2、快照5；本人verifier Run|提交inconclusive且空引用|任务failed快照6、验证Run completed、保存inconclusive证据，供管理者重新分派|
|TC-M06-07-03 / P1建议 / not_run|BR-DEL-M06-07-01, BR-DEL-M06-07-02, BR-DEL-M06-07-03, BR-DEL-M06-07-04 / tsp-req-task-verification / AC-M06-07-03|执行前独立重置；可写成员B已完成本任务builder Run；任务submitted、无active Run，AC1/2及当前快照已种子准备；B设备有效|同一个B领取新的verifier Run；以该verifier Run提交全AC pass|源码现状允许B的新verifier Run完成验证；原builder Run不能直接verify；此观察不批准职责分离策略|
|TC-M06-08-01 / P1建议 / not_run|BR-DEL-M06-08-01, BR-DEL-M06-08-02, BR-DEL-M06-08-03, BR-DEL-M06-08-04 / REQ-DEL-M06-08 / AC-M06-08-01|执行前独立重置；可写Assignee；assigned builder任务；本机独立Git仓库有HEAD；目标目录不存在；服务正常|执行task claim并记录返回的Run与工作区；读取本机brief及技能索引|独立worktree及上下文生成，服务恰有一Run；结果包含必要材料路径|
|TC-M06-08-02 / P1建议 / not_run|BR-DEL-M06-08-01, BR-DEL-M06-08-02, BR-DEL-M06-08-03, BR-DEL-M06-08-04 / REQ-DEL-M06-08 / AC-M06-08-02|执行前独立重置；同样独立基线；控制在服务claim成功后令技能同步发生可识别本机冲突|执行claim；读取错误details并查服务Run与本机目录|claim_context_failed含Run/工作区身份；服务Run及本机目录保留，不能当作未领取重试|
|TC-M06-09-01 / P1建议 / not_run|BR-DEL-M06-09-01, BR-DEL-M06-09-02, BR-DEL-M06-09-03, BR-DEL-M06-09-04 / REQ-DEL-M06-09 / AC-M06-09-01|执行前独立重置；active Run本人B、设备D、当前epoch2且可写；冻结服务器时钟至T0，无租约|mint两次比较token；同key与命令/Prompt启动两次；读取Session数后用同key换命令|mint token相同；只一Session且第二次created=false；换命令conflict无新增记录|
|TC-M06-09-02 / P1建议 / not_run|BR-DEL-M06-09-01, BR-DEL-M06-09-02, BR-DEL-M06-09-03, BR-DEL-M06-09-04 / REQ-DEL-M06-09 / AC-M06-09-02|执行前独立重置；独立active Run B/epoch2；D1租约有效到T0+30秒，D2亦属于B|在T0用D2 mint；再把时钟推进至过期后mint；用旧token续租|有效期内D2拒绝；过期后D2可领新租约，D1旧token拒绝且旧租约已撤销|
|TC-M06-09-03 / P1建议 / not_run|BR-DEL-M06-09-01, BR-DEL-M06-09-02, BR-DEL-M06-09-03, BR-DEL-M06-09-04 / REQ-DEL-M06-09 / AC-M06-09-03|执行前独立重置；未来隔离验收种子须建设，not_run：active用户B仍有项目读写权，bearer设备D未撤销，R属于B且suspended、R epoch1/task epoch2，有一条历史Session及工作区；记录原任务/Run/租约计数|D分别读取R execution context与sessions；D尝试mint租约并尝试续租/登记新Session；重新读取任务、Run及租约/Session计数|读取成功且显示suspended/epoch1及历史Session；mint因Run不active拒绝，执行写亦拒绝；状态/代数与记录计数不变|
|TC-M06-10-01 / P1建议 / not_run|BR-DEL-M06-10-01, BR-DEL-M06-10-02, BR-DEL-M06-10-03, BR-DEL-M06-10-04 / REQ-DEL-M06-10 / AC-M06-10-01|执行前独立重置；本人active Run、有效设备、存在本机仓库与Prompt；使用受控测试命令输出后exit0；新start_key|启动并等待受控命令退出；调用sync并读取journal和服务Session|一个Session最终finished且exit_code=0，journal completed，输出尾部可读；测试是否完成由观测确认|
|TC-M06-10-02 / P1建议 / not_run|BR-DEL-M06-10-01, BR-DEL-M06-10-02, BR-DEL-M06-10-03, BR-DEL-M06-10-04 / REQ-DEL-M06-10 / AC-M06-10-02|执行前独立重置；独立托管长运行命令；服务器时钟受控，租约有效；可在服务撤销设备/租约|启动后明确撤销其租约；等待实际监督轮询发现拒绝并观察进程树；读取journal|托管进程被终止且journal保存Execution lease lost；不宣称远端业务回滚|

## 现有测试证据及限制

- REQ-DEL-M06-01：`packages/application/tests/task-service.test.mjs` — task pages use stable id tie-break, counts, filters and empty out-of-bounds pages；defined / not_run。
- REQ-DEL-M06-02：`packages/application/tests/project-use-cases.test.mjs` — task create：验收标准缺失拒绝；依赖不存在拒绝；成功创建 draft + 依赖落库；defined / not_run。
- REQ-DEL-M06-03：`packages/application/tests/task-service.test.mjs` — cancel：Owner 可取消未执行任务并记录审计，执行中任务保持锁定；defined / not_run。
- REQ-DEL-M06-04：`packages/application/tests/task-service.test.mjs` — assign 成功：assigned + 审计 + 快照推进（ready → assigned 由分派负责）；defined / not_run。
- REQ-DEL-M06-05：`packages/application/tests/project-use-cases.test.mjs` — 全闭环：create → assign → claim(builder) → submit → claim(verifier) → verify → close；defined / not_run。
- REQ-DEL-M06-06：`packages/application/tests/task-service.test.mjs` — 全链路：assign → claim → submit 走用例边界，两段审计 + 快照推进（review 阻断 1/重要 1）；defined / not_run。
- tsp-req-task-verification：`packages/application/tests/project-use-cases.test.mjs` — 全闭环：create → assign → claim(builder) → submit → claim(verifier) → verify → close；defined / not_run。
- REQ-DEL-M06-09：`apps/agentd/tests/agentd.test.mjs` — 租约mint幂等返回相同token，续租不rotate，过期后允许本人另一设备重新领取；defined / not_run。
- REQ-DEL-M06-10：`apps/agentd/tests/agentd.test.mjs` — 撤销租约后watchdog终止托管Agent，旧设备不能续租或更新Session；defined / not_run。

## 未决风险和未检查项

- tsp-req-task-verification：是否强制Builder与Verifier为不同自然人需业务负责人决定；代码仅实施Profile/Run分离，本稿不将潜在职责分离缺口批准为业务目标。
- REQ-DEL-M06-08：实际Git、文件权限及HTTP故障注入均未执行；本条说明源代码补偿边界。
- REQ-DEL-M06-10：监督响应的实测延迟、不同OS进程树行为、网络恢复后的补报结果均未验证。
- 远端Git/HTTP/数据库/本机文件权限及真实Actor运行期结果未执行验证；无性能或恢复时限SLO推断。
- 没有把文档提议当作已实现目标；源中缺少入口不是全产品不存在的证明。
