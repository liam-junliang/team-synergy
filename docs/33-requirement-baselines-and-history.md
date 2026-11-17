# 需求基线与变更轨迹（第一版）

需求基线是由项目 Owner 确认的一组准确需求修订。它复用 `requirement_revisions`，同时冻结需求标题、状态、归属、正文、验收标准和待确认问题。需求随后更新，不会修改既有基线、任务绑定或已发布交接。

## 使用流程

1. 在需求页完善需求并确认。只有已确认、实现中和已交付的需求可进入新基线。
2. 打开项目的“需求基线”，填写名称、适用范围和变更理由，选择完整需求集合，确认并冻结。Owner 的确认即首版审批动作。
3. 需求发生变更时继续使用原有需求修订流程，不修改旧基线。创建下一基线时记录理由并选择新的完整集合；未纳入的旧条目表示移出本次范围。
4. 从历史列表选择任一基线，在“版本差异”中比较另一基线或当前需求。比较包含新增、移除以及修订、正文、验收、问题、标题、状态和归属的前后值。
5. 在尚未执行的任务详情绑定基线。有关联需求的任务，其固定修订必须存在于基线且版本一致。开始过执行的任务不允许重新绑定，后续变更应创建新任务。
6. 跨人交接时自动携带完整基线及原任务需求版本；接收人在自己的电脑和 Agent 中继续该目标。上游材料发生变化仍走现有漂移检测和 Owner 明确确认流程，不会自动刷新冻结包。

基线历史按项目的 V1 → V2 → V3 演进，每版保留父版本、确认人、时间和理由。Web 创建时提交已知父版本，若另一人先创建新基线，则拒绝过时的请求。首版支持线性历史，不提供需求分支合并或多方审批。

## 可视化演进图

基线页的演进图按版本排列节点，连线取自已有父基线关系。点击版本节点查看冻结需求；点击连线查看从父版本到子版本的差异。末尾虚线“当前需求（未冻结）”用于比较最新基线和当前需求，不会创建或确认基线。

每个版本节点显示绑定的任务和交接。任务采用当前固定基线；交接采用当时上下文快照中的基线，二者独立展示，不用任务当前值反推历史交接。点击交接名称可打开现有交接详情。长列表可展开，未绑定记录单独列出；尚未加载的父版本或绑定版本会明确提示。

比较方向保存在页面地址的 `baseline` 与 `compare_to` 参数中，刷新及浏览器前进／后退可恢复同一对比。绑定记录定期刷新，也可使用页头刷新按钮。图与绑定投影均复用现有数据，无新增表或迁移；未发布交接仍仅对源执行者和 Owner 可见。

## 数据与完整性

- `requirement_baselines`：项目、版本号、名称、范围、理由、父版本、确认人、时间、内容 SHA-256。
- `requirement_baseline_items`：基线、需求、准确修订 ID 以及冻结内容。
- `tasks.requirement_baseline_id`：任务选择的基线；原有 `source_requirement_revision_id` 继续固定单条需求版本。
- 交接 `context_snapshots.manifest.requirement_baseline`：完整冻结基线；来源材料中同时提供可读基线正文。

基线和条目禁止修改、删除，条目仅可在创建基线的同一事务中加入，读取时重新校验内容哈希。创建与原有需求材料写入共用事务锁，避免混合读取多个时刻的内容。绑定和领取共用任务行锁及 `base_snapshot` 乐观版本，阻止并发领取后改绑。

`base_snapshot` 是既有任务并发版本，不是本功能的需求基线版本。需求基线 V2 也不代表软件已经交付；交付仍由代码、证据、验收及发布记录表达。

“当前需求”比较覆盖项目中最新需求，包括草稿和废弃状态。它用于查看变化，不会把草稿自动纳入已确认基线。需求文档、设计原型和项目文档仍由现有上下文快照机制管理，首版需求基线仅冻结所选需求条目。

## HTTP 与 CLI

以下接口要求设备 Bearer 身份，基线读接口要求项目成员身份，创建及绑定要求项目 Owner。

```text
GET  /projects/:project_code/requirement-baselines
GET  /projects/:project_code/requirement-baselines/bindings
POST /projects/:project_code/requirement-baselines
GET  /projects/:project_code/requirement-baselines/:baseline_code
GET  /projects/:project_code/requirement-baselines/:baseline_code/diff?compare_to=current
GET  /projects/:project_code/requirement-baselines/:baseline_code/diff?compare_to=:other_baseline_code
POST /tasks/:task_code/baseline
```

创建基线的请求包含 `name`、`scope`、`reason`、`parent_baseline_code`（首版为 null）和 `requirements: [{ requirement_code, revision }]`。需求修订数字来自既有修订历史。任务绑定请求为 `{ baseline_code, base_snapshot }`。

创建任务的 HTTP 请求可传 `baseline_code`。CLI 支持 `tsp task create ... --baseline <baseline_code>`：直接固定该基线中的需求修订，即使该需求当前已经存在新版本。普通任务创建流程保持兼容，可随后由 Owner 在 Web 绑定匹配基线。

任务 Context Pack 包含完整基线及哈希；交接沿用现有恢复、就绪、激活和租约协议，不共享另一人的凭据或 Agent 会话。

## 迁移与验证

新增 `0027_requirement_baselines.sql`，由 API 启动时的现有迁移器执行；应先构建再重启 API，确保编译后的迁移目录更新。

回归覆盖数据库不可变约束、跨项目隔离、Owner 权限、父版本并发冲突、正文与验收差异、旧版本任务创建、执行后改绑拒绝、完整 Context Pack、跨人激活和旧交接内容不变。测试仍使用独立的 `acp_test`，按 workspace 串行运行。
