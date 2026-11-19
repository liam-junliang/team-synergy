# 代码规格

用同一连接和同一 `projectCode` 先确定仓库与快照，再查代码图及证据。读取能力由实际项目角色决定，`viewer` 无源码证据读取权限。HTTP Connector 可以读取已发布的分析结果。

## `read_code_catalog`

仅传目标 `projectCode`。返回 `repositories`、`runs`、`views`、`current_view` 和 `current_draft_view`。以 `repository_code` 找目标仓库，选择 `status: "succeeded"` 且带 `snapshot` 的运行，然后使用该运行的 `code`。正式视图用 `current_view`，明确需要对照草稿时选相应草稿视图或运行。引用版本时检查 `kind`、`snapshot.commit`、`snapshot.snapshot_id` 及分析范围。`truncated` 为真时，目录只包含部分运行或视图。

## `query_code_graph`

传 `run_code` 固定单仓库运行，或传 `view_code` 查询组合视图。两者都省略时使用项目当前正式视图。`provider` 可指定 `ua` 或 `codegraph`。`query` 可按节点名称、路径、摘要等匹配文本。继续查看关系时，传上次返回的节点 `id` 作为 `node_id`，同时传它自己的 `run_code`。`direction` 默认 `both`，可用 `in` 查入边、用 `out` 查出边。

`offset` 默认 0，`limit` 默认 100、最多 200。优先小页定向查找。返回 `nodes`、`edges`、`evidence`、`coverage`、`runs` 和 `total_nodes`。节点或边的 `evidence_ids` 可对应 `evidence` 中的路径、起止行与可用片段。跨仓库时一起检查 `repository_code`、`run_code` 与 `snapshot_id`。分页边集只包含本页节点之间的关系，`truncated` 为真时检查分页和证据预算。将 `observed`、`inferred`、`unresolved` 分开描述。需要最新版结论时，先核对快照是否对应预期提交。

以下示例中的 20 位编码应替换成目录或图工具实际返回的值，`node_id` 替换成同一次运行中的节点 `id`。

```json
{"projectCode":"00000000000000000001","run_code":"00000000000000000002","provider":"codegraph","query":"submitTask","limit":12}
```

```json
{"projectCode":"00000000000000000001","run_code":"00000000000000000002","node_id":"example-node-id","direction":"out","limit":15}
```
