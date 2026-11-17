# CLI 命名与安装

平台名称统一为 **Team Synergy**，CLI 主命令为 `tsp`，项目文档库命令为 `tsp docs`。更名不改变 API、项目编码或已有文档版本。

## 从平台安装（成员）

打开平台右上角机器人入口 →「CLI 接入」，选择 Windows、macOS 或 Linux，复制当前平台提供的安装命令。脚本从该平台下载已发布的 `tsp`，包含运行时和 `agentd`，成员无需取得源码或安装 Node.js、pnpm。

安装到当前用户目录，脚本检查操作系统、CPU 架构和 SHA-256。再次执行同一安装命令即可更新，登录配置、工作空间和正在使用的旧版本目录保留。未发布对应架构时明确报错，不回退到不匹配的安装包。

打开新终端，通过浏览器授权：

```sh
tsp auth login --api https://platform.example.com/api
tsp auth whoami
```

核对终端与浏览器中的授权码、当前账号及客户端名称，然后确认授权。远程终端可添加 `--no-browser` 手工打开显示的地址；Web 与 API 分开部署时添加 `--web https://platform.example.com`。授权请求十分钟后过期，取消后可以重新发起。

同一安装重新登录会建立新会话，复用设备记录；`tsp auth logout` 退出当前会话。清理安装身份、使用其他浏览器配置或另一台设备会产生独立客户端。设备与会话可在 Agent 工作台查看和吊销，详见 [CLI 分发与设备会话](45-cli-distribution-device-sessions.md)。

## 从源码安装（开发者）

需要 Node.js 22+、pnpm 10.33+。在仓库根目录完成依赖安装和构建，再把 CLI 链接到当前用户的 npm 命令目录：

```sh
pnpm install --frozen-lockfile
pnpm -r build
cd apps/cli
npm link --offline --ignore-scripts
tsp --help
tsp docs --help
```

确认 `npm prefix -g` 对应的命令目录已在 PATH 中。Windows 通常使用该目录本身，Unix 使用其 `bin` 子目录。未安装全局入口时，也可在仓库根目录执行 `node apps/cli/dist/index.js docs --help`。

`tsp` 在 PowerShell、CMD 和常见 Unix Shell 中使用相同的命令形式。

## 文档查询

在已绑定的项目工作空间内：

```sh
tsp auth whoami
tsp docs list
tsp docs search "登录"
tsp docs show <document_code>
```

在未绑定目录中查询时显式添加 `--project <project_code>`。搜索当前返回匹配的文档索引，完整内容通过 `show` 读取。需求与架构资料的创建、修订仍使用 `tsp requirement-doc` 和 `tsp architecture`。

## 兼容范围

- 原 `agentctl`、`acp` 可执行入口继续保留，`handoff` 是 `docs` 的兼容别名；旧 `agentctl handoff ...` 和 `acp docs ...` 脚本继续可用。
- 所有入口使用相同登录信息和项目绑定；平台分发包提供 `tsp`、`agentd`，源码安装保留旧命令别名。
- `AGENTCTL_HOME`、默认 `~/.agentctl/auth.json`、`.agent/` 绑定和快照路径保持兼容。
- 内部包名 `@team-synergy/cli`、源码目录 `apps/cli`、HTTP `/handoff` 路径及 JSON 字段保留，避免改动已保存的数据和集成。
- `tsp task handover` 仍用于任务执行交接，与项目文档库 `tsp docs` 是不同业务。
- `tsp auth login --token <bind-token>` 和 `login-password` 保持兼容。常规成员接入默认使用浏览器授权；CLI 标准输出不再返回登录令牌。

页面、帮助、文档中的品牌与操作示例统一使用 Team Synergy / `tsp`。旧文档修订、审计记录和内部组件标识保留；协议名 Agent Client Protocol 及第三方 `opencode acp` 命令不属于本次更名范围。
