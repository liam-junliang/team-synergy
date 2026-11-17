# TeamSynergy 原生项目记忆试点

主动检索的正式跨宿主验收使用了经本地 Magpie 核验的 DeepSeek V4.1 Flash，覆盖 DSH、OpenCode 和 Codex。本页后文的本地 Qwen 结果仅保留为早期协议调试记录。[三宿主实测与后续目标](65-active-retrieval-compatibility.md)

本轮在现有平台内接通了一个场景。Alice 和 Agent 讨论一条退款规则，Bob 在同一个项目读到设想并评论，负责人采纳后产生一条正式决定和一份新需求修订。只登录和绑定工作区就能检索。采集需要另外选定会话及其议题、需求。

## 谁负责什么

| 操作 | 权威数据与实际行为 |
| --- | --- |
| 读项目背景 | MCP 或 CLI 请求当前绑定项目。显式选择 `project` 时，服务先校验成员权限，再查 Tencent Wiki，最后用命中来源和当前 PG 记录复查可见性。当前索引覆盖经本入口积累的议题方案和决定。 |
| 读自己的经验 | `personal` 只向本人映射的 OpenViking 用户空间查询。通用声明可以随账号在成员有权访问的另一项目检索。含项目限定的偏好留在来源项目。工作流里的推送、部署等动作仍取决于当前操作者的授权。 |
| 讨论与采纳 | 普通成员能增加讨论。采纳复用平台的项目管理权限，比较议题头和需求修订，并校验所指的唯一有效方案。议题决定、验收条件的新修订、来源回执及投影作业在同一 PG 事务内提交。任务、测试、发布继续独立提供实施证据。 |
| 原文与索引 | Tencent 承接中文 Markdown 原文和可检索页面，OpenViking 承接个人片段。投递可重试，写前核对同名来源、写后回读。对 Wiki 还要完成 ingest 并验证原生检索命中。远端返回的位置用于定位 PG 有权返回的证据，生成摘要不会直接成为业务结论。 |
| 引擎不可用 | 已提交业务变更仍可在平台读取。检索降级为 PG 字面匹配。投递结果不确定时重查同一资源，带租约和尝试序号确认回执。`memory_projection_jobs` 可查看 `status, attempts, lease_until, last_error`。 |

每次检索可显式选一个范围。省略范围时只查平台当前可见的两个范围，用于无需向外部索引发送问题的场景。CLI 与 MCP 共用 `POST /projects/:projectCode/memory/search`，查询文本留在请求体。API 会用 `X-TSP-Memory-Retrieval` 区分 `platform`、`engine-and-platform` 和 `platform-fallback`。失效的讨论和已撤销的权限由平台过滤。调用引擎的服务端凭据不会交给成员 Agent。

公共结果包含原议题发言编码、议题、需求和当时的需求修订。成员可以沿这些编码回到原生记录。个人结果只返回本人条目及其适用范围，跨项目读取时也不会附带原项目的议题或需求编码。

## 用本地开发实例试用

1. 使用独立开发数据库，安装仓库现有依赖，运行 `pnpm build`。持久层新增迁移 `0053` 和 `0054`。启动 core-api 前为该进程设置以下变量。试点路由默认关闭。

~~~powershell
$env:TSP_MEMORY_ENABLED = '1'
$env:TSP_DATABASE_URL = '<隔离开发库连接串>'
$env:TSP_MEMORY_MODEL = 'hub-qwen2.5:latest'
$env:TSP_MEMORY_ENGINES_FILE = 'C:/private/tsp-memory-engines.json'
pnpm --filter @team-synergy/core-api start
~~~

分类使用本机 `127.0.0.1:11434` 的 Ollama。引擎配置是服务端私有 JSON，以下为字段示意。`projects` 和 `accounts` 的键使用 TeamSynergy 对外编码。为每个项目新建名称精确等于 `tsp-memory-<项目编码>` 的专属 Wiki，每位成员配置其自己的 OpenViking 身份和 API key。试点要求运维人员建立并核对这些映射。开发时可以省略 `TSP_MEMORY_ENGINES_FILE`，此时会记录待投递作业并提供平台检索。

~~~json
{
  "tencent": {
    "baseUrl": "<MemoryKnowledge 的 v3 基础地址>",
    "token": "<服务端 bearer>",
    "serviceId": "<腾讯服务标识>"
  },
  "openviking": { "baseUrl": "<OpenViking 基础地址>" },
  "projects": {
    "<项目编码>": { "teamId": "<腾讯团队>", "userId": "<Wiki 写入身份>", "wikiId": "<专属 Wiki>" }
  },
  "accounts": {
    "<账号编码>": { "userId": "<本人 OpenViking 用户>", "apiKey": "<本人的用户密钥>" }
  }
}
~~~

2. 在自己的工作区以设备身份登录这台 TeamSynergy 实例，用 `tsp project bind <项目编码>` 绑定目录。已有设备登录可直接使用。把编译后的 CLI 注册为宿主的 stdio MCP 服务。以下是 Codex 的 `config.toml` 示例，路径按实际安装替换。

~~~toml
[mcp_servers.tsp_memory]
command = "C:/path/to/node.exe"
args = ["F:/workspace/team-synergy/apps/cli/dist/index.js", "memory", "mcp"]
~~~

MCP 从工作区及本机登录解析项目与账号。宿主需要以项目目录作为工作目录。如果登录存储在独立 `AGENTCTL_HOME`，给 MCP 子进程传入相同的环境。命令行可用下面两条查询分别验证项目和个人结果。

~~~powershell
tsp memory search '超过七天的退款怎样处理' --scope project
tsp memory search '提交说明习惯用什么语言' --scope personal
~~~

3. 打开新的 Codex 会话，在提出业务问题前绑定其实际 rollout。命令需在同一项目工作区执行，并使用宿主的 `CODEX_HOME`。绑定记录当前议题头、需求修订、真实路径和文件游标，从绑定位置之后采集。

~~~powershell
tsp memory bind --session <宿主会话ID> --topic <议题编码> --requirement <需求编码> --transcript <实际rollout绝对路径>
~~~

4. 对 Agent 说“我建议退款超过七天进入人工审核。这个项目我习惯用中文写 Git 提交说明。”用 `tsp memory sync --session <宿主会话ID>` 同步。成员 B 随后可查看讨论、在原议题页评论。临时执行请求不进入长期记忆。分类器遇到混合私密内容或含糊授权时会要求澄清。

5. 采纳前应看清最新议题和需求。如果 B 的评论改变了议题头，原来的上下文会返回版本冲突。请在查看评论后重新绑定，再发新消息“确认采纳：退款超过七天进入人工审核。”。已绑定同一会话可显式 `unbind` 后重新 `bind`，新的起点是当前 EOF。已存在的来源事件保留原版本，无法通过重绑覆盖旧回执。裸答“就按这个方案做”需要当前会话有可核对的先行方案，缺少对应来源时由操作者补充。

6. Codex 可以在 Stop 调用同一个采集入口。以下是 `hooks.json` 片段，请在成员宿主的 `/hooks` 中审阅这条具体命令并信任。使用绝对可执行文件和 CLI 路径。若宿主未提供转录或未启用该 hook，可以继续用 `sync`。没有等价转录格式的宿主可显式绑定会话，使用 `memory capture --session <id> --event <稳定ID>`，从 stdin 提交本次用户消息。

~~~json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "\"C:/path/to/node.exe\" \"F:/workspace/team-synergy/apps/cli/dist/index.js\" memory hook",
        "timeout": 60
      }]
    }]
  }
}
~~~

## 复验和适用范围

两位成员在隔离项目完成了讨论、评论、采纳和跨账号复查。中文 Wiki 命中两条，分别可追溯到原讨论和正式决定。OpenViking 按语义找到本人偏好，另一成员直接读取返回 403。模拟远端写成功、平台尚未确认时进程中断，恢复后 Wiki 版本未增长。两个成员的设备登录、数据库修订、宿主显式调用、模型主动调用以及 Stop 事件投递分别计量。[实测计数](experiments/memory-harness-pilot/native-result.json)

中文原文成功写入后，Wiki 在 `ready` 前对搜索返回空集合。后台作业现在逐项核对 ingest、回读和索引。验证页使用独立于原文件名的哈希路径。再次实测时，在原命名位置预置已有摘要，原摘要保留，两条受控来源都能按中文检索。

Codex CLI 0.145 和桌面内置 0.166 alpha 都用真实会话转录通过显式同步，两版各成功显式调用 MCP 三次。本机 Qwen 在这两种宿主内自主调用搜索均为零。桌面版发起了两次资源发现。在 Ollama 原生工具协议的对照中，同一个本地模型根据 MCP 提供的工具定义主动进行了检索，返回答案同时包含人工审核条件和“仍在讨论”的状态。自动 Stop 的记录来自事件回放，真实宿主触发计数为零。后续应以自然问题下的自主检索与来源采用率衡量宿主接入效果。

~~~powershell
# 仅在拥有 CREATEDB 权限的本机隔离测试集群运行
$env:TSP_TEST_DATABASE_URL = '<loopback PostgreSQL 测试连接串>'
$env:TSP_PROBE_CODEX = '<codex.exe 绝对路径>'
$env:TSP_VERIFY_MEMORY_ENGINES = '1'
node apps/core-api/tests/native-memory-live.mjs
~~~

探针创建随机数据库、临时成员、临时工作区和全新的项目 Wiki。真实引擎分支需要已配置的本机联调环境，可用 `TSP_PILOT_HUB`、`TSP_PILOT_RUNTIME` 指定既有测试运行目录。结束时核对身份后清理本次数据库、Wiki 和个人测试片段。省略 `TSP_PROBE_CODEX` 时使用构造的 Stop 事件，省略 `TSP_VERIFY_MEMORY_ENGINES` 时只验证平台链路。

这一版保留现有文档正文和业务表。新的投影只摄取经会话入口形成的证据，原文档回填、其他页面产生的所有变更、个人历史撤回和远端副本清理还要单独实现。当前分类的中文句式和验收用例有限，不适合直接对所有项目开放自动共享。领域撤回过滤与物理清除是两个不同的验收条件。

[架构与对照实验](63-agent-memory-harness.md) · [端到端探针](../apps/core-api/tests/native-memory-live.mjs) · [引擎验证](../apps/core-api/tests/native-memory-engines.mjs)

## 连续聊天与记忆生命周期

后续切片为 MCP 读取增加了显式 `context_receipt` 和 `read_memory_source`。每次继续读取会通过已登录设备的 `POST /projects/:projectCode/memory/sources` 重验旧来源；正文未变只返回引用，变更返回当前正文，撤回或无权访问仅报告失效。新聊天、上下文压缩后或回执过期时可以重新取全文。该接口不接受调用方指定其他账号，最多回读 40 个来源。

真实多轮验证发现，已决定议题的后续记录在语义索引更新前会被旧简报规则隐藏。简报现在保留最后有效决定之后、当前需求修订内的新增讨论，状态仍为 `discussed`，同时保留决定的 `confirmed` 状态；旧方案、撤回、归档及旧修订的过滤继续有效。这让新增的执行观察能及时被读取，不会把它自动提升为已经实施的正式事实。

短期回执、一次性动作许可、长期知识和宿主聊天的完整边界见 [生命周期设计](67-memory-lifetimes.md)，实际多轮模型效果见 [对照验证](68-memory-lifecycle-validation.md)。一次性许可目前只供受控适配器与模拟动作使用，没有接管成员 Agent 的任意 shell。

2026-11-11 已增加按宿主聊天隔离的来源引用检查点、上下文代次和 DSH 原生事件适配器，并实测真正压缩、退出进程后恢复同一会话，以及项目切换后由原模型重新连接。接入方式、完整开销和宿主范围见 [恢复设计与验证](69-memory-context-recovery.md)。资源读取仍为独立的全量快照，未进入检查点恢复路径。
