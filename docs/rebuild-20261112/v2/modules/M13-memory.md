# M13 项目共识、个人记忆与成员 Agent 接入

成员讨论一个业务问题时可能留下提议、已经确认的决定，或只对自己适用的工作偏好。接手者要知道哪项能引用，是否仍然有效，以及要去哪里核对原文。下列行为来自固定源码；验收是可以复现的场景，其中真实运行证据另见交付记录。

### M13-F01 采集一次成员发言

成员在已绑定的工作区使用自带 Agent。DSH 从原生会话事件接收记录；OpenCode 过滤合成和忽略的片段，并对保存后的用户消息进行核对。平台按身份、项目、会话及事件处理采集。正常结果为持久接收后的 HTTP 202 和可查询的采集编号；模型分类和业务写入随后完成。重复交付必须核对来源，一次有效采集只能产生一次业务结果。验收时在同一会话重送同一事件，看回执与业务记录，再用相同事件标识发送不同原文，观察冲突。模拟延迟处理并查作业状态，不能从 202 推断已形成团队结论。

依据 `apps/cli/src/memory-dsh-capture.ts:82-130`、`apps/cli/src/memory-opencode-capture.ts:27-44`、`apps/core-api/src/routes/memory.ts:111-128`、`apps/core-api/src/memory-capture-queue.ts:41-78`。租约过期的测试定义见 `apps/core-api/tests/memory-personal-governance.test.mjs:116-156`。

### M13-F02 记录讨论并在满足条件时采纳为需求

讨论可独立留存。要把某项采纳写入指定需求，需核对项目、议题和需求、操作者权限、会话所见的议题头和需求修订。读取最近决定之后唯一未撤回的备选，确认其讨论来源、文字及基础修订仍匹配。采纳在同一事务内写入决定、验收条件与来源，再排队投影。任务实施、自测和验证由 M07 管理。验收时用有效方案和准确确认语句查看需求修订与回执；再用含糊的“可以”、过期修订或两条未定备选，检查是否要求澄清以及有无部分写入。

依据 `packages/application/src/memory-slice-use-cases.ts:184-197`、`packages/application/src/memory-slice-use-cases.ts:224-283`。并发和含糊引用的测试定义见 `packages/application/tests/memory-slice.test.mjs:39-80`、`packages/application/tests/memory-slice.test.mjs:132-151`。

### M13-F03 带着来源接手工作

成员 Agent 启动后按当前问题选项目或个人范围。项目检索可向 Wiki/Core 获取候选，个人范围可查 OpenViking；平台结合当前权限和来源有效性返回结果。当绑定在调用期间改变，或引擎部分不可用时，查看实际响应头及平台仍可核实的证据。文档卡片中的 source 指定修订，正文通过资料工具读取。验收时先用项目查询找一份规范，核对状态为 documented，再读原文；撤回来源或切换项目后重查，不能沿旧引用获取原先可见内容。

依据 `apps/core-api/src/routes/memory.ts:38-104`、`apps/core-api/src/memory-material-runtime.ts:51-58`、`packages/application/src/memory-slice-use-cases.ts:287-311`、`apps/cli/src/agent-capabilities.ts:70-85`。故障降级测试入口 `apps/core-api/tests/memory-engine-search.test.mjs:14-35`。

### M13-F04 查看、修订及撤回私有经验

账号持有人在“我的记忆”查看适用范围、当前文本、来源、历史版本和投影状态。偏好默认按项目适用；原话支持明确账号声明时才可跨项目使用。更新或撤回提交打开时的修订号，系统锁定同一根记录后创建新版本，并安排旧投影清理。验收时让两个窗口打开同一版本，第一个成功更新，第二个用旧版本撤回应收到冲突；再读取新版本撤回，检查成员检索与账号管理历史各自可见的内容。另一个账号用原记录编码访问，应无法获得该记录。

依据 `packages/application/src/personal-memory-use-cases.ts:23-55`、`packages/application/src/personal-memory-use-cases.ts:81-114`、`apps/core-api/src/routes/personal-memory.ts:29-45`、`packages/application/src/memory-slice-use-cases.ts:116-136`。跨项目适用条件测试 `packages/application/tests/memory-slice.test.mjs:201-220`。

### M13-F05 区分检索上下文与本次动作授权

同一会话反复问同一事项，工具回执可记录已读来源，下一次查询重新核对来源和版本并减少重复内容。记住成员的提交说明习惯后，真正执行带有一次性许可的操作仍须匹配本次账号、项目、会话及目标摘要。许可在动作回调开始前消耗；远端结果未知时需单独复核。验收时对同一许可发起两个回调，观察最多一个获准启动，然后更换 commit 重试并检查失败原因。是否推送成功须到远端核对。当前源码给出许可账本能力，具体宿主的所有 Git 操作是否都经过该账本须按集成路径另验。

依据 `apps/cli/src/memory-mcp.ts:151-183`、`apps/cli/src/memory-authorization.ts:60-122`。并发、失败与过期的测试定义 `apps/cli/tests/memory-authorization.test.mjs:32-83`。
