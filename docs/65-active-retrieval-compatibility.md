# 成员 Agent 主动检索的跨宿主验收

2026-11-10 使用本机 Magpie 的 `workbuddy/deepseek-v4.1-flash` 路由，对 DSH、OpenCode 和 Codex 重新运行了同一组自然问题。测试客户端请求了该路由，四份运行审计共记录了 77 个成功模型响应。对照同一时段的 Magpie 用量，共有 77 个不同响应 ID，送出与实际服务的模型均为 `deepseek-v4.1-flash`，77 条的 `swapped` 均为 `false`。DSH 使用 Messages，Codex 使用 Responses，OpenCode 使用 Chat Completions。Magpie 的用量日志显示，前两种入口由网关转为上游 Chat Completions。早期 Qwen 数据只作为协议调试历史。[Magpie 用量核对](experiments/memory-harness-pilot/deepseek-magpie-usage.json)

## 问题和判定

Alice 在隔离项目中提出“退款超过七天进入人工审核”，同一轮还表达了“这个项目我习惯用中文写 Git 提交说明”。数据准备使用预标注片段，经过 TeamSynergy 的真实领域事务写入 PostgreSQL。Bob 在采纳前后分别问规则和进度，Alice 问本人工作习惯。第四题问 17 加 25。每题使用独立宿主会话，用户问题不含工具名或答案。这样的播种单独测量资料读取，完全不需要模型替测试准备事实。

基线只提供原有 `search_memory`。优化组增加有范围的只读简报工具、MCP 资源和宿主使用说明。命中必须有工具或资源实际返回预期来源、范围与状态。引用必须在最终回答中原样出现该条来源编码。评阅还核对七天、人工审核、讨论或采纳状态、实施证据是否充足，以及私人题的适用范围。显式阳性校准在模型回答结束后单独执行。发现目录及在回答里写出工具调用示例都不计入命中。

| 宿主及版本 | 基线命中并引用 | 优化后命中并引用 | 优化后冻结规则评分 | 优化后逐条核对内容与引用 |
| --- | ---: | ---: | ---: | ---: |
| Codex 桌面内置 CLI 0.166.0-alpha.6 | 0/3 | 3/3 | 1/3 | 3/3 |
| DSH 0.2.1-rc.2，发行版 headless | 2/3 | 3/3 | 2/3 | 3/3 |
| OpenCode 1.14.21 | 0/3 | 3/3 | 3/3 | 3/3 |

Codex 单用搜索时主动搜索 18 次。加简报后，三题均取得可引用记录，回答明确区分提案、已经作出的决定和仍需核实的实施进度。自动规则漏判了“没有查到任何已确认的结论”中的否定和跨句描述的“没有实施证据”。DSH 优化后三道知识题各读取一次简报，自动规则漏认了一个正确陈述。表中单列自动评分与逐题审阅，保留了原答摘录。三个宿主的两组算术对照均答出 42，实际记忆读取均为零。[Codex 逐题结果](experiments/memory-harness-pilot/active-retrieval-deepseek-flash-result.json) · [DSH 逐题结果](experiments/memory-harness-pilot/active-retrieval-dsh-deepseek-flash-result.json) · [OpenCode 逐题结果](experiments/memory-harness-pilot/active-retrieval-opencode-deepseek-flash-result.json)

OpenCode 另用一个新项目、独立问题和不同规则复测。三种指导下都找到并引用“超过 800 元需主管复核”，回答现有决定不能证明上线。也观察到多余读取，私人风格题已经命中后又取了与问题无关的退款记录，留出题的部分会话还查了空的私人范围。本轮未见 Bob 读到 Alice 的私人来源。题目和业务记录均为合成数据，三题全对是本轮观察值。[留出题和原答](experiments/memory-harness-pilot/active-retrieval-opencode-deepseek-flash-holdout.json)

## 接入与复验

复用成员设备登录与绑定工作区。支持 MCP 资源的宿主可读取 `tsp-memory://project/brief` 或 `tsp-memory://personal/preferences`。支持普通工具调用的宿主可以用 `read_memory_brief({scope})`，CLI 等价命令为 `tsp memory brief --scope project` 或 `--scope personal`。`search_memory` 继续用于查找具体问题和历史材料。简报读取时实时检查项目权限和账号归属，返回最多六条完整摘录。当前需求修订、讨论状态和来源撤回情况共同决定哪些公共条目可进简报。重开议题的原决定仍可按历史检索，结果带议题当前状态。

将以下命令输出的文字交给宿主的项目助手指令即可。说明中只包含取证方法，不包含项目资料或用户偏好。示例假定 MCP 注册名为 `tsp_memory`。使用其他别名时要对应宿主真正暴露的工具名称。

| 宿主 | 获取说明 | 成员接入示例 |
| --- | --- | --- |
| Codex | `tsp memory guidance` | [Codex 配置](64-native-memory-slice.md) |
| DSH | `tsp memory guidance --harness dsh` | [DSH profile、MCP 和 headless](experiments/memory-harness-pilot/agent-use/dsh-retrieval.md) |
| OpenCode | `tsp memory guidance --harness opencode` | [OpenCode 1.14 配置和工具名](experiments/memory-harness-pilot/agent-use/opencode-retrieval.md) |

[OpenAI Docs 的 MCP 说明](https://developers.openai.com/codex/mcp) · [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness) · [OpenCode 官方 MCP 文档](https://opencode.ai/docs/mcp-servers/) · [DeepSeek 官方模型发布记录](https://api-docs.deepseek.com/updates/)

复验要求本地 PG 测试账号有 `CREATEDB`，本机已安装相应宿主，Magpie 正提供上述路由。每次运行生成临时账号、项目、数据库、宿主工作目录和模型网关令牌。下面的命令会实际调用模型。矩阵与留出测试各自保存脱敏结果与模型响应核验。

~~~powershell
$env:TSP_TEST_DATABASE_URL = '<有 CREATEDB 权限的本机测试集群>'
$env:TSP_PROBE_CODEX = '<桌面内置 codex.exe 绝对路径>'
$env:TSP_PROBE_DSH_PROFILE = 'headless'
node apps/core-api/tests/magpie-memory-eval.mjs dsh
node apps/core-api/tests/magpie-memory-eval.mjs opencode
node apps/core-api/tests/magpie-memory-eval.mjs codex
node apps/core-api/tests/magpie-memory-eval.mjs opencode holdout
~~~

## 下一轮目标

真实缺陷交接已在下一轮完成，覆盖 B-05、A-02、B-02 与边界场景，并分别核对模型是否真正使用了两个检索引擎的来源。[真实缺陷与多场景验收](66-defect-handoff.md)

1. **让真实开发任务检验双引擎召回。** 选择一个已有上游需求、下游测试和历史决定的 TeamSynergy 缺陷。让另一成员的新会话回答“为什么这样改、改动影响谁、怎样验收”，同时启用 Tencent Wiki 与 OpenViking。逐项记录关键词搜索、语义检索、简报和最终引用分别贡献了哪些证据。本轮是平台字面搜索与简报的对照，尚不能据此评价向量索引或整库召回。
2. **让动作和状态有独立证据。** 提供可追溯的实施、测试与发布来源，同时安排“只讨论过”“已经采纳但无交付记录”“决定已重开”和“明确已有部署”作为对照。个人问题优先限在本人范围，命中后停止无关读取。复核事实、状态、引用和多余读取四项。
3. **补齐跨宿主写入与撤回。** 用 DSH 和 OpenCode 分别验证真实用户消息、来源定位、断线补录及重放，避免将助手转述计作人类决定。验收标准是撤回或更正后，旧来源立即退出其他成员的可见结果，两个引擎的副本清理可追踪。完成后再选择一种普通项目 Markdown 检验历史正文迁移与可恢复导出。

本次临时业务库与成员工作区均已清理。自动审批拦截了删除两个协议调试目录的操作，返回原因是 `blocked by policy`。遗留目录 `F:/workspace/team-synergy/tmp/memory-harness-schema` 与 `C:/Users/Liam/AppData/Local/Temp/tsp-memory-schema-c0812efec8fb43c98d79d213681b7a58` 只含 Codex 导出的公开 JSON schema。
