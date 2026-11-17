# 退款议题的会话写回实验

在仓库根目录用 Node.js 22.21.1 运行 `node --test docs/experiments/memory-harness-pilot/writeback/writeback.test.mjs`。2026-11-10 实测 10/10 通过。每个用例独立创建内存 SQLite，真实执行提交或回滚。测试使用项目已有的 `deriveView` 读取模拟任务的状态。[测试](writeback.test.mjs) · [事务](writeback.mjs) · [任务展示状态](../../../../packages/domain/src/derived-status.ts)

同一段合成会话中，一名成员提出“退款超过七天进入人工审核”，顺带提到喜欢中文提交说明。第一次整理写入议题 `alternative`，公共投影只有退款条件。成员随后明确采纳，事务追加 `decision`、更新可编辑需求的验收条件、保存回执并登记待投影内容。议题成为 `decided`，需求修订从 1 变为 2。已有任务仍引用修订 1，状态为 `ready`。

| 干预 | 观察结果 |
| --- | --- |
| 重放采纳事件或改变重放载荷 | 同载荷返回原回执。改变版本参数返回 `REPLAY_CONFLICT` |
| 伪造正文角色、引用他人陈述、提交个人片段 | 工具输出、助手输出、引语和私有片段未形成公共写入 |
| 捕获后撤权、目标绑定有歧义、议题或需求已变化 | 当前事务拒绝应用。撤权后的历史回执访问也受当前权限检查 |
| 采纳先于它引用的讨论到达 | 缺少已公开的提议时返回 `PROPOSAL_CHANGED`，可在来源到达后重新核对 |
| 既有需求已锁定，或会话试图宣告已落实 | 触发需求变更流程的分支或拒绝未支持的动作；实验只记录错误码 |
| 在最后一步强制投影队列插入失败 | 议题、需求、回执同时回滚。删除故障触发器并重送事件后仅生成一次修订 |

## 对接位置

| 现有 TeamSynergy 语义 | 接入增量 |
| --- | --- |
| 事务内写入议题、审计及议题状态。`alternative` 要求项目写权限，`decision` 要求项目管理权限。已确认决策通过后续决策替代。[议题用例](../../../../packages/application/src/requirement-collaboration-use-cases.ts#L317) | 抽取可接受同一数据库事务的写入函数。由服务端计算议题头的版本见证，持锁复读替代链、归档状态及影响目标 |
| 需求编辑校验管理权限并写 immutable revision。仅 `draft`、`clarifying`、`change_proposed` 可修订。现有 PATCH 接口从服务端读当前版本，调用方没有 `expectedRevision` 输入。[需求用例](../../../../packages/application/src/requirement-use-cases.ts#L514) · [路由](../../../../apps/core-api/src/routes/requirements.ts#L69) | 为自动写回增加提取时绑定的预期修订、关系与影响范围。事务内核对全部对象。已锁定的需求沿用现有变更提议及状态转换，再应用获准的修订 |
| 已有项目材料栅栏、实际项目授权、幂等回执和任务基线约束。[材料栅栏](../../../../packages/application/src/aggregate-lock.ts#L10) · [授权](../../../../packages/application/src/project-access.ts#L65) · [回执](../../../../packages/application/src/handover-use-cases.ts#L227) · [固定基线](../../../../packages/application/src/task-baseline-use-cases.ts#L11) | 在同一 PostgreSQL 事务中按项目栅栏、对象锁的顺序重查主体权限和版本，落业务变更、审计、幂等回执及新增的投影作业。回执绑定捕获事件和片段身份。多议题/多需求变更先确定完整影响集合。远程引擎消费已提交的作业 |

## 证据范围

实验用预标注的会话片段模拟整理器输出。`role`、`origin`、`scope`、`intent` 和指向先前方案的关联均以固定夹具作为输入。调用方传来的字段不能替换来源记录。这里验证了消费这些输入的写入协议，语言模型对引语、反问、隐私及采纳意图的识别准确率仍需真实评测。

项目权限行模拟服务端解析后的有效角色。SQLite 测到了真实事务回滚。上线前还需在隔离 PostgreSQL 上验证项目 ACL 变动、并发编辑、事务栅栏及 revision 竞争。实验只支持一个已唯一关联的议题和一项可编辑需求，投影止于队列，实际学习和索引由引擎实验另行验证。

进入真实宿主时，由捕获通道给消息绑定账号、安装实例、项目、会话、原始角色和不可变来源哈希。模型只提交可核对的源片段、对象与变更建议。可靠的用户原话、采纳语义、有效授权和目标范围共同决定自动应用。单纯标记 `role=user` 无法排除引语和提示注入，来源不清时保留待澄清状态。混合会话的抽取与脱敏须在任何共享引擎上传之前完成。
