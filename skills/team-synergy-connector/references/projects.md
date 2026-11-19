# 连接、项目和工具发现

## `read_connector_skill`

首次接入用 `{}` 读取技能入口。需要操作细节时传 `module`，可选 `projects`、`materials`、`memory`、`code`、`tasks`、`testing`。返回 `name`、技能包内的 `path` 和 `markdown`。在当前 Connector 上直接读取，无需项目编码。

## `search_tools`

用 `{}` 查看模块、用途和工具数。用 `module` 约束范围，`query` 匹配工具名或中英文关键词。`limit` 默认 8，范围 1–20。列表带 `total` 和 `truncated`。跨项目时为当前动作传目标 `projectCode`，目录按项目角色和连接授权筛选。具体变更仍需通过对象状态与权限校验。

```json
{"module":"tasks","query":"草稿","limit":4}
```

已有任务目标时，可用关键字查少量候选，再读对应模块说明。只需知道模块用途时，一次空查询即可。

## `get_connection_context`

空参数核对账号、连接授权和可选的默认项目。`connectionScope` 为 `account` 时，可用 `list_projects` 查可访问项目。历史 `project` 授权限定为原项目。传目标 `projectCode` 后，结果包含项目名、角色、项目链接及 `allowTaskWrite`、`canAssign`。账号级 `allowTaskWrite` 表示连接授权，项目级结果才反映该项目的读写能力。`allowPersonalMemory` 单独控制个人记忆访问。

## `list_projects`

列出本连接可访问的启用项目。`query` 按项目名、编码或团队名匹配，`limit` 默认 40，最多 100。返回 `items`、`total`、`truncated`。每个项目带 `projectCode`、项目名、团队、角色、协作权限和 `projectUrl`。同名项目先核对团队。截断时用更具体的名称或编码搜索。

把选中的 `projectCode` 用在同一连接后续的项目工具上。同一对话可交替处理多个项目。工具报 `project_forbidden`、`connector_project_mismatch` 或找不到对象时，核对连接命名空间、项目角色与对象归属，重新从该连接取编码。

## `list_project_members`

传目标 `projectCode` 读取成员。结果的 `data` 含 `user_code`、`display_name`、`role`。分派时，将核对过的成员 `user_code` 作为 `assign_task` 的 `assignee_principal_code`。名称重复时确认身份。成员仍需具备该任务所需的权限。
