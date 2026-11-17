# MCP 的账号连接与项目上下文

## 接入原则

MCP 服务的生命周期与项目工作区分开。`tsp mcp` 在没有登录、没有 `.agent/bound-project.yaml` 的目录也能完成初始化和工具发现。未登录时，连接检查返回登录指引；需要账号或项目的操作在调用时检查条件，不能因为 DSH/Electron 的启动目录不是项目目录而让整个 MCP 进程退出。

项目资料、项目记忆和代码查询使用同一套账号权限。服务不会自动选择第一个可访问项目，也不会在宿主安装目录创建项目绑定。

## 选择项目

项目工具的选择优先级为：

1. 本次工具输入的 `projectCode`。
2. MCP 启动参数 `--project`。
3. 启动工作区已有的本机项目绑定。

前两种方式不依赖本地项目文件。`projectCode` 只作用于该次调用，不修改连接的全局选择，适合同一 Agent 按问题查询多个项目。权限仍由服务器校验；知道项目编码不等于有权读取。

| 用途 | MCP 工具或参数 | CLI 对应入口 |
| --- | --- | --- |
| 检查账号、默认项目和下一步 | `get_connection_context`，输入 `{}` | `tsp tools call get_connection_context` |
| 发现本人可访问项目 | `list_projects`，可选 `query`、`limit` | `tsp tools call list_projects` |
| 查询指定项目代码目录 | `read_code_catalog`，输入 `{"projectCode":"项目编码"}` | `tsp tools call read_code_catalog --project 项目编码` |
| 设置连接的默认项目 | 启动时传 `--project 项目编码` | `tsp mcp --project 项目编码` |
| 保存工作区默认项目 | 不由 MCP 自动写入 | 在目标目录执行 `tsp project bind 项目编码` |

上表中的“项目编码”须替换为 `list_projects` 返回的真实编码。CLI 的 `--project` 与工具 JSON 的 `projectCode` 使用同一处理器，不要在两处传入不同编码。

没有默认项目时，可以先启动服务，再让 Agent 调用 `get_connection_context` 和 `list_projects`。只有具体的项目读取会提示选择项目；Agent 应根据用户明确提到的项目传入 `projectCode`，信息不明确时向用户核对。

常用项目可以在启动时设置默认值：

```text
tsp mcp --project 项目编码
```

兼容入口 `tsp memory mcp` 使用相同的项目选择方式。本机工作区绑定仍可供常规 CLI 和会话采集使用，但不再是 MCP 启动前置条件。

## DSH 配置

DSH 使用原生 Cordis profile patch，不使用 `mcpServers` JSON。当前本机发行版可以通过 `~/.dsh/cordis.patch.yml` 应用共享配置，或通过 `dsh --profile headless --patch <文件>` 只对某次启动应用。不要覆盖已有 patch；在现有列表中加入一个 `insert` 项，避免同名服务重复注册。

以下是模板，必须把两个 `C:/replace-with-actual/...` 路径替换为本机真实可执行文件和已安装 CLI 入口。它不是可直接执行的安装命令。

```yaml
- insert:
    - id: teamsynergy-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: team_synergy
        transport: stdio
        command: 'C:/replace-with-actual/node.exe'
        args: ['C:/replace-with-actual/tsp/dist/index.js', 'mcp']
        failOnStartupError: true
        toolCallTimeoutMs: 60000
```

`cwd` 可省略。没有工作区绑定时，通过工具发现项目并逐次传 `projectCode`；要固定默认项目，可在 `args` 的末尾追加 `'--project', '真实项目编码'`。

Windows 的某些宿主和 MCP SDK 会对 `cmd` 的命令字符串再次转义。DSH 遇到 “The syntax of the command is incorrect” 时，优先使用上述可执行文件与参数分离的方式。Node 可以来自 CLI 安装包自带运行时；不需要为接入复制登录令牌或模型密钥。

启动已有的命令行 profile：

```text
dsh --profile web
dsh --profile headless --json "通过 TeamSynergy MCP 发现当前账号可访问的项目，然后读取我指定项目的资料"
```

这里的 `web`、`headless` 是当前 CLI 支持的 profile。`desktop` 由 Electron 应用管理，不应使用 `dsh --profile desktop` 启动。修改共享配置后重启正在运行的宿主连接；DSH 的 MCP 启动警告表示该插件没有连接成功，不能只凭 DSH 进程退出码或助手的口头回复判断接入正常。

## 隔离与恢复

连接首次执行认证操作后固定当前账号身份。账号、凭据或 API 地址发生变化时，应重新连接；旧账号的结果不能继续沿用。依赖工作区默认绑定的连接也会检测绑定变化。逐次传入 `projectCode` 则不需要为普通的跨项目读取重启。

读取回执、工作记忆与来源仍按账号和项目隔离。项目 A 的回执不能用来读取项目 B；个人偏好不应被转换成项目共识，也不授予提交、推送、合并或代码分析的执行权限。

MCP 提供按需工具调用。自动会话采集、记忆提炼、写回和撤回同步属于另外的宿主采集流程，不能因为 MCP 已连接就声称聊天已经保存。服务中的默认工具权限与可选管理能力仍由现有权限检查约束。

## 验证要求

接入完成需要实际的 `tool_call` 和成功的 `tool_result`：先发现项目，再读取资料修订与代码目录，并检查返回的项目编码及来源。初始化成功和工具可见是必要条件，不能代替一次真实读取。错误启动、认证失败和无权项目都应保留诊断，不自动退到其他项目或其他 API。

本轮回归应覆盖无绑定启动、项目发现、显式项目读取、账号变化、默认绑定变化与跨项目回执。真实 DSH 联调的执行记录单独保存在 runtime 验证目录，不写入业务文档库。

## 2026-11-17 验证结果

CLI 的 52 项定向回归通过，其中新增 11 项连接与隔离用例；接入页 14 项测试及类型检查通过。测试使用临时目录和本地 HTTP stub，不连接业务数据库。独立代码审查未发现阻断问题。

真实 DSH 0.2.1-rc.2 沿用本机 Magpie 的 `workbuddy/deepseek-v4.1-flash` 配置，从一个无任何父级项目绑定的目录启动。实际 7 次 MCP 调用依次为账号检查、项目发现、资料目录、正文检索、资料读取、项目记忆简报和代码目录，耗时 21.975 秒，全部工具结果成功，最终 turn 正常完成。项目读取均明确携带 TeamSynergy 的 `projectCode`，没有在该目录创建绑定，也未调用写入或分析工具。助手文字中的调用次数不作为依据，以 NDJSON 的实际事件为准。

本机 DSH 共享配置使用真实 Node 与已安装 CLI 入口的绝对路径，不配置 `cwd` 或固定项目；已验证 web/headless 配置合成，真实执行使用原生 headless。当前正在运行的宿主须重启 MCP 连接以载入新版。Windows x64 下载包也已更新；其独立安装版从空目录、空登录目录初始化并列出工具成功。其他操作系统未在本轮原生执行。

证据位于本机 `team-synergy-runtime/dsh-mcp-connection-20261117/connection-proof.json`、`check-unbound.ndjson` 和 `distribution/final/completion-proof.json`。MCP 只读能力已验证，不代表自动会话采集或双引擎写回已经启用。
