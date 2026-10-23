# 共享上下文与跨人交接设计

- 状态：设计已按用户指示进入首版实现；实际支持范围与命令见[使用指南](32-context-handover-user-guide.md)。本文仍含后续设计，不改变已接受 ADR，也不代表全部阶段已完成。
- 日期：2026-10-12
- 范围：同一平台项目内，A 将未完成研发任务交给 B；B 使用自己的电脑、代码仓库权限和 Agent 登录继续执行。
- 关联：[架构基线](00-architecture-baseline.md)、[Context Pack](13-context-pack-design.md)、[交接文档库](26-handoff-document-library.md)、[需求版本与决策](28-requirement-discovery-decisions-and-review.md)。

核心选择：Task 保持不变，A 的 Run 与作者身份保留；B 创建关联原 Run 的新 Run 和独立工作区。交接转移版本明确的工作成果与执行责任，默认创建新的 Agent 会话。原生会话恢复只作为兼容适配器的可选优化。

## 1. 目标与边界

### 用户场景

A 用 Claude Code 实现一半功能，需要离开；B 在另一台 Windows 电脑用 Codex 接手。B 能看到已确认需求、决策、已完成内容、失败尝试、待确认事项、准确代码快照和旧验证结果，不需要 A 再口头复述。A 离线后，B 仍能从平台与 Git 远端恢复现场。

### 必须满足的约束

1. 不改写旧 Run 的 principal，也不将接手伪装为任务完成或开发失败。
2. 同一 Task 同时只有一个有平台写权限的执行 Run；转交期间默认暂停执行。
3. B 使用自己的项目身份、仓库凭据、Agent 登录和本机路径，不继承 A 的 Token、绝对路径或工具审批。
4. 交接时冻结上下文与代码版本；恢复时必须检查与当前项目事实的差异。
5. 交接不使旧测试自动适用于新代码或新环境，不自动满足验收。
6. 可移植交接是主路径，不要求恢复 A 的原生 Claude/Codex 会话。

### 首版范围

- 支持同一项目、同一 builder Task、running 或 self_tested 阶段的交接；self_tested 接手后回到 running 并保留旧证据。
- 支持一个 Git 仓库、平台已经登记的 repository、源远端可访问的 Commit 快照。
- 支持人工审阅的结构化交接摘要；由 Agent 起草，但只发布明确选中的内容。
- 接收者必须已是 active 项目成员。当前权限沿用 Owner 改派任务的边界：A 可准备，Owner 发布，B 接收；A 为 Owner 时可直接发布。
- 不包含跨平台实例迁移、整机/进程迁移、凭据共享、任意聊天全量自动上传、无人值守强制夺取离线电脑、通用 Agent 编排引擎。
- 无远端 Git、二进制文件、LFS、submodule、多仓库交接保留为下一阶段；遇到这些恢复依赖时首版给出明确不可发布原因。

## 2. 现有能力与必须补齐的边界

以下为当前工作树的静态核查，基线 HEAD 为 09dd69e，并包含当时已有的 package.json、eslint.config.js、project-document-use-cases.ts 未提交修改及本地安装辅助文件。链接的行号是本次核查位置，后续应随实现更新；旧设计文档不作为已实现证明。

| 当前能力 | 源码入口 | 复用方式与缺口 |
|---|---|---|
| Owner 分派、Assignee 领取、版本并发检查 | [task-service](../packages/application/src/task-service.ts)，L283、L370 | 复用成员与并发规则；running 无法再次 assign/claim，需要独立 handover 用例 |
| Task、Run、Workspace 和 active 唯一约束 | [schema](../packages/persistence/src/schema.ts)，L765、L787 | 保留；新增 Run 谱系、暂停/转交/准备状态与执行代数 |
| 固定任务的需求/文档 Revision，来源变化提示 | [project-use-cases](../packages/application/src/project-use-cases.ts)，L417；[task-service](../packages/application/src/task-service.ts)，L668 | 升级成所有供给材料的不可变 manifest；不能将 base_snapshot 当作完整项目上下文版本 |
| 项目文档、需求、设计和交接文档渲染 | [pack](../apps/cli/src/pack.ts)，L160、L284 | 扩展交接摘要和 manifest；快照下载不能再次读最新正文替代被固定版本 |
| 项目工作空间、clone/attach、真实 Worktree | [project-workspace](../apps/cli/src/project-workspace.ts)，L163、L193；[git-workspace](../packages/integrations/src/git-workspace.ts)，L29 | 复用本地仓库定位与独立工作区；Worktree 本身不传输跨机器代码 |
| Agent start/stop/resume、进程状态 | [agentd](../apps/agentd/src/index.ts)，L219、L516、L613；[supervisor](../apps/agentd/src/supervisor.ts)，L13、L73 | stop 仅停止 Session，不结束 Run；resume 不是原生会话恢复；仅有末尾 50 行输出，不能当完整 transcript |
| Artifact / Evidence / 审计 | [schema](../packages/persistence/src/schema.ts)，L819；[task-service](../packages/application/src/task-service.ts)，L771、L826 | 复用索引和审计；Artifact 是 URI 元数据，不是现成的文件上传服务 |
| 项目成员访问校验 | [project-use-cases-project](../packages/application/src/project-use-cases-project.ts)，L339 | 提取统一守卫覆盖新 API；不能复制当前不带 principal 的任务读取路径用于私密上下文 |
| docs CLI 是文档库命令（handoff 为兼容别名） | [tsp](../apps/cli/src/index.ts)，L1883 | 保留语义；新的运行交接使用 task handover，避免命名混淆 |

## 3. 共享上下文的三层模型

### 项目事实层

继续使用既有需求 Revision、需求文档 Revision、议题决策记录、设计原型 Revision 和交接文档 Revision。Agent 的猜测和交接摘要不能直接覆盖已确认事实。决策引用固定记录 code 与其替代关系，不将讨论全文当作已生效决策。

### 任务快照层

新增 ContextSnapshot：服务端按权限编译、不可变、带内容哈希。包含任务合同及版本、验收条目、范围、需求/文档/决策/设计/交接材料的精确版本、作者和来源引用。缺少版本实体的材料将正文作为快照内不可变内容保存，而不是只保存指向最新内容的 URL。

编译使用一致数据库视图，保存 material_revision_vector。ready 检查一次，activate 在状态转换事务内对相关需求、文档、议题等版本头记录取得共享锁后再次比较；相关写用例使用同一聚合锁约定，保证比较和激活之间不能插入材料更新。事务提交后的新变更按普通执行漂移处理，不宣称快照永远最新。集成测试必须覆盖资料更新与 activate 并发。

快照哈希使用确定性 UTF-8 JSON 编码：对象键排序，数组按 schema 规定顺序，保留字符串原文，排除 hash 自身、临时下载 URL、机器路径和租约信息；schema_version 参与哈希。数据库中的原快照与每次下载的成员权限分别校验。

任务创建时固定的需求版本优先于最新版本。其他材料在源准备阶段固定；如果与任务基线矛盾，标记阻塞，由 Owner 显式处理。上下文下载先验证项目成员权限，再解析引用；缺少必须材料的权限时整包拒绝，不生成看似完整的残缺包。

### Run 工作层

交接摘要包含：goal、completed、remaining、decisions_applied、assumptions、open_questions、failed_attempts、next_actions、evidence_refs。每项可以带 message/source 引用与作者。假设保持假设状态；失败尝试有复现线索，不能只写“这个方案不行”。

第一版只收显式发布的摘要和选中材料。私人对话、个人偏好、终端历史、原生 Agent Home、思考内容及凭据默认留在本机。自动 transcript 采集在后续适配器中建设，不能把 stdout 的 50 行尾部包装成完整对话。

### B 的上下文组装

1. B 当前的系统规则、项目权限和工具定义。
2. 快照对应的任务必读卡与交接摘要。
3. 固定版本的相关事实和材料导航。
4. 明确标注的上游变化清单。
5. 必要时按 message cursor/source reference 展开原文。

必读卡与摘要初始预算以 2k–4k token 为试点目标，超限提示拆分，并不保证任何 Agent 的 token 计算一致。完整原文留在按需读取层。首版用精确引用和数据库查询即可，不引入向量数据库。

## 4. 用户流程

~~~mermaid
sequenceDiagram
    participant A as A 的电脑与 Agent
    participant C as Project Core
    participant G as Git 远端
    participant B as B 的电脑与 Agent
    A->>C: 预检后准备交接，保留目标 B
    C->>C: 锁 Task，暂停源 Run，撤销旧写租约
    A->>A: 停止执行，审阅摘要和选中文件
    A->>G: 发布不可变代码快照
    A->>C: 保存上下文、Commit 与停止确认
    C->>C: Owner 发布交接包
    B->>C: 接收责任，尚不启动 Agent
    B->>G: 获取准确 Commit
    B->>B: 创建独立 Worktree，校验并预检
    B->>C: 提交恢复就绪回执
    C->>C: 原子改派并激活 B 的新 Run
    B->>B: 用自己的登录启动新 Agent 会话
~~~

### A 准备与发布

先做本地只读预检，展示目标人、文件清单、敏感文件排除项、代码传输方式和是否需要 Owner 发布。进入 prepare 后暂停原 Run，不再接受该 Run 的业务写入；本机停止 Agent 后保存明确的停止回执。

只有源执行已停止、摘要已审阅、代码快照已发布、引用材料可用，才能从 preparing 发布为 published。无法控制的外部 Agent 允许人工停止并标注 manual_confirmation；这不等价于远程证明该电脑没有其他进程。首版不支持源电脑离线时自动强制发布。

准备失败时保留状态和错误，允许修复后重试或取消；不会假装源 Run 已完成，也不会自动在 A 的机器重启 Agent。

### B 接收与恢复

B 在 Web 看到摘要、来源版本、代码快照、交接原因、当前阻塞和预计恢复步骤。接收表示同意接续该任务，不表示已验收 A 的成果，也不会立即成为 active 执行者。

B 使用本机项目绑定、Git 凭据和目标目录恢复。新 Worktree 必须来自快照指定 Commit；既有脏目录不能覆盖。依赖准备脚本展示来源并受本机 Agent/用户执行策略控制，下载交接包本身不运行任意命令。

恢复完成后 B 提交带目标 device、workspace digest、Commit、ContextSnapshot hash 和准备 attempt 的回执，标注 assurance=client_reported。服务端能核实身份、版本、attempt 和执行权，不能仅凭这些字段证明 B 的磁盘内容正确；本机受信 CLI 负责实际校验并在启动前再次检查。回执绑定具体 manifest hash，不能跨版本复用。

服务端重新校验权限、材料版本及交接状态，再原子激活 B Run。Agent 只在激活成功后启动；若启动失败，B 保持责任人，通过同一 Run 重试，不生成重复交接。

### 项目事实在交接中变化

- 不静默替换已发布包。B 获取 drift 清单，看到变更的需求、决策、文档或任务合同。
- unresolved handover 期间，任务合同编辑直接拒绝；需求、文档和决策仍允许独立更新。强相关事实漂移使 ready/activate 失败，Owner 可以明确批准继续原固定版本，或者取消交接后更新任务合同并重新发起。
- 若需要采用新版本，生成新的交接记录和 ContextSnapshot，保留与被替代交接的关联；源 Run 从未恢复时可复用其已有停止回执和不可变代码快照，无需重新启动 A。Owner 只能重新编译上下文，不能伪造源机器停止或新代码成果；B 必须重新接收和 ready。
- 继续旧需求版本属于显式决策，必须记录理由、批准人和适用范围；它不豁免已经变化的验收合同。
- 纯导航/描述变化可告知而不阻断，规则按材料类型列出，不能让 Agent 自行判断全部变化“不重要”。

## 5. 状态、执行权与失败恢复

### Handover 状态

~~~text
preparing → published → accepted → restoring → ready → completed
    └──────────────→ cancelled / expired ←──────────────┘
~~~

completed 仅表示交接完成，不表示 Task 完成。preparing 可由源本人或 Owner 取消，源准备超时仅标记需处理，不自动重启执行；published/accepted 可拒绝或到截止时间转 expired，restoring/ready 的超时由准备租约处理。取消与过期都是服务端幂等状态转换；恢复失败记录 last_error，允许同一 attempt 重试。

### Run 与 Task

- Run 增加 suspended、preparing、transferred；已有 active/completed/failed/cancelled 保留。明确运行状态枚举迁移与 API 兼容，不能假装只新增一张表。
- 准备阶段：A Run active → suspended；Task 业务状态暂不改变，但存在 unresolved handover 时禁止普通 claim、submit、verify、改派和任务合同编辑。
- 恢复阶段：B Run 为 preparing，与 A Run 通过 continued_from_run_id 关联；此时不能执行 Agent、提交产物或验收。
- 激活阶段：A suspended → transferred，B preparing → active；改 Task assignee 为 B，Task 进入 running。原 self_tested 的证据留存，但展示为待重新确认。
- 不将 Task 退回 assigned 后拼接旧 assign/claim。以 handover.activate 领域命令完成这些变化，保留现有任务状态机的提交/验收语义。

### 原子性与租约

新增任务 execution_epoch 与 device 绑定的短期 RunLease。prepare、activate、cancel/resume 都锁 Task 行并使用预期版本；prepare 立即推进 epoch，使源旧租约失效。激活在同一事务中验证 ready 回执、写 Run/Assignee/epoch/base_snapshot、结束交接并写审计。

保留 uq_runs_task_active；另加每任务最多一个 unresolved handover、每交接最多一个有效 preparing target Run 的约束。准备 attempt 与 API Idempotency-Key 均绑定调用身份、操作与请求摘要，避免重试创建两个 Run。

所有执行写入入口，包括旧 submit/verify、Session 业务上报和将来的 MCP，都必须校验 Run status、principal、device、epoch、lease expiry。只在新交接 API 检查无效；必须防止旧入口或 legacy identity 绕过。已参加交接的 Run 不接受仅 X-Principal-Code 的执行写入。

停止确认与有限诊断属于独立的交接控制通道。prepare 返回绑定 handover、source_run、source_device、attempt 和冻结 epoch 的短期 preparation grant；即使源执行租约已撤销，源本人仍可凭登录身份和该 grant 提交停止成功/失败。它不能写产物、验收或续租，取消后失效，不放进共享包。避免撤销源租约后再要求源通过已失效租约证明停止。

本机 watchdog 发现租约失效或网络断开且租约到期后停止托管 Agent。平台 fencing 能阻止旧机器继续写平台状态，不能撤销它的 Git 远端凭据或物理阻止离线编辑；交接快照使用不可变 Commit，分支后续移动不改变 B 的基线。

### 失败处理

| 场景 | 确定行为 |
|---|---|
| A 在 prepare 后崩溃 | A 保持 suspended，无可用完整包时不能 publish；重连后重试或 Owner 取消 |
| B 无仓库权限或无法恢复 | 不 activate；记录原因，A 保持暂停，可重试、拒绝或取消 |
| B 接收后退出 | 准备租约超时，终止未激活的 preparing Run；不能因此自动启动 A |
| activate 请求超时 | 使用同一幂等键查询原结果，返回同一个 B Run，不重复创建；Session start 也以 Run/device/epoch/start_key 去重，避免启动两个进程 |
| 两台 B 设备同时恢复 | 只允许一个有效准备 attempt；旧 attempt/epoch 的 ready 回执拒绝 |
| 交接取消/过期 | 终止 B preparing Run；A 仍 suspended，明确 resume 后新租约生效 |
| A 在 B 激活后重连 | 旧 epoch 的上报/提交拒绝；原工作区保留供检查，不自动清理 |
| B 被移出项目 | 下载、准备、激活和续租均重新授权；拒绝继续，Owner 处理重新分派 |
| 本地恢复目录部分写入 | 记录本地 recovery journal，重试只复用同一 attempt；不覆盖用户目录 |

resume 是授权后的执行恢复，不承诺 Agent 原生对话续接。原 Run 尚 suspended 且无有效交接时，仅源本人及获授权设备可领取新租约并恢复；Owner 可以管理流程，不能冒充源用户在其电脑启动。双方离线则继续暂停。源永久失联且没有完整已发布包时，首版不提供无依据的自动恢复。transferred Run 永不重新激活，只能发起新的反向交接。

## 6. 代码快照与产物传输

### 首版默认 Git 远端

代码 manifest 至少保存 repository_code、规范远端标识、base_commit、snapshot_commit、snapshot_tree、snapshot_ref、选中文件及其摘要。代码路径均为仓库相对路径；A 的本机绝对路径不进入便携包。

干净工作区直接使用已发布 Commit。脏工作区从 HEAD 初始化临时 Git index：选中路径采用最终 working-tree 内容，选中删除也记录，未选中的改动保持 HEAD 内容；使用 NUL 分隔路径处理特殊文件名。构造快照 Commit 后推送专用交接 ref；原 index、HEAD、当前分支和工作区保持不变。目标恢复的是该最终树，不还原 A 的 staged/unstaged 划分；同一文件的两个版本不能由单一 Commit 同时表达。

跟踪文件与选中的未跟踪文件必须列出，展示最终 snapshot diff 供审阅；默认排除凭据、Agent Home、缓存、运行日志及工作区私有目录。冲突 index、选中文件外的必要依赖或无法确认的 LFS/submodule 内容阻止首版发布。文件一致性按 Git 规范化后的 blob/tree 校验，Windows 换行、大小写和 filters 的差异单独预检，不承诺跨操作系统字节完全相同。

Git 适配器校验 repository 关联、Commit 对象类型、相对路径和快照完整性；B fetch 后核对准确 Commit、tree 与 manifest。Git 内容标识不代替平台包的 SHA-256，也不证明源码可信。交接 ref 和 ContextSnapshot 被有效 Run/交接引用时不能自动回收。

每个材料引用声明 required 或 optional。required 正文/报告必须已经在 SQL 快照、Git 快照或可独立获取的持久托管位置，缺失则阻止发布或目标 ready。A 的 file URI、localhost URL、短期下载链接不能充当必需材料；optional 历史报告可展示 unavailable，不能假称已传输。Core 不自动抓取任意 URI；B 使用自己的权限验证访问，首版必要文本报告可作为有大小上限的快照内容保存。

### 下一阶段的离线与二进制支持

无 Git 远端时可提供 bundle；未提交变化也可用 binary diff 与选中文件清单，但必须携带 base_commit 并验证恢复树。不要把 format-patch 当作未提交工作区快照；不要把 bundle 当作全目录备份。

BlobStore 仅保存 Git 未托管的报告、显式文件和可选 bundle/patch，Artifact 继续作为索引。首版不引入对象存储依赖；后续可以先用 Core 本地目录加数据库元信息，提供按项目鉴权、限额、内容哈希、原子上传和下载接口，再适配 S3。

归档导入必须拒绝绝对路径、路径穿越、外部链接、重复路径、超量文件与解压膨胀，不隐式执行 hooks 或脚本。LFS/submodule 必须单独声明对象可获取性与授权；多仓库需要每仓库的快照与整体恢复校验后才能激活。

## 7. 数据模型与接口

### 首版新增与扩展

| 对象 | 最少字段/职责 |
|---|---|
| context_snapshots | code、project/task/source_run、schema_version、manifest、summary、hash、created_by、created_at；不可变，固定版本正文或引用 |
| task_handovers | from_run、to_principal、published_by、context_snapshot、workspace_manifest、state、target_run、attempt/version、supersedes_handover、deadline、last_error、各阶段时间 |
| run_leases | run、device、epoch、token_hash、expires_at、revoked_at；凭据不进入 Context Pack |
| runs 扩展 | continued_from_run_id、handover_id、context_snapshot_id、execution_epoch；新增状态 |
| tasks 扩展 | execution_epoch；沿用 base_snapshot 保护任务并发，两个版本含义不能混用 |
| 幂等回执 | handover 命令按 principal/device、operation、key 和 request_hash 保存结果；可作为该领域的持久记录，不建通用工作流引擎 |

所有新实体沿用内部 bigint 关联和服务端生成的 20 位公开 code。外部 API/CLI 不传 bigint。context_snapshots.manifest 使用带 Zod schema_version 的结构，不接受任意可执行对象或反序列化代码。

### 建议接口，均尚未实现

~~~text
POST /tasks/:task_code/handovers/prepare
PUT  /handovers/:handover_code/draft
POST /handovers/:handover_code/source-stop-ack
POST /handovers/:handover_code/publish
POST /handovers/:handover_code/accept
POST /handovers/:handover_code/restore
POST /handovers/:handover_code/ready
POST /handovers/:handover_code/activate
POST /handovers/:handover_code/cancel
GET  /handovers/:handover_code
GET  /context-snapshots/:snapshot_code
POST /runs/:run_code/resume
POST /runs/:run_code/lease/renew
~~~

prepare/draft/source-stop-ack 仅允许源本人及其设备完成本机事实回执；Owner 可以管理流程但不能冒充源设备已停止。替代已取消交接时，Owner 可通过 prepare 指定其公开 code，复用既有冻结成果并生成新的上下文，但必须确认源未恢复、目标 Run 未激活。publish 仅 Owner；accept/restore/ready/activate 仅目标本人及有效准备设备；cancel 为源本人、目标拒绝或 Owner，按阶段约束。所有读取仍须 active 项目成员身份。

draft 中有大小上限的结构化摘要和准备凭据，未发布内容仅源本人和项目 Owner 可读；已发布材料按项目共享语义允许 active 成员读取，只有目标人能接收和激活。准备凭据始终只返回获授权源设备，不随草稿展示。发布后不可再改摘要、目标或 Commit；变更生成新快照/新交接版本并撤销旧 ready。Agent 不得伪造 published_by 或接手人身份。

agentd 必须改走身份绑定的 HTTP Session/事件/租约 API，禁止接收远端数据库连接串；现有 last_output 可保留作诊断，但不作为恢复事实。Session start/stop 与 Run 状态变化通过应用用例明确协调。

### CLI 与本地文件

~~~text
tsp task handover prepare <task_code> --target <user_code> --run <source_run_code> --summary <reviewed.json> --repo <source_repo> --repository <repository_code> --agent-stopped
tsp task handover show <handover_code>
tsp task handover publish <handover_code>
tsp task handover accept <handover_code>
tsp task handover restore <handover_code> --repo <local_repo> --dir <new_worktree>
tsp task handover activate <handover_code>
tsp task handover activate <handover_code> --agent-command <local_agent_command>
tsp task handover cancel <handover_code>
tsp context show <snapshot_code>
tsp context diff <snapshot_code>
~~~

首版 `prepare` 在暂停或推送前核对任务项目、登记仓库和本机远端；默认选取安全的变更文件，也可通过 `--paths <files...>` 指定相对文件路径。外部 Agent 必须先人工停止并显式传 `--agent-stopped`；托管进程使用 `--managed-agent`，CLI 核实本机停止记录后提交回执。摘要文件至少有 `goal`，其余字段为字符串数组；不要把私人对话或凭据写入摘要。

准备中网络失败可重复同一条 `prepare`：本地保存原始请求和幂等键，服务端以原准备回执刷新短期授权，复用已发布 Commit。无法恢复本地原始请求时会明确拒绝推送，需取消交接、显式恢复源执行后重新准备。

activate CLI 先确认本地 ready，再请求服务端激活；不带 `--agent-command` 时仅激活并输出 `brief_path`。带该选项时以持久化的幂等 start_key 启动新 Agent。自定义命令通过 `ACP_BRIEF_PATH` 读取固定任务简报，使用本人登录；默认 Codex 可单独执行 `agentd start --run <new_run_code> --workspace <new_worktree> --prompt <brief_path>`。响应丢失时使用原请求与原幂等键恢复结果。

目标电脑在 `AGENTCTL_HOME/handovers`（默认用户目录 `.agentctl/handovers`）保存私有恢复记录、租约、`.context.json`、`.brief.md` 和 `.materials/` 来源原文；工作树旁保存 `<new_worktree>.acp-handover.json` 恢复 journal。共享包只包含便携相对路径和引用。Submit/Verify 使用设备身份自动读取或领取当前执行代数的租约；普通 Verifier Run 同样支持，不要求它具备交接记录。

后续可将这些材料并入既有 pack 的统一目录；首版固定来源正文与版本引用已经随恢复落盘。现有 handoff/ 文档库目录与 tsp docs 命令继续保留原用途。

## 8. 外部能力复用判断

| 来源 | 结论 | 具体边界 |
|---|---|---|
| 原生 Git | 直接复用 | Worktree 隔离、push/fetch/Commit 传输；bundle 为后续离线路径。快照选择、权限、恢复回执由我们实现 |
| 现有 pack / repository / auth / audit | 直接复用并扩展 | 保留同一 Core；修正读取鉴权、增加快照和执行权用例，不建立第二份任务真相源 |
| Agent Client Protocol | 复用通信协议 | 能力协商后 new/load/resume；后端 session ID 不是跨账号跨机器可移植数据包 |
| Paperclip Adapter | 借鉴或独立适配进程 | Codex Adapter MIT，但 Node >=24.11 且有共享包依赖；当前 Node22 不直接整包引入。先验证 Windows 和新会话注入 |
| Orchestrator Daemon | 可选执行后端 | B 本机通过 API 调用；由一个组件独占工作区创建/清理。当前 CLI 文档中的 switch-agent 是借鉴候选，采用前核实固定版本的摘要、generation 和幂等行为，不替代跨人授权 |
| OpenClaw | 借鉴会话发布与归属模型 | session-share 是只读且依赖源 Gateway，不作为 A 离线后可执行交接的底座 |
| LangGraph | 借鉴 Checkpoint/Store 分层 | 当前无需为外部编码 Agent 交接引入图运行时；checkpoint 不包含外部工作区和凭据 |
| 向量检索 / 消息总线 | 首版不采用 | 精确版本引用、数据库与现有 HTTP 足以验证场景，待规模与实际召回问题出现再评估 |

复用前锁定具体版本、许可证和 Adapter 能力，不能将 master 文档接口直接视为已稳定兼容。本次设计不新增任何运行依赖。

主要官方依据：[Git bundle](https://git-scm.com/docs/git-bundle)、[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[Paperclip Codex package](https://github.com/paperclipai/paperclip/blob/master/packages/adapters/codex-local/package.json)、[Orchestrator CLI/API](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/cli/README.md)、[OpenClaw session-share](https://docs.openclaw.ai/plugins/session-share)、[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)。

## 9. 验收证据的有效性

历史 Evidence 保留且不改作者。后续记录应增加 context_snapshot、repository、tested_commit/tree_hash、environment_summary、execution_source 和验收条目集合。client_reported 与独立采集的 CI/runner 结果分开标注，不能因为字段齐全就宣称证据真实。

验收条目按集合检查去重后的覆盖，而不是比较数组长度。B 在新的 Commit、需求版本或关键环境变化后必须重新执行相关验证；旧报告可作参考，不直接转成 B 的 pass。交接收讫和研发验收属于两个操作。

如任务要求不同人员验证，Verifier principal 必须与所有贡献 Builder principal 不同，包括 A 和 B；当前只按 Run Profile 隔离的实现不满足该要求。该策略作为项目可选严格验收规则明确配置。

## 10. 分阶段交付与实现接缝

### 阶段一：可移植交接闭环

目标：A 与 B 不同电脑、不同 Agent，A 发布后离线，B 可以继续开发并提交。

- contracts/schema/domain：ContextSnapshot、Handover、Run 状态和谱系、租约、幂等及状态守卫；迁移旧 Run 状态保持兼容。
- application：统一项目读取授权；原子 prepare/publish/activate/cancel/resume；升级全部旧执行写路径的 fencing 校验。
- core-api/agentd：Session/租约 HTTP 化，停止确认与恢复回执；不让 B 持有数据库凭据。
- integrations/agentctl：Git 快照、独立 Worktree、manifest 校验、恢复 journal、pack 扩展和新 CLI。
- web：任务详情交接动作、暂停/待接收/恢复失败/已交接视图、版本变化与旧证据提示；不先建设通用聊天产品。

### 阶段二：结构化会话与按需回溯

新增 conversation_sessions、conversation_events、context_notes。事件使用单会话递增 seq、稳定 event_id、actor、run、provider_ref、tool_call_id、payload_hash 和 visibility；重复事件幂等，工具调用和结果保持关联。

摘要记录 covers_until_seq、来源事件及生成版本，原始事件保留。先支持一种真实 Agent Adapter；不能把任意终端字节自动解释成用户消息或可靠工具结果。选定事件发布到项目上下文仍需显式操作。

引入 BlobStore 与 bundle/patch 路径，覆盖必要二进制报告。原生 resume 能力逐 Adapter 测试，失败时创建新会话并注入便携包，不默默丢失历史或继承他人身份。

### 阶段三：动态上下文与影响分析

已有版本引用基础上构建变化通知、相关性分类、失效证据索引和任务级差异摘要；再验证共享知识检索是否确实减少上下文成本。持续收集重复解释次数、成功接手率、恢复失败原因、返工和验收一次通过率，不把功能数量当价值指标。

## 11. 可执行验收标准

| 编号 | 场景与预期 |
|---|---|
| AC-01 | A 用一种 Agent、B 用另一种，A 发布后离线；B 仅凭 Core 与 Git 远端恢复，能核对相同代码快照并完成下一项工作 |
| AC-02 | 选中路径的最终 working-tree 内容、删除和未跟踪文件正确形成 snapshot tree；未选改动保持 HEAD 内容，目标不还原暂存划分；A 的 HEAD、index 和工作区字节不变 |
| AC-03 | 非成员和禁用用户不能读取；未发布草稿只允许源本人/Owner 读取；非目标人不能接收/恢复/激活；撤销设备不能执行设备绑定操作；读取均通过统一权限守卫 |
| AC-04 | A prepare 后旧 epoch 的 submit、verify、Session 业务上报和 legacy 写入口均拒绝；专用 grant 只能确认停止/有限诊断；B 激活前不能开始 Agent |
| AC-05 | 重复 activate、并发双设备接收、请求超时重试，仅产生一个有效目标 Run 和一个 active 执行者 |
| AC-06 | 恢复失败、源停止失败、取消和超时不会自动恢复 A 或自动激活 B；可从明确状态重试 |
| AC-07 | unresolved handover 期间合同编辑拒绝；上游需求/文档/决策变化在 ready/activate 与并发写入测试中阻断；替代包需重新接收/ready，不能复用旧回执 |
| AC-08 | 错误仓库、缺失 Commit、脏目标目录、LFS/submodule 未满足依赖都明确失败，既有文件不被覆盖 |
| AC-09 | 历史 Evidence 作者不变，新 Run 不自动继承通过结论；重复验收 ref 不能伪造完整覆盖 |
| AC-10 | 交接 manifest 中没有 A 的 Token、Agent Home 和绝对路径；B 使用自己的登录和本机路径 |
| AC-11 | 源 Workspace 在交接准备/恢复期间不能自动回收；交接完成且目标快照持久后才按引用检查允许清理 |
| AC-12 | 原生 session 无法恢复时仍能通过新会话接手；不把 session ID 有效性作为便携交接的必要条件 |

单元测试覆盖状态机、集合覆盖、哈希和路径规则；PostgreSQL 集成测试覆盖并发、事务回滚、租约、幂等及版本漂移；CLI 集成使用两个独立目录和凭据验证代码恢复。最终必须有两台真实电脑、两种真实 Agent 的端到端交接证据，注入假进程的测试不能替代该验收。

## 12. 设计选择与待验证项

选择保留现有 Project Core，将 Git 与 Adapter 作为执行/成果能力；不整体 Fork Paperclip 或 Orchestrator，不把共享聊天作为第二个项目事实源。只改 assignee 会丢失执行责任边界；复制原生 Agent Home 会引入凭据与兼容问题；只发送摘要会丢失代码和可追溯来源，因此均不作为主路径。

待验证项：Windows 临时 index 快照对文件名/换行/大小写的支持、远端 ref 保留策略、真实 Agent 的停止可靠性、恢复摘要预算、Node24 Adapter 独立进程是否值得采用、Owner 发布步骤在小团队中的摩擦。它们在试点中验证，不伪装成既定实现。
