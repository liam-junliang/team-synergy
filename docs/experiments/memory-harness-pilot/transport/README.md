# 会话捕获与主动检索的进程实验

在 TeamSynergy 仓库根目录使用 Node 22.21.1 运行以下命令。

~~~powershell
node --test docs/experiments/memory-harness-pilot/transport/verify.test.mjs
~~~

`verify.test.mjs` 在系统临时目录创建合成成员、项目和 rollout。每次 CLI、hook 和 MCP 请求使用独立进程或长驻 stdio 进程。实验数据保存在同一临时 SQLite 库，验证结束后清理。服务端只依赖 Node 内置模块。

| 实际执行 | 观察 |
| --- | --- |
| stdio MCP 版本 2025-06-18 的双向握手、发现和调用 | `initialize` 和 `notifications/initialized` 后列出 `search_memory`。模型端只能传 `query`。相同身份使用 CLI `search` 和 MCP，返回相同来源、内容和 `discussed` 状态。传入其他账号或尝试调用发布工具会收到协议错误。 |
| 回放 Codex Stop 事件与 rollout JSONL | 首次捕获写入一条消息。重复 Stop 新增 0，末行未写完新增 0，补齐后新增 1。延迟回调读取当前完整文件仍新增 0。观察到已消费前缀缩短、截断为零、已处理行内容变化，均回滚并报告需要对账。 |
| 混合会话与身份范围 | 同一消息含退款设想、中文提交偏好和私密附件代号。Bob 查到项目设想。私人偏好仅对 Alice 在 shop 的检索可见，原始消息正文只能通过实验库的输入表访问。未绑定的项目、会话、工作目录、转录文件均被拒绝。 |
| 独立标准客户端协商、发现和检索 | 已用本机安装的官方 TypeScript MCP SDK 1.29.0 成功连接 stdio，Bob 的查询返回项目讨论和来源，私人查询为空。 |
| 真实 Codex app-server 发现和调用 | 在独立临时 Codex 配置目录启动已安装的 0.145.0 二进制，`mcpServerStatus/list` 返回 `search_memory`。通过 `thread/start` 创建 ephemeral 测试会话，再由宿主 `mcpServer/tool/call` 读到与 Bob CLI 一致的退款内容和来源。此用例由测试客户端指定工具、未发起模型轮次。 |

2026-11-10 最终结果为 5/5 通过。仅依赖 Node 时运行三组，已安装的 SDK 和 Codex 各启用一组外部互操作检查。可从仓库根目录复核完整结果。

~~~powershell
$env:TSP_PROBE_MCP_SDK = '填写已有 @modelcontextprotocol/sdk 包的绝对目录'
$env:TSP_PROBE_CODEX = '填写已有 Codex 原生可执行文件的绝对路径'
node --test docs/experiments/memory-harness-pilot/transport/verify.test.mjs
~~~

协议采用按行传输 JSON-RPC 消息的 stdio。仅在明确发出工具调用时执行搜索。调试 CLI 与 MCP 共用查询和过滤函数。[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) · [MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

### 首个宿主

本机 `codex --version` 返回 `codex-cli 0.145.0`。OpenViking 的 Codex 适配器提供了可核对的事件和转录格式，适合先在此宿主试点。原型使用其 Stop 输入中的 `session_id`、`transcript_path` 和 `cwd` 以及 rollout 中的用户／助手文本。正式适配还需处理上下文压缩和异常退出后的恢复。下一轮用隔离的真实宿主会话记录实际工具调用与 hook 回执。[上游 hook 清单](https://github.com/volcengine/OpenViking/blob/178a8cdfb41b51e7d24c4bf79a13cc54981e0ee8/examples/codex-memory-plugin/hooks/hooks.json) · [Stop 处理器](https://github.com/volcengine/OpenViking/blob/178a8cdfb41b51e7d24c4bf79a13cc54981e0ee8/examples/codex-memory-plugin/scripts/auto-capture.mjs)

在隔离 home 新增无副作用的 Stop 命令后，以真实宿主 `hooks/list` 核查，结果显示 `source=user`、`eventName=stop`、`isManaged=false`、`trustStatus=untrusted`。该宿主验证用例复跑 1/1 通过。OpenAI 官方文档要求用户用 `/hooks` 审阅并信任该定义的当前哈希，哈希变化后需重新审阅。具备此信任后才能验证实际模型轮次触发的 Stop 回执。宿主允许 `transcript_path` 为空，转录文件格式也可能变更，上线时应按版本探测并向调用者报告捕获能力。[OpenAI Docs 的 hook 信任规则及输入字段](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

### 证据范围与生产接入条件

- 两段固定中文文本模拟分类器的输出，SQL 子串匹配提供可重复检索。分类质量、授权判定、业务对象更新、腾讯与 OV 原生召回需分别验证。
- 进程身份和会话从测试启动器绑定。生产端应由 TSP 当前有效账号和项目权限授权并校验来源级访问，工作区名称、环境变量、路径或宿主上报的说话人都无法单独证明业务授权。
- 测试文件位于临时合成目录。真实设备需要定义原始会话本地保留、提炼字段、私密内容处理与撤回规则；线上读工具只返回读者有权访问的来源摘录和版本。
- 回放仅覆盖典型文本消息。相同文件前缀、相同或增加的行数可以继续；任何比已处理历史更短的可读完整前缀都会暂停。没有可信快照编号时，短文件既可能是旧读取，也可能是日志截断，需要对账。内容相同但底层文件被替换无法从当前行摘要识别。本原型逐次核对完整前缀并限制文件为 1 MiB。产品需要持久游标、文件身份、边界校验、轮转恢复与有界队列，且要覆盖宿主多种事件形状、断连、进程竞争以及敏感字段。
- 首次宿主试验暴露 Windows 子进程延迟释放临时目录。临时实例现显式关闭插件、远程插件和应用发现，Git 传输限定本地文件协议，使用回环上的空模型 provider，清理操作有界重试。真实宿主发现和工具调用已验证。模型自发选择与真实 Stop 投递仍需下一轮宿主会话验证。
