# 项目资料

使用从同一连接取得的 `projectCode` 查询有读取权限的项目。按标题找目录，按路径做筛选，或按正文定位命中行，然后读取对应修订。以下示例中的 20 位编码应替换成工具实际返回的值。

## `list_project_materials`

适合列出项目资料，或按已知标题、虚拟路径和摘要缩小范围。`query` 可选，按字面子串匹配。`sourceKinds` 可筛选 `project`、`requirement`、`architecture`、`testing`。`status` 默认 `active`，也可传 `archived` 或 `all`。`offset` 默认 0，`limit` 默认 40，最多 100。

返回 `items`，包含 `path`、`objectCode`、`title`、`summary`、`revision`、`sourceCitation` 和 `textSearchable`。正文另用 `read_project_material`。`nextOffset` 有值时可继续翻页。`catalogTruncated` 为真表示底层目录扫描有上限，此时少量结果不足以断言范围内没有其他资料。

## `glob_project_materials`

用 `pattern` 匹配 `sourceKind/objectCode.md` 形式的相对虚拟路径。`requirement/*.md` 找需求资料，`**/*.md` 匹配各类别的 Markdown 路径。`*` 和 `?` 限于单个路径段，`**` 可跨段。筛选项、分页和返回结构与 `list_project_materials` 一致。文件名是对象编码，按业务名称筛选时用 `list_project_materials`。

## `grep_project_materials`

在资料正文按行查找 `pattern`。`mode` 默认 `literal`，可选 `regex`。`caseSensitive` 默认 `false`，`contextLines` 默认 1，可取 0 至 5。通过 `pathGlob`、`sourceKinds` 和 `status` 缩小范围，`offset` 与 `limit` 控制命中行分页，`maxChars` 默认 16000，最多 32000。

结果的 `matches` 提供 `sourceCitation`、修订、路径、行列及上下文。`textTruncated` 为真时按命中行读原文。搜索可能跳过二进制或过大资料，受 `truncated`、`skippedBinary`、`skippedOversize`、`catalogTruncated` 提示。遇到正则超时，先限定路径或改用字面搜索。

```json
{"projectCode":"00000000000000000001","pattern":"验收条件","sourceKinds":["requirement"],"limit":10}
```

## `read_project_material`

每次选择一种定位方式。`sourceCitation` 固定到引用对应的修订，`path` 指资料的虚拟路径，也可同时传 `sourceKind` 与 `objectCode` 定位对象。用路径或对象定位时默认读取当前修订，也可指定正整数 `revision`。引用定位本身已包含修订。

用字符 `offset` 或从 1 开始的 `startLine` 和可选 `endLine` 选择范围。`limit` 默认 4000，范围 2 至 16000 个 UTF-16 码元，两种定位范围共用此长度预算。长文按 `range.nextOffset` 继续读取，并保持同一 `sourceCitation`。回复时保留标题、实际修订和 `range` 中的行号。`current: false` 时注明所读资料为历史修订或当前索引未确认。二进制资料只返回元数据，`unsupportedReason` 为 `binary_content`。

```json
{"projectCode":"00000000000000000001","sourceCitation":"00000000000000000002","startLine":20,"endLine":35}
```
