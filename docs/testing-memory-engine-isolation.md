# 记忆引擎真实联调隔离

测试 PostgreSQL 的物理隔离之外，记忆引擎也使用独立服务、目录和管理员凭据。不要把业务 `TSP_MEMORY_ENGINES_FILE` 交给测试。

| 服务 | 独立地址 | 持久目录 |
| --- | --- | --- |
| TencentDB MemoryCore | `127.0.0.1:18520` | `F:/workspace/team-synergy-runtime/test-memory-engines/tencent/data` |
| TencentDB Wiki | `127.0.0.1:18524` | 同一独立 Tencent 测试目录 |
| OpenViking | `127.0.0.1:21933` | `F:/workspace/team-synergy-runtime/test-memory-engines/openviking/data` |

```powershell
node scripts/provision-test-memory-engines.mjs start
node scripts/provision-test-memory-engines.mjs probe
node scripts/provision-test-memory-engines.mjs verify
# 停止本工具核验过 PID、创建时间、可执行路径和命令的进程，保留测试数据。
node scripts/provision-test-memory-engines.mjs stop
```

首次启动拒绝已存在且没有本工具身份标记的目录、未知端口占用；已有部署复用前核验目录、配置 hash、源 junction 和进程身份。失败启动也可执行 `stop`，但无法证明身份时必须手工排查，工具不会按端口盲杀进程。没有自动递归删除功能。

独立根目录限制为当前 Windows 用户访问。凭据仅写入此目录的私有文件，控制台只输出文件路径。给测试 API 的服务端环境设置：

```powershell
$env:TSP_MEMORY_ENGINES_FILE='F:/workspace/team-synergy-runtime/test-memory-engines/engines.private.json'
```

该文件只含测试 Tencent 服务 token 和测试 OpenViking account 管理员 key，不包含业务凭据，也不导出 OpenViking root key。`projects`、`accounts` 初始为空，测试 API 依自己的新建账号和项目动态注册。测试数据库还必须使用独立测试集群，见 [数据库隔离](testing-database-isolation.md)。

只读复用既有 Tencent 官方源码和已安装依赖：新目录的 `tencent/source` 是唯一指向外部的 junction，数据目录不使用 junction。只运行既有 launcher 的 `serve-core` / `serve-knowledge` 分支，不调用 `start`，因此不应用补丁、不编译共享源码。OpenViking 使用现有 0.5.3 可执行程序，新配置与 workspace；实际安装版本的 RAGFS 在进程内运行，旧 AGFS `port` 字段明确已废弃，不另占旧端口。宿主环境按允许列表重建，数据库 URL、旧 TDAI/OV 配置、`NODE_OPTIONS`、模型密钥均不会继承；HOME、APPDATA、TEMP 也指向测试目录。

显式 `NO_PROXY/no_proxy=127.0.0.1,localhost,::1` 防止 Python HTTPX 从 Windows 系统代理解析出回环模型请求的代理。首次自检已复现未设置时 `/api/version` 返回 502、绕过代理时 200；不读取或更改系统代理设置。Windows venv 的控制台 launcher、venv Python shim、真实 CPython 是多层进程，首次登记必须同时核验父子链、创建时间、固定配置参数和 `pyvenv.cfg` 指向的解释器；后续停止以完整进程身份为准。

若首次初始化因控制进程创建 HOME/TEMP 空目录而中断，`recover-empty-bootstrap` 只允许预期的空 HOME/AppData/TEMP 树，写入 pending 身份标记后重跑 `start`；它不删除文件、不接受其它文件、数据或 junction。未知非空目录仍拒绝。

Ollama 11434 / 11435 仅共享计算服务：Tencent embedding 和 Wiki/VLM 使用现有 11434，OV embedding 使用现有 CPU 11435 的同一 `bge-m3` 权重。工具不下载或修改模型，不重启计算服务。计算共享仍可能影响性能，不得同时做性能基线测试。

`probe` 通过 API 创建随机 scope，核验 Core / Wiki / OV 原文 hash，并按身份精确删除这些 scope，生成无凭据 `probe-<run>.json`。只保留专用引擎的 bootstrap 管理员、服务写入者、团队、agent 与 OV 测试 account 供后续联调。此检查证明隔离实例的健康、存储和清理，不证明 Agent 推理、自动采集或吞吐性能。

```powershell
node --test tests/test-memory-engines-isolation.test.mjs
```

2026-11-12 已完成独立部署、两次精确 stop/start、三引擎随机原文写读删。最终结果与中间失败的恢复证据见 [隔离验证记录](experiments/native-memory-capture/20261112-test-engine-isolation/validation.json)。最后一次 probe 的 Core/Wiki/OV 原文 hash 全通过，OV 删除任务终态与用户 404 均核验；显式 NO_PROXY 后当前 OV 进程日志未出现 embedding error。此前测试误将内部删除队列的 `target` 字段当作公开 DELETE 返回，失败原件保留，后续按精确 resource 验证任务完成和用户已删除，未盲目重发删除。
