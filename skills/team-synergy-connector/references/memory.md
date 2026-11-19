# 项目与个人记忆

在同一连接使用已确认的 `projectCode`。项目记忆包括讨论、决定和资料引用。读取本人偏好前核对 `get_connection_context` 的 `allowPersonalMemory`，并显式传 `scope: "personal"`。按结果中的 `applicability` 区分账号和项目适用范围，偏好仍需按本次任务授权使用。

示例中的 20 位编码应替换成同一连接查得的项目编码或实际返回的来源。

## `search_memory`

适合查明确主题、关键字或事由。`query` 必填，去除首尾空白后为 1 至 256 字符。`scope` 默认 `project`，可选 `personal`。返回 `data` 数组，每条含 `source`、`scope`、`state` 和 `text`，最多 30 条。项目结果可能带关联议题、需求和修订，也可能是资料索引卡。按 `source` 继续核对上下文，或按下述来源类型读取正文。

```json
{"projectCode":"00000000000000000001","query":"备份验收","scope":"project"}
```

## `read_memory_brief`

用于快速了解当前项目，或在关键词检索无命中时查近期线索。`scope` 必填，选择 `project` 或 `personal`。返回 `data` 数组，最多 6 条，并附 `evidenceStatus` 说明。简报受条数与篇幅限制，要查具体事项再用 `search_memory`。空简报只表明当前简报范围没有可见条目。

## `read_memory_sources`

用搜索或简报返回的 `source` 精确回读记忆，`sources` 接收 1 至 40 个来源编码。`scope` 默认 `project`，应沿用初次检索的范围。返回可见来源的 `data` 数组。缺少某个来源时，从原项目和范围重新检索并核对权限或修订。

- `discussed` 表示讨论记录。`confirmed` 表示决定已确认。落实、测试和上线仍应查执行证据。
- `preference` 表示本人范围的记录。`documented` 表示资料记载或摘要。引用时保留状态与 `source`。
- `sourceKind: "project_material"` 表示资料索引卡，用 `locator.sourceCitation` 调 `read_project_material`。`sourceKind: "project_document"` 表示项目文档摘录，可用 `read_memory_document`。

## `read_memory_document`

传入项目文档摘录返回的修订来源编码 `source`。该修订必须仍为可见的当前修订。默认从 `offset: 0` 开始，`limit` 默认 4000，范围 2 至 8000。可改用 `query` 在该文档内做不区分大小写的字面查找，`occurrence` 默认 `first`，也可传 `last`。`query` 和 `offset` 二选一，`occurrence` 仅配合 `query`。

返回 `title`、`sourceRevision`、`text` 和 `range`。继续读取时传 `range.nextOffset`。遇到 `memory_source_unavailable`，在原项目重新检索来源。若查找无命中，可换关键词或用 `offset` 分页。资料索引卡应使用资料工具读取。

```json
{"projectCode":"00000000000000000001","source":"00000000000000000002","query":"验收","occurrence":"first","limit":1200}
```
