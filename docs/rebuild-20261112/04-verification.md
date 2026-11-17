# 验证矩阵、证据边界与待确认问题

固定草稿快照 `256f8b15f9dc0fa80e7f56aa9d1b2b59f4ef5104a16926dfbc9ad47f4b64137b`，基准提交 `92728fbec04cfa34fee4421cb0a9319d1b755164`。本文路径相对该快照。

**intent**　让接手者能在对应环境核验具体判断。本表的 **observed_in_code** 指源码及已存在的测试定义；每行给出的组合场景和优先级为 **inference**，其中有些断言需要在列出的代表用例上补充。各行执行状态均为 **untested / defined_not_run**，每行从独立的干净数据开始。

| 编号与优先级 | 业务规则 | 初始角色及数据 | 操作与预期观察 | 代表性已有测试入口 |
| --- | --- | --- | --- | --- |
| V01 · P0 | BR-PROJECT-ACCESS | 团队读策略与显式成员各一人，项目活跃 | 显式角色与团队策略并存时，读取权限来源并在归档后尝试写入。 | `packages/application/tests/permissions-policy.test.mjs:108-122`、`packages/application/tests/permissions-policy.test.mjs:196-213` |
| V02 · P0 | BR-HANDOVER-PREPARE | 两位可写成员、源 builder 任务运行中 | 准备完成后用源 Run 的旧租约提交，断言被拒且源 Run 已暂停。 | `packages/application/tests/handover-use-cases.test.mjs:256-272` |
| V03 · P0 | BR-HANDOVER-PUBLISH | 有准备包和工作区清单、缺少停止回执 | 省略停止回执请求发布，再由其他成员尝试接收，分别核对拒绝。 | `packages/application/tests/handover-use-cases.test.mjs:273-292` |
| V04 · P0 | BR-HANDOVER-ACTIVATE | 目标已 ready，另有第二个请求 | 在同一 ready 状态并发激活；检查一个活动 Run、任务负责人及双方的 Run 历史。 | `packages/application/tests/handover-use-cases.test.mjs:520-545` |
| V05 · P0 | BR-HANDOVER-DRIFT | 已发布且已 ready 的交接包 | ready 后再改资料，尝试激活，确认快照原文与阻断原因。 | `packages/application/tests/handover-use-cases.test.mjs:473-492` |
| V06 · P0 | BR-TOPIC-DECIDE | 普通成员与管理者、未归档议题 | 分别用普通成员和管理者发 decision；向已决定议题补 feedback。 | `packages/application/tests/requirement-collaboration-use-cases.test.mjs:29-61` |
| V07 · P1 | BR-REVIEW-REVISION | 文档维护人、当前修订 R1 与未关闭评审 | 开评审后另建修订，再回查评审绑定的旧版本。 | `packages/application/tests/requirement-collaboration-use-cases.test.mjs:140-164` |
| V08 · P0 | BR-BASELINE-FREEZE | 活动项目、已确认需求和同一父基线 | 以同一父级并发确认两次；比较旧基线内容与最新需求。 | `packages/application/tests/baseline-use-cases.test.mjs:98-121` |
| V09 · P0 | BR-TASK-EVIDENCE | 分别准备有/无验收和证据的任务 | 分别删去产物和验证证据，再以 builder 请求验证，读取具体拒绝原因。 | `packages/domain/tests/task-state-machine.test.mjs:89-111` |
| V10 · P0 | BR-TEST-EXECUTION | 两版用例、pass/fail 结果各一件 | 新增一个执行后再改用例，回看执行快照；尝试给 pass 的结果关联缺陷。另记录一次通过结果，确认关联任务仍为 running。 | `packages/application/tests/testing.test.mjs:76-102`、`packages/application/tests/testing.test.mjs:122-146`、`packages/application/tests/testing.test.mjs:169-175` |
| V11 · P0 | BR-DEFECT-RETEST | 同缺陷已绑定修复任务，尚未 verified | 在修复任务完成验证前后各尝试回归，读取返回状态。 | `packages/application/tests/defect-use-cases.test.mjs:26-116` |
| V12 · P0 | BR-INTAKE-FREEZE | 企业档草稿含 blocker，有固定请求键 | 重复提交再以同键变更内容；对有 blocker 的企业草稿尝试冻结。 | `apps/core-api/tests/intake.test.mjs:73-94` |
| V13 · P0 | BR-INTAKE-APPLY | 已冻结且有依赖的多项批次 | 制造依赖失败或在两项之间停止，比较已提交对象、剩余项和尝试状态。 当前所引测试覆盖正常发布与对象保留；项间停止及依赖失败断言拟补。 | `apps/core-api/tests/intake.test.mjs:150-178` |
| V14 · P1 | BR-AGENT-ADOPT | 可用申请者与待采用的文档修改稿 | 草稿生成后人工改文档，再提交旧哈希与基准修订。 | `packages/application/tests/system-agent.test.mjs:86-105` |
| V15 · P0 | BR-SKILL-PIN | 已经领取的 Run 和随后升级的技能 | 领取后升级项目技能，接手并检查实际清单；再撤销共享重读。 | `packages/application/tests/skills-run.test.mjs:100-120` |
| V16 · P0 | BR-CODE-SNAPSHOT | 有读写成员、viewer 及固定 Run | 尝试修改已绑定清单及以其他成员发布，核对原产物仍在。viewer 尝试读源码知识应被拒绝。 | `packages/application/tests/code-understanding.test.mjs:58-84`、`packages/application/tests/code-understanding.test.mjs:85-104`、`packages/application/tests/code-understanding.test.mjs:105-125` |
| V17 · P0 | BR-MATERIAL-READ | 同项目两版文本、二进制资料和权限账号 | 用旧引用读指定修订，比较哈希、current 和二进制范围。 | `packages/application/tests/project-material-query.test.mjs:64-89` |
| V18 · P0 | BR-CAPTURE-QUEUE | 同一会话的两事件、可控提取器及时钟 | 让提取器晚于租约返回，并令下一次尝试完成，检查只有当前持有者可写。 | `apps/core-api/tests/memory-personal-governance.test.mjs:116-156` |
| V19 · P0 | BR-MEMORY-ADOPT | 绑定议题与需求，留有可采纳的原方案 | 用过期 head 或只有含糊确认的输入请求采纳，检查无新增验收条件。 | `packages/application/tests/memory-slice.test.mjs:132-151` |
| V20 · P1 | BR-MEMORY-PRIVACY | 同账号在两个项目，另有第二账号 | 同账号在另一项目分别查账号级与项目级记录，再改用另一账号。 | `packages/application/tests/personal-memory.test.mjs:79-95` |
| V21 · P0 | BR-MEMORY-RETRIEVE | 可控引擎映射、已撤回与仍有效来源 | 模拟外部超时或在调用中换绑定，检查检索标头及最终可见来源。 当前所引测试覆盖字面优先、排序与单通道 503；超时、调用中换绑及路由响应标头断言拟补。 | `packages/application/tests/memory-slice.test.mjs:11-37`、`apps/core-api/tests/memory-engine-search.test.mjs:49-55` |
| V22 · P0 | BR-AGENT-CONTEXT | 可信宿主、一次性许可和固定 commit | 同一许可并发调用两次，并模拟第一次远端结果不明，检查 action 回调至多启动一次且许可已消耗。远端是否完成推送需回查仓库。 | `apps/cli/tests/memory-authorization.test.mjs:32-61` |

## 静态核查能说明什么

固定清单有 677 份文件。UA 2.9.8 清点全部文件并生成 35 个语义批次和 1,041 条导入导航边。CodeGraph 1.6.2 的原生索引覆盖 585 份，投影有 12,747 个节点、42,329 条边，报告另有 56,969 个未解析引用。另 92 份未建立原生索引，不能从缺边判定业务路径不可达。图中的文件导航覆盖全清单，业务规则只覆盖实际回读的路径。

本次从 UA 批次 1 定位交接和接入，从批次 2 定位资料查询，从批次 7 定位采集队列，从批次 18 定位任务状态机。随后在该快照的原生索引中按调用方与被调符号查询，并打开固定源码复核。例如记忆路由调用 enqueueMemoryCapture（原生边 23060，对应 `apps/core-api/src/routes/memory.ts:111-116`），议题写入调用 assertProjectAccess（36112，对应 `packages/application/src/requirement-collaboration-use-cases.ts:334-351`），逐项发布调用 frozenQualityMatches（34182，对应 `packages/application/src/intake-use-cases.ts:376-390`）。代码证据和测试锚点的 SHA-256、原生节点及规则关系见可导出的证据清单。

## 尚需实测或补证

| 问题 | 补证材料与判断方法 |
| --- | --- |
| 某条讨论中的“已完成”能否证实 | 找关联任务、真实提交或产物、环境、测试执行和结果。议题引用与 AI 摘要单独不足以判断生产交付。 |
| 切换账号、撤权、归档与并发事件 | 用独立测试库、两账号两设备复现。保存请求号、角色、修订、状态和审计；须同时比较旧引用与新读取。 |
| 外部记忆引擎的质量和延迟 | 在受控引擎比较原始返回、平台权限过滤后的引用、原文读回及状态标头。单个命中或配置中的 URL 无法证明真实召回率、延迟或删除完成。 |
| 远端仓库和本机 Agent 的执行情况 | 用隔离仓库、设备和独立工作区验证 remote 与 commit、源进程停止、租约以及目标进程状态；本轮只见实现和测试定义。 |
| 全项目是否每个分支都核验过 | 导航覆盖 UI、CLI、API、执行器、共享包及运维文件。认证恢复、全部页面渲染、迁移兼容、部署恢复和所有外部接口的细分异常尚未逐条取证。 |

清单 SHA-256 为 `fbef191aec7613bc168d383a3cc49c57cf6220968ef02a3bab4d4cdd483b937c`。草稿包含当前捕获范围内的源码字节；分支名、线上业务数据和某个操作者的配置不能替代此快照标识。
