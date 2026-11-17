# 本机模型的按需读取

2026-11-10 使用 Ollama 0.14.2 的 `hub-qwen2.5:latest`，模型 digest 为 `6fbcd39f7b8a6001115c2b853c24fa05643bb34a6404a748aabd15b80b2a68ee`。未领取任务。每题开独立对话，温度 0，seed 42。输入与记忆均为合成样本。

脚本通过一次模拟 `Stop` 捕获建立临时项目讨论和本人偏好，再启动原传输实验的 MCP stdio 进程。它完成 `initialize`、`notifications/initialized`、`tools/list`，将服务提供的工具名、说明和参数 schema 映射成 Ollama `tools`。模型自行决定每一轮是否发起工具调用，脚本逐项执行模型实际生成的 `tools/call`，把工具结果放回对话。下表分别统计模型的调用和 `tools/call` 的命中。[执行脚本](probe.mjs) · [存储与匹配规则](../transport/probe.mjs)

| 提问 | 原工具说明 | 说明加入字面子串查询方法 |
| --- | --- | --- |
| 项目退款超过七天的决定 | 自主查一次，0 命中。模型误推断先前没有讨论 | 自主查一次，0 命中。`退款七天` 与实际文本 `退款超过七天` 未连续匹配，回答仍误推断 |
| 本人提交说明语言 | 未查，模型推荐英文 | 自主查一次，0 命中。英文检索词 `commit message language` 未匹配中文记忆，回答仍未取得真实偏好 |
| 17 加 25 | 0 调用，答 42 | 0 调用，答 42 |

两轮同题中，相关问题调用从 1/2 变成 2/2，实际取得依据仍为 0/2。原始问题、模型查询、命中范围和最终回答均保存在观察记录中。[基线](observed-baseline.json) · [调整工具说明](observed-substring.json)

额外两道阳性对照明确指定关键词与工具。模型分别查询“退款”和“提交说明”，命中共享 `discussed` 和本人 `preference`，回答保留了尚在讨论、使用中文、当前无明确推送许可的含义。对照验证了命中后利用状态的两次具体表现。自主选工具的指标只取上表三个普通问题。[阳性对照](observed-control.json)

本实验覆盖真实模型、真实 stdio 调用和合成授权视图。检索由 `instr` 连续子串匹配提供。下一次替换检索后端时，应保留模型自然产生的查询，包括改写及英文查询，同时测相关对象、状态和来源能否一同返回。空结果的回答应保留“本次查询未命中”的含义。正式宿主的自带系统指令、上下文预算和候选工具数量均会影响模型的选择，需在真实宿主上复验。

在仓库根目录运行以下命令，要求 Node.js 22.21 和可访问的本机 Ollama 模型。每次运行重建合成资料，保存该变体的观察文件。

```powershell
node docs/experiments/memory-harness-pilot/agent-use/probe.mjs baseline
node docs/experiments/memory-harness-pilot/agent-use/probe.mjs substring
node docs/experiments/memory-harness-pilot/agent-use/probe.mjs control
```

## 真实成员记忆读取

`live` 变体复用同一模型循环，将 MCP stdio 服务换成官方 TypeScript SDK 1.29.0 实现的薄服务。模型仅能提供检索词。Bob 的成员 CLI 在调用时核验受管实例，然后以当前授权读取固定 `teamsynergy/image-preflight` 的 context。这里借用一个已存在的任务范围，执行过程没有领取任务。Hub 正常生成个人 context 快照和 CLI 审计。[服务端](live-server.mjs)

服务只选取本次查询匹配的 `projectKnowledge` 和 `accountExperience`，将范围、状态、来源和正文交给本机模型。默认装配的 `agreements`、任务包、私人日志、background 和失败时的 snapshot 均不作为命中。公开报告记录调用次数、模式、范围及事实核对。

| 实际提问 | 调用及命中 | 最终答案核对 |
| --- | --- | --- |
| 项目已确认的图片编码长度与解码契约 | 主动查 1 次。project `empty`，personal `engine` 命中 1 条 | 硬上限回答 unknown，计前缀字段与已知契约一致，完整解码字段未通过核对。送给模型的项目依据为 0，未通过项目契约回答验收 |
| 本人验证 Base64 和长度边界的经验 | 主动查 1 次。project `empty`，personal `engine` 命中 1 条 | 自由文本引用了实际返回的本人经验 ID，JSON 格式验收未通过 |
| 17 加 25 | 0 调用 | 42 |

第一次运行的答案核对器仅接受整段 JSON。第二次读取带外围文字的单个有效对象，保留两次记录。个人题同时检查最终文本有没有实际工具结果中的来源 ID。两次运行的工具选择与命中计数一致。最终回答及模型后续查询可能带私有内容，报告只保留固定选项的事实判定。[首次运行](observed-live-first.json) · [复核运行](observed-live.json)

该 fixture 的项目共识来源为 `agreement`。当前 Hub 的查询预筛选先排除了这类来源，故 context 的项目检索分支返回 `empty`。原生 Wiki 可以检索该来源，见[引擎探针](../engines/probe.mjs)。产品查询接口需要支持通过来源类型读取已生效的议题决定与规范，并用当前版本复核。项目问题只找到本人经验时，工具应显式报告项目依据缺失，允许 Agent 用正式资料继续核对。

在已启动既有受管 Live4321 和本机模型的 Windows 工作区复核，`TSP_PROBE_MCP_SDK` 指向已安装的官方 SDK 包目录。

```powershell
$env:TSP_PROBE_MCP_SDK = 'C:/Users/Liam/AppData/Roaming/npm/node_modules/oh-my-codex/node_modules/@modelcontextprotocol/sdk'
node docs/experiments/memory-harness-pilot/agent-use/probe.mjs live
```

## 同题复测与无任务入口

`live-decisions` 新增按需只读工具 `read_project_decisions`。成员主动调用时，工具从授权上下文中选取当前范围已生效的决定，返回 ID、版本、哈希、确认状态与原文。单条原文预算 1,536 字节，最多 4 条，响应带省略条数。`formal_read` 单独记录。前两种 Live 变体均借用已有任务范围，正式读取依赖授权任务的 context 接口。

`live-project` 使用相同工具列表、普通模型指令和三道原题，调用仅需项目身份的 fixture 后端。该变体禁止调用任务 context 入口。来源仍携带各自的适用范围和修订，即使查询未指定 taskId。正式读和搜索可各自返回同一项目来源。[项目级读取后端](../engines/project-reader.mjs)

| 变体 | 项目契约题 | 个人经验题 | 算术 |
| --- | --- | --- | --- |
| 固定任务，搜索工具 | 1 次搜索，只收到个人经验，缺少公共依据 | 1 次搜索，1 条个人命中，答案引用返回的来源 ID | 0 调用，42 |
| 固定任务，搜索与正式决定两种工具 | 模型选择正式读 1 条决定，再搜索 0 匹配。答到 6 MiB、`includePrefix=true`、`fullDecode=false`，精确字节数和所要求的 JSON 未交付 | 1 次搜索，2 条个人命中，答案引用实际经验 ID，JSON 未通过 | 0 调用，42 |
| 项目身份，无需任务，搜索与正式决定两种工具 | 模型选择正式读 1 条，另一次搜索由 Tencent 命中同一来源。两次都携带 `listed_tasks`。回答 6,291,456 字节与 `fullDecode=false`，`includePrefix=null` 漏答 | 1 次搜索，Tencent 项目知识和 OpenViking 本人经验各命中 1 条。最终缺少真实经验 ID，采用验收未通过 | 0 调用，42 |

`projectOnlyColdStartVerified=true` 表示本次项目级模型循环在没有 taskId 入参时通过真实 MCP 调用拿到了有版本的授权来源。项目级 fixture 限定既有 Bob 账号与图片契约数据。模型从同一决定获得两次投递，`publicSourcesDelivered` 计投递次数。上线验收应同时核对每项关键字段和实际引用，并覆盖更多宿主、账号、项目、版本与冲突案例。[固定任务 v2](observed-live-decisions.json) · [无任务实测](observed-live-project.json)

```powershell
node docs/experiments/memory-harness-pilot/agent-use/probe.mjs live-decisions
node docs/experiments/memory-harness-pilot/agent-use/probe.mjs live-project
```
