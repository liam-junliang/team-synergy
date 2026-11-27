# 日常宿主记忆采集接入

本地持久接入把明确注册工作区中的新操作者输入送入当前账号的持久队列。安装成功、MCP 检索可用、本地入队、服务端收到、模型整理和引擎投影是不同状态。服务器尚未收到事件时，不能据此断言设备已经安装或没有安装 Hook。

## 安装与诊断

需要在同一步配置本机 MCP 和已验证宿主的会话采集时，先绑定当前工作区，再执行 `tsp agent connect --harness codex --project <项目编码> --capture`。DSH 和 OpenCode 使用各自的 `--harness` 值。省略 `--capture` 时只配置本机 MCP，仍可按需读取记忆。Claude Code 的本机入口提供 MCP 配置，原生采集需要宿主验证。

在已经 `tsp login` 且 `tsp project bind` 的工作区根目录运行，工作区绑定不要求议题或需求绑定：

```sh
tsp memory native install --harness codex
tsp memory native doctor --harness codex
tsp memory native uninstall --harness codex
```

DSH、OpenCode 分别使用 `--harness dsh`、`--harness opencode`。安装时可通过 `--runtime` 明确指定已安装宿主的绝对入口，通过 `--host-home` 或 `--config` 指定明确配置位置。Windows Desktop 应使用实际运行的 bundled `codex.exe`，不要用 PATH 上另一版本的 CLI 冒充 Desktop。每个账号、项目和工作区须单独注册；不会选择未绑定项目。退出登录、账号/项目绑定变化、未注册目录、不可确认来源或未知版本均不上传正文。

接入页和 CLI 在安装前核对服务接收开关及当前账号的项目写权限。服务未开启、当前账号仅为观看者或无法验证预检时，安装会停止。HTTP Connector 的查询授权与工作区采集分别配置。

| 宿主 | 默认配置 | 已验证格式 |
| --- | --- | --- |
| Codex | `$CODEX_HOME/hooks.json`，默认 `~/.codex/hooks.json` | `0.145.0` exec；`0.169.0-alpha.11.1`、`0.171.0-alpha.13` exec 与 app-server `vscode` 轮次格式 |
| DSH | `$DSH_HOME/cordis.patch.yml`，默认 `~/.dsh/cordis.patch.yml` | `0.2.1-rc.2`、`0.2.2-rc.5` 的原生 Cordis 全局 patch 数组、session/event 与 session/flush |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json`，默认 `~/.config/opencode/opencode.json` | `1.14.21` 原生 SDK plugin/chat.message/chat.params/session 事件 |

版本表是精确门控，不包含其他 alpha 版本。Codex Windows 已验证运行路径使用 PowerShell Hook 命令；自定义 Hook shell 需要独立验证。OpenCode 已有 JSONC 配置时不自动重写，需要用户明确兼容的 JSON 配置路径。DSH YAML 通过宿主自带解析器读取，不新增依赖。

安装仅合并自有 Hook 或插件条目，原文件先备份到当前成员私有目录 `memory-harness/<registration-id>/`，其中同时保存无凭据的接入记录与元数据诊断。已有 OMX、MCP 和其他插件保留。卸载仅删除完全匹配的自有条目；若用户已修改它们则拒绝自动删除。卸载保留队列、诊断和备份，重启宿主后生效。旧 `memory native setup/config --host-session ...` 保持兼容，仍是显式单会话方式。

### Codex 信任

安装后重新开启会话，在 Codex `/hooks` 中审阅并信任当前定义。安装器不会写 Hook 信任数据库、修改 `config.toml` 或关闭安全守卫。修改定义后应再次审阅。doctor 无法从自身检查确认宿主信任，返回 `unknown_review_in_codex_hooks`；这是未知状态，不是已信任。

`doctor` 返回检查时间、实际运行版本、当前账号/项目/工作区、配置位置和最近本地事件。`awaiting_new_session` 表示等待本地确认，`local_capture_observed` 表示观察到本地持久事件。`remoteDelivery: local_delivery_failed` 表示最近投递失败，可用 `deliveryErrorCode` 定位。已收到服务回执时，`latestCapture.captureCode` 可与记忆中心「采集与处理」的事件编号核对。`statusSource: server` 表示本次查到服务端最新状态，`delivery_receipt` 表示只保留了投递时的状态。

执行 `uninstall` 并重开宿主后，当前工作区的新会话停止采集。已入队的记录仍按原流程处理，已整理的个人记忆可在记忆中心撤回。

## 来源、时序与恢复

Codex 使用官方 SessionStart/UserPromptSubmit/Stop Hook。UserPromptSubmit 只暂存摘要和轮次，不持久化候选正文；Stop 才将摘要匹配且来源确认的新输入写入 SQLite FULL 同步队列，再唤起异步投递。Stop 始终输出合法 JSON。Hook 不等待平台网络、模型或引擎。

transcript 是已验证版本的保守回退，不是官方稳定接口。仅接受宿主 sessions 目录内、会话 ID 与工作区匹配的文件，拒绝符号链接和子代理元数据。首次 SessionStart 固定当前位置，不导入历史全文；只读取有界尾部中的匹配轮次元数据以覆盖 task_started 先于 SessionStart 的真实顺序。正文读取有 2 MiB 增量边界，单条最多 4000 字符，无法核实时明确不采集。

0.145 使用原生 event_msg.user_message。已验证的 0.169 和 0.171 alpha 版本使用原生 item_completed.UserMessage，并核实根轮次、无父轮次及无代理发起路径。单纯 role:user、助手消息、检索镜像、系统提示和 HookPrompt 都不构成操作者输入。真实 Stop:block 探针中自动续轮保持同一个 turn_id、不另发 UserPromptSubmit、续轮文本属于 HookPrompt；stop_hook_active 与已有事件状态同时防止收下续轮。结构化 subagent 来源一律拒绝，不依据文案关键词判断操作者。

DSH 从真实 session 头和已提交 `source.kind=user` 原生事件推导动态会话，flush 只等待本地 ACK。恢复的旧 seed 不重发。OpenCode 从原生 chat.message 获取会话和消息 ID，先本地暂存，再通过 SDK 核对已保存的完整纯文本和根会话归属后确认；synthetic/ignored、子会话与不一致内容不上传。跨新会话无需手工创建 profile 或拼 host-session。

事件 ID 由宿主、原生会话与原生消息/轮次确定；重放保持同一正文与 ID。中断后本地 ready/sending 租约可由既有 `memory native pump/status/drain` 恢复；恢复命令必须使用对应接入记录推导的会话及 owner，不跨账号复制队列。错误留在私有元数据诊断和队列中，不把失败当 ACK，不自动导入旧聊天补数。

## 隔离验证与现场边界

默认回归不访问模型、业务数据库或用户历史：

```sh
pnpm --filter @team-synergy/cli build
node --test --test-concurrency=1 apps/cli/tests/memory-harness-install.test.mjs apps/cli/tests/memory-native-capture.test.mjs apps/cli/tests/memory-dsh-capture.test.mjs apps/cli/tests/memory-opencode-capture.test.mjs apps/cli/tests/memory-dsh-lifecycle.test.mjs apps/cli/tests/memory-opencode-lifecycle.test.mjs
```

`apps/cli/tests/memory-harness-live.mjs` 是显式 opt-in 宿主探针。设置 `TSP_LIVE_HARNESS=codex|dsh|opencode` 和相应 `TSP_CODEX_RUNTIME` / `TSP_DSH_RUNTIME` / `TSP_OPENCODE_RUNTIME` 后运行 `node --test --test-concurrency=1 apps/cli/tests/memory-harness-live.mjs`。可用 `TSP_HARNESS_LOG` / `TSP_HARNESS_REPORT` 指定本轮私有日志和元数据报告。探针仅创建临时宿主目录、临时 SQLite、合成账号和 loopback HTTP stub；只有固定的 `http://127.0.0.1:3425/v1`、`officeace/deepseek-v4.1-flash` 模型调用真实发生，不向业务账号写合成偏好。

Codex 探针仅在只含本次自有已审核 Hook 的临时 CODEX_HOME 使用官方单次 `--dangerously-bypass-hook-trust`，保留 read-only sandbox 和 on-request 审批。Desktop 随附的两个已验证 alpha 版本通过 exec 采集探针，app-server 对照验证了 `vscode` 来源及原生轮次格式。隔离 app-server 的 `hooks/list` 会显示待信任的 Hook。Desktop 现场验收由用户通过 `/hooks` 信任后开启新会话，并在平台核对这次采集的回执。

官方依据：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[插件生命周期 Hook](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)、[App Server](https://developers.openai.com/codex/app-server)。这些文档定义 Hook/RPC 接口；transcript 版本格式和宿主时序仍以隔离实测与回归门控为准。
