# UA/codegraph 到业务规则与需求候选

日期：2026-11-09。状态：首版实现；在既有代码理解与 intake 链路上增加规则提炼方法和固定源码接入。没有引入新的数据库表或 Graphify 运行依赖。

## Agent 入口

在已绑定项目的用户工作空间运行，明确选择一个已发布的分析：

```powershell
tsp intake prepare --code-run <run-code> --code-query "<业务范围>" --profile pilot --out <新目录>
```

也可用 `--code-node <已查询到的节点ID>` 定位范围。每个候选包对应一个仓库和分析；多仓项目逐仓准备，再以各自版本和证据汇总。`--scope` 可缩小到该分析实际捕获范围的子集，省略时沿用捕获范围；不允许扩大到快照以外。不能同时用 `--include-untracked` 将当前工作区混入历史分析。

代码理解页的“从本次分析生成需求”提供同一命令。原“接入已有代码”入口保留当前工作区方式，并链接到代码理解页选择分析版本。

准备完成后，让 Agent 阅读包内 `AGENT.md`、`SKILL.md` 与 `references/business-rules.md`。prepare 只采集与校验输入，不调用模型，也不自动提交候选。

## 三者的职责

1. **UA**：找到业务模块、职责、流程与边界，确定需要解释的场景。
2. **codegraph**：用同一个 run 查询符号、调用与影响上下文。缺边和推断只能作为线索。
3. **spec-production 2.2.0**：回查固定源码、SQL、配置与测试，区分资格过滤、排序和运行控制；整理规则、异常、状态及恢复，再形成结构化需求和验证计划。

规则文档记录稳定 BR ID、条件、结果/保留状态、例外、来源和测试断言。规则与结构化需求、AC、验证计划建立对应，避免只生成一篇不能进入平台的长文。

原生 codegraph context 可能返回未加平台前缀的符号 ID；调用 `tsp code callers` 等命令时使用 `cg:<原生ID>`。已带 `cg:` 的 ID 不重复加前缀。本次 Agent 试跑保留了首次失败和正确重查记录。

这套方法借鉴固定版本的 `codebase-graph-prd-rules`；上游 Graphify-first 导航已明确适配成平台 UA/codegraph。来源、提交与 MIT 通知见 [method-sources.md](../skills/spec-production/references/method-sources.md)。它是平台适配版，不声称原封不动执行上游工作流。

## 产物和版本归属

| 文件 | 用途 |
| --- | --- |
| `intake.json` | 原有候选协议：模块、Feature、规则文档、结构化需求及其证据、AC、验证计划。 |
| `code-knowledge.json` | 获授权的已发布知识投影；保留 repository/run/snapshot/commit、artifact 摘要、插件版本、覆盖和裁剪信息。作为资料输入一并采集。 |
| `intake.sources.local.json` | 仅本机保存的固定源码路径及快照映射；不进入提交包。 |
| `AGENT.md` | 固定版本的后续查询与写作交接；不是业务事实证据。 |
| `SKILL.md`、`references/` | 随安装 CLI 分发的固定方法，不依赖源码仓库或全局 Skill 安装。 |

业务规则正文放在 `requirement_document.content_markdown`；结构化行为使用已有 `specification.business_rules/exceptions/state_changes/data_contracts`、`acceptance_criteria` 和 `verification_plan`。不增加协议未定义字段，也不把原生图节点 ID 当作源码证据。

公开输入的代码 revision 记录 `snapshot:<id>`；具体 run、artifact 和插件身份保存在知识文档及规则文档的来源说明。分支名不作为版本主键。Web 将这种输入标为“固定分析快照”，不把它描述成当前工作区状态。

## 校验与审阅

```powershell
tsp intake validate <目录>/intake.json
tsp intake export <目录>/intake.json --out <新预览目录>
```

确认候选内容后，使用现有 `intake submit` 保存草稿，随后由项目管理者按既有流程审阅和发布。没有自动批准、自动 apply 或新增项目冻结步骤。

`--code-run` 先验证当前项目权限、仓库归属、已发布运行与本机快照一致，再读取原始快照字节。validate/submit/replace 会复验快照和资料；源码改变、额外文件、路径链接、知识文档漂移或来源映射降级都会拒绝，不静默退回当前 Git checkout。代码事实仍使用原始相对路径、SHA-256 与真实行号。

原 `tsp code requirements-context` 继续是知识文档导出，仍明确标记未复验原始源码。普通仓库、纯资料和历史候选路径不被改写；历史 Skill 版本仍可读取。

## 首版边界

- 需要原分析工作空间中的本机快照；远端知识投影本身不能代替原始源码。
- 初始知识投影最多 100 个节点，明确记录裁剪；Agent 可继续查询同一 run。它不是整个仓库的业务覆盖证明。
- 自动校验验证协议、版本、字节和结构，不证明每条业务解释正确。独立语义复核仍有价值。
- 读到测试代码只能标为已定义/未执行；验收计划不等于运行结果。
- 没有持续失效检测、跨仓自动业务推断、完整规则字段数据库或自动需求批准。

## 代码位置

| 责任 | 文件 |
| --- | --- |
| 新 prepare 选项与原流程衔接 | `apps/cli/src/intake.ts` |
| 固定版本知识、快照身份及 Agent 交接 | `apps/cli/src/intake-code-knowledge.ts`、`code-understanding-context.ts` |
| 原始证据采集与提交前复验 | `apps/cli/src/intake-materials.ts` |
| 规则方法、来源与版本 | `skills/spec-production/`、`packages/contracts/src/intake.ts` |
| 命令入口与固定来源展示 | `apps/web/src/CodeUnderstandingWorkbench.tsx`、`IntakeWorkbench.tsx`、`locales/codeUnderstanding.ts` |
| 回归 | CLI 的 `intake-code-knowledge.test.mjs`、`intake-skill.test.mjs`；Web 的代码理解/接入工作台测试；服务端 Skill 分发测试。 |

## 验证记录

- CLI 完整回归：专用隔离数据库中 131 项通过、1 项可选原生引擎 fixture 跳过；真实 UA/codegraph 查询另在本机试跑执行。首次使用默认测试连接因认证配置失败，未把该结果计为通过。
- Web 完整回归：373/373；包含固定分析命令入口及来源展示。服务端 Skill 分发相关回归 6/6，候选协议/生产检查 19/19。
- 全仓构建与类型检查通过；lint 零错误、70 个已有警告；迁移策略 3/3。
- 按现有流程备份、同步和构建 runtime/service，执行独立迁移，API readiness 与 Web 均返回 200。11 个相关源码/技能文件的 source/runtime 摘要一致。
- 在 user-space 对 `W3Q0P72K24AE9E89P021`（提交 `92728fbe`）真实 prepare，采集 638 个原始文件与 1 份知识文档。知识查询返回 100/790 节点并明确裁剪，未标为全项目覆盖。

样例修订、独立语义复核及草稿链接见 [本轮集成试跑](experiments/ua-codegraph-rules-intake-20261109/README.md)。原始 Graphify 方法试跑参考 [效果评估](experiments/codebase-graph-prd-rules-20261109/README.md)。
