# M12 系统文档 Agent 修改稿：当前代码逆向需求与业务规则

仅针对授权原生项目文档生成修改稿；与本机任务Agent、自动需求发布和外部工具执行区分。模型无平台写工具，正式正文必须当前用户明确采用。

## 来源与事实级别

run NSG3TKRB16Y9F6Y203WB；snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；显式工作区草稿，基底提交 92728fbec04cfa34fee4421cb0a9319d1b755164。原始源码 manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；图 artifact SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8。UA 2.9.8 与 codegraph 1.6.2 为导航，Skill 2.2.0 提供逆向方法；事实证据均回查同一 snapshot 的原始文件。图谱解释仍为 inferred。

源码证据为 observed_in_code，只证明当前实现；未获业务批准。docs/experiments 只作全局比较材料，不作为本章新增业务能力的语义权威。

## 能力目录

- REQ-INT-M12-01：按固定文档版本幂等创建修改稿任务
- REQ-INT-M12-02：以有界候选和执行租约领取任务
- REQ-INT-M12-03：以固定受限模型配置执行无工具草稿生成
- REQ-INT-M12-04：保存完整修改稿、质量与提案摘要
- REQ-INT-M12-05：请求者读取、取消和拒绝自己的修改稿
- REQ-INT-M12-06：仅在明确哈希和当前授权下采用修改稿

## 业务规则表

|规则|触发与资格条件|结果/排序/执行约束|例外和保留事项|原始证据|测试断言|
|---|---|---|---|---|---|
|BR-INT-M12-01|当前有原生文档编辑权的请求者；POST project system-agent/jobs；执行器已配置；项目active、原生文档及允许目录可写；正整数base_revision。|BR-INT-M12-01：相同key精确回放先于当前文档revision检查，已有任务仍可返回；新key必须匹配当前头。；BR-INT-M12-01：文档正文≤100000字符，组合JSON快照≤300000字节；实际HTTP另受默认1MiB。；状态：只创建queued job及快照，不变文档revision。|同key不同输入→冲突。；业务关联视图或受限系统目录、超预算、quote不在正文→拒绝入队。；引擎未配置→HTTP503，不能先排无法执行的队列。|packages/application/src/system-agent-use-cases.ts:139–174 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148；apps/core-api/src/routes/system-agent.ts:6–18 @ 629772266060f896c2be9803c00f7e15555071269067b51675106679ae6e2829|REQ-INT-M12-01-AC01：精确幂等回放不创建新任务，即使文档后来更新。；REQ-INT-M12-01-AC02：无效quote和不可编辑来源不入队。|
|BR-INT-M12-02|平台内部执行器；worker轮询claimNextJob / heartbeat / recover；平台内部调用，executorId非空；执行元数据受限且Skill摘要为64位SHA。|BR-INT-M12-02：created_at排序没有稳定ID次序，skip-locked且候选上限10，不能承诺全队列严格FIFO。；BR-INT-M12-02：过期任务显示failed并要求重新发起，不自动无限重排队。；状态：queued→running或failed；有效心跳延长租约；过期running→failed。|权限/源版本失效→失败并审计，继续本轮其余候选。；租约过期/取消/执行器或token不符→拒绝心跳、完成与失败写回。|packages/application/src/system-agent-use-cases.ts:219–280 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148；packages/application/src/system-agent-use-cases.ts:312–322 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148；apps/core-api/src/system-agent-worker.ts:25–90 @ 514f7095e7d9cd123c54ba4251883341b1bf968081bf9ff0ef0e7de61d522d0a|REQ-INT-M12-02-AC01：两个执行器不能成功领取同一job。；REQ-INT-M12-02-AC02：过期任务恢复后迟到结果不能变awaiting_review。|
|BR-INT-M12-03|平台执行器；SystemAgentRuntime.draft；显式启用、有效DSH路径/私有工作根及凭据；运行时版本由平台固定。|BR-INT-M12-03：模型只收到主机提供的证据，无平台凭据和写接口；模型自报evidence不是经核验引用。；BR-INT-M12-03：默认超时180000ms、允许1000–600000；默认16384 tokens、允许512–32768；协议8MiB上限，失败保留目录数0–20。；状态：本机临时执行目录和内部作业状态变化；正式文档不变。|未配置、协议异常、max-tokens/中断、超时→失败，不保留半篇可采用草稿。；心跳失效或关闭worker→中止模型并等待进程退出，迟到结果不提交。|apps/core-api/src/system-agent-runtime.ts:58–152 @ 45227f28858e1ce45357fa084cb1c1904bf78f289ce885e67ca7733a3cc46773；apps/core-api/src/system-agent-runtime.ts:155–239 @ 45227f28858e1ce45357fa084cb1c1904bf78f289ce885e67ca7733a3cc46773；apps/core-api/src/system-agent-runtime.ts:244–368 @ 45227f28858e1ce45357fa084cb1c1904bf78f289ce885e67ca7733a3cc46773；apps/core-api/src/system-agent-worker.ts:1–109 @ 514f7095e7d9cd123c54ba4251883341b1bf968081bf9ff0ef0e7de61d522d0a|REQ-INT-M12-03-AC01：达到token上限或截断JSON不成为可审阅稿。；REQ-INT-M12-03-AC02：模型请求不能使用工具，凭据不进入提示词。|
|BR-INT-M12-04|持有有效租约的内部执行器；completeJob / failJob；running且执行器/token/租约匹配，当前请求者仍可编辑源文档。|BR-INT-M12-04：质量报告和proposal_hash用于明确采用，不自动更新原文；质量报告并非通过业务验收。；状态：running→awaiting_review或failed；正式文档revision不变。|不合法/不完整proposal→拒绝，不转可审阅。；期间失去write权限→job failed、令牌清空，禁止新草稿写回。；执行失败→记录受限失败说明，清空令牌/租约并审计。|packages/application/src/system-agent-use-cases.ts:29–52 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148；packages/application/src/system-agent-use-cases.ts:255–309 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148|REQ-INT-M12-04-AC01：有效完成只生成待采用修改稿。；REQ-INT-M12-04-AC02：执行中撤权后完成被拒且正文不变。|
|BR-INT-M12-05|创建job的当前请求者；job list/get/cancel/reject；当前用户active、project读权存在，job.requester_id等于自身。|BR-INT-M12-05：取消/拒绝只改变job，不回滚或写入原文；取消可阻止迟到完成。；状态：queued/running/awaiting_review→cancelled；awaiting_review→rejected。|其他管理者但并非请求者→不能仅凭管理者身份读/取消他人job。；不可处置状态→拒绝；已cancelled/rejected相同处置回放返回现有状态。|packages/application/src/system-agent-use-cases.ts:92–137 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148；packages/application/src/system-agent-use-cases.ts:176–189 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148；apps/core-api/src/routes/system-agent.ts:20–29 @ 629772266060f896c2be9803c00f7e15555071269067b51675106679ae6e2829|REQ-INT-M12-05-AC01：管理者不能读取另一请求者job正文。；REQ-INT-M12-05-AC02：取消running后迟到完成不能复活任务。|
|BR-INT-M12-06|原请求者且当前仍有文档编辑权；POST job/apply；awaiting_review、proposal存在；提交proposal_hash与base_revision完全一致。|BR-INT-M12-06：模型生成与采用是两个明确操作；未采用草稿不会变正式文档。；状态：document revision+1；job→applied并持久applied_revision；同事务审计。|hash/base或当前版本不匹配→拒绝，修改稿仍待用户处理，不覆盖新正文。；已applied精确重试→当前权限/hash/base仍先校验，再返回既有结果，不追加第二版本。|packages/application/src/system-agent-use-cases.ts:191–217 @ fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148|REQ-INT-M12-06-AC01：采用后精确重试不会重复追加版本。；REQ-INT-M12-06-AC02：人工先修订使旧稿不可采用。|

## BR → REQ / AC / 验证矩阵

|BR|REQ|Feature|AC|计划状态|
|---|---|---|---|---|
|BR-INT-M12-01|REQ-INT-M12-01|INT-FEAT-M12-jobs|REQ-INT-M12-01-AC01|not_run，未来计划|
|BR-INT-M12-01|REQ-INT-M12-01|INT-FEAT-M12-jobs|REQ-INT-M12-01-AC02|not_run，未来计划|
|BR-INT-M12-02|REQ-INT-M12-02|INT-FEAT-M12-jobs|REQ-INT-M12-02-AC01|not_run，未来计划|
|BR-INT-M12-02|REQ-INT-M12-02|INT-FEAT-M12-jobs|REQ-INT-M12-02-AC02|not_run，未来计划|
|BR-INT-M12-03|REQ-INT-M12-03|INT-FEAT-M12-runtime|REQ-INT-M12-03-AC01|not_run，未来计划|
|BR-INT-M12-03|REQ-INT-M12-03|INT-FEAT-M12-runtime|REQ-INT-M12-03-AC02|not_run，未来计划|
|BR-INT-M12-04|REQ-INT-M12-04|INT-FEAT-M12-runtime|REQ-INT-M12-04-AC01|not_run，未来计划|
|BR-INT-M12-04|REQ-INT-M12-04|INT-FEAT-M12-runtime|REQ-INT-M12-04-AC02|not_run，未来计划|
|BR-INT-M12-05|REQ-INT-M12-05|INT-FEAT-M12-jobs|REQ-INT-M12-05-AC01|not_run，未来计划|
|BR-INT-M12-05|REQ-INT-M12-05|INT-FEAT-M12-jobs|REQ-INT-M12-05-AC02|not_run，未来计划|
|BR-INT-M12-06|REQ-INT-M12-06|INT-FEAT-M12-runtime|REQ-INT-M12-06-AC01|not_run，未来计划|
|BR-INT-M12-06|REQ-INT-M12-06|INT-FEAT-M12-runtime|REQ-INT-M12-06-AC02|not_run，未来计划|

详细结构化REQ/AC/计划在同模块需求条目与本地章节；均未执行，不构成批准或安全证明。
