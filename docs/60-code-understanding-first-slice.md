# 代码理解首个可运行切片

日期：2026-10-27。本文记录 [接入设计](59-code-understanding-plugins.md) 的实际交付边界，不表示整个 K1–K6 已完成。

后续更新：2026-10-28 已用 [原生 UA 阅读器](61-native-ua-reader.md) 替换首版 UA 分页 SVG，当前项目视图与新分析版本以该记录为准。本文保留首版验收历史。

## 运行入口

- 源码：`F:\workspace\team-synergy`。
- 运行服务：`F:\workspace\team-synergy-runtime\team-synergy-service`。
- 本机工作空间：`F:\workspace\team-synergy-runtime\team-synergy-user-space`。
- Web：[TeamSynergy 项目的代码理解](http://127.0.0.1:5173/projects/19Q4K7PDARXQ9JHW6R6F/understanding)，沿用平台登录。
- 本次分析：`E2HH7X0BWJ7ENT8R6HPE`，仓库 `P1KRPDABN4RD0YXMX64E`。
- 已发布并选用的项目视图：`YY0ER60A3AX0T4FCJ2CP`；产物摘要 `5828c2ab090e43f3f3a9c7906e7ff34c8fbb65a61087156cc11dc4dde4d1d917`。
- 源码提交：`92728fbec04cfa34fee4421cb0a9319d1b755164`。这是固定的提交快照，不包含当前未提交的集成代码。

完整源码、原生索引和插件 runtime 留在本机。服务只保存版本元数据、关系投影、相对路径/行号及受限片段；原生查询结果标记 `publication_safe: false`，不直接上传。

## 实际闭环

1. 注册本机已安装的兼容插件。当前适配器支持 UA `2.9.8`、codegraph `1.6.2`；登记 runtime 和生产依赖内容摘要。
2. `analyze prepare` 从 Git 对象捕获固定源码，创建服务端运行记录、上报索引进度，实际调用 UA 扫描/导入关系/批次计算及 codegraph 原生 SDK 建图。
3. 当前 Agent 阅读固定材料与源码，提交原生 UA KnowledgeGraph checkpoint。语义解释始终标为推断。
4. `validate` 检查快照、runtime、UA 原生 schema、范围与引用、上传投影及敏感文本模式；`publish` 保存不可变结果。
5. Agent 用 `view compose/select` 明确选择项目仓库版本组合；发布本身不切换当前视图。草稿与提交各有独立指针，并发选择使用预期值检查。
6. Web 只读查看 UA 分层地图、业务流程导览、codegraph 符号/关系及证据。Agent 可查询同一版本的 UA 投影，并用本机 codegraph 查询调用者、影响范围、任务上下文等。
7. `requirements-context` 导出带版本和证据身份的知识文档，供现有 `intake --material` 消费。它不会自动把代码解释认定为需求，也不会自动改写需求正文。

这些步骤没有新增项目冻结、审批或 apply 环节。

## 可以直接使用的命令

在上述用户工作空间运行；如果 `tsp` 不在 PATH，可用以下 PowerShell 包装当前 service CLI：

```powershell
function tsp { node 'F:\workspace\team-synergy-runtime\team-synergy-service\apps\cli\dist\index.js' @args }

tsp code plugins list
tsp code plugins doctor
tsp code analyze status --run E2HH7X0BWJ7ENT8R6HPE
tsp code overview --run E2HH7X0BWJ7ENT8R6HPE --engine ua --remote --limit 30
tsp code search --run E2HH7X0BWJ7ENT8R6HPE --engine ua --query 登录 --remote
tsp code relations --run E2HH7X0BWJ7ENT8R6HPE --node ua:step:password-session:authenticate --remote
tsp code relations --run E2HH7X0BWJ7ENT8R6HPE --node ua:file:packages/application/src/auth-use-cases.ts --remote
tsp code context --run E2HH7X0BWJ7ENT8R6HPE --task 'How does project access authorization work?' --limit 8
tsp code callers --run E2HH7X0BWJ7ENT8R6HPE --node 'cg:function:3655e1e1cee43ba291f78ec8c902f9e5' --limit 8
tsp code requirements-context --run E2HH7X0BWJ7ENT8R6HPE --query 登录 --out ./work/login-knowledge
```

`--out` 必须使用尚不存在的目录。原生 ID 只属于该运行，不能拿示例 ID 查询其他版本。`search --engine codegraph` 返回原生 ID；调用者查询使用 `cg:` 前缀。远端只查询已发布投影，不能运行原生调用链/影响分析。

新分析从以下命令开始，之后按返回的 `AGENT.md` 完成 UA 语义 checkpoint：

```powershell
tsp code analyze prepare --repository P1KRPDABN4RD0YXMX64E --ref HEAD
# 分析当前修改时必须显式选择草稿；新文件需要显式纳入
tsp code analyze prepare --repository P1KRPDABN4RD0YXMX64E --workspace-draft --include-untracked
```

本机材料位于 `.agent/code-understanding/runs/<run_code>/`。新分析使用新目录，查询在可丢弃副本上打开原生数据库，保留旧索引原件。恢复分析使用 `analyze resume`；已失败/取消的运行不会被复活。

## 已验证与限制

- 源码全量构建、类型检查和迁移策略检查通过。全仓 lint 为零错误、70 个已有警告；没有新增依赖。
- 真实 UA/codegraph fixture 测试验证扫描、建图、关联、调用者查询、原索引字节不变及错误提交拒绝。CLI/Web、契约、应用权限、HTTP 与持久化专项回归已通过。
- 实际项目捕获 638 个文件；codegraph 索引 447 个文件、9,303 个节点、31,621 条原生关系，另有 41,024 个未解析引用。关系属于静态推断，未解析和未覆盖部分不能当作不存在。
- 已发布整图为 11,352 节点、47,069 条关系、11,955 条证据记录（其中 626 条含受限片段），压缩空白后的 JSON 为 20,886,186 字节。UA 部分 2,049 节点、5 业务域、17 流程、74 步骤，638 个捕获文件都有位置证据；文件覆盖不等于完整语义验证。
- 实测 UA 登录步骤可追到 `auth-use-cases.ts`，该文件的一跳查询含 38 条双工具关联；原生 `assertProjectAccess` 调用者查询报告 96 个调用者，按 limit 返回并明确裁剪。
- 登录知识导出返回 49 个节点、未裁剪；已有 `intake prepare --material` 成功接收导出文档并创建本机候选包 `work/code-login-intake`，未提交或改写项目需求。
- 此次 UA 语义来源是同一提交的既有隔离分析，经固定源码抽查、路径范围与引用复核后复用。排除项和复核记录保存在用户工作空间 `work/ua-platform-checkpoint-review.md`。没有宣称重新完整推理所有文件。
- 本版上传一次最多 **32 MiB**，最多 25,000 节点 / 100,000 边 / 20,000 条证据；不支持分块上传。超限明确拒绝，不静默截断产物。
- UA 目前接收一个完整图 checkpoint（`ua-overview`）；原生批次材料已提供，但逐原生批次接受、重试和调度尚未实现。
- Web 使用平台自己的 SVG 展示适配，未嵌入 UA 全套原生 dashboard；关系查询为分页、受限的一跳投影。CLI 原生查询保留在本机。
- 支持多仓版本视图，跨仓语义边的提交协议尚未实现。
- 插件支持固定版本注册、兼容检查、每次运行固定 runtime 摘要和独立索引；新上游版本需新增适配与回归后才能登记，不能保证任意上游升级自动兼容。尚无安装器、自动升级或插件市场。
- 需求衔接当前属于知识文档导出：既有 intake 复验的是导出文档字节，不是原始仓库。原生代码知识来源类型、持续失效检测和完整 K6 替换仍待实现。
- 访问沿用项目权限；progress/publish 仅运行创建者可操作。敏感模式检测不是完整 DLP，已有客户/RLS 改造不能据此宣称完成。
- 2026-10-28 已完成登录后的浏览器核心链路验收：当前视图与提交显示正确；从“账号登录与会话维护”进入“校验密码与登录限制”，追到 `auth-use-cases.ts`，再通过 bridge 打开 codegraph 的 `loginWithPassword`（44–88 行）。UA 搜索/业务分层/适合画布、codegraph 独立搜索及受限证据片段均可用；验收标签页未记录浏览器 error。截图：`tmp/code-understanding-browser-acceptance.jpg`。此为单项目、单提交的交互验收，不代表所有角色、多仓和草稿场景均已在浏览器手测。

## 代码位置

| 范围 | 主要文件 |
| --- | --- |
| 协议与校验 | `packages/contracts/src/code-understanding.ts` |
| 表与迁移 | `packages/persistence/src/schema.ts`、`drizzle/0052_code_understanding.sql` |
| 用例与授权 | `packages/application/src/code-understanding-use-cases.ts` |
| HTTP | `apps/core-api/src/routes/code-understanding.ts` |
| CLI、快照、插件与需求导出 | `apps/cli/src/code-understanding*.ts` |
| 项目页面 | `apps/web/src/CodeUnderstandingWorkbench.tsx`、`codeUnderstandingApi.ts`、`codeUnderstandingMap.ts` |

复用了既有项目身份、权限、CLI 输出/API 客户端、资料导入和页面路由；未建立第二套账号或另一个模型服务。
