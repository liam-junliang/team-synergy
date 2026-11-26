# 任务协作工具

每次调用传同一 HTTP Connector 发现的目标 `projectCode`。项目写入需连接有任务协作授权，账号具备对应项目权限，且操作者要求本次动作。先用 `search_tools` 携带 `projectCode` 查询当前可用操作。使用工具返回的公开编码。

## `list_project_features`

只需 `projectCode`。返回项目的 Feature、状态、所属模块等摘要。创建草稿前依据范围核对目标 Feature，用返回的 `feature_code` 作为父项。多个候选无法区分时问操作者。

## `list_tasks`

用于查看任务清单。可选 `status` 按一个状态筛选，例如 `draft`、`assigned`、`running`、`submitted` 或 `closed`。`mine: true` 筛选当前账号获分派的任务。`limit` 为 1–50，默认 20，`offset` 默认 0。根据返回的 `has_more` 和已读条数翻页。清单提供 `task_code`、状态、验收项、接收人编码、快照和任务链接。准备执行前用 `get_task` 确认详情。

## `get_task`

传 `task_code`。返回当前任务约定、关联需求或缺陷、`acceptance`、状态、`base_snapshot`、执行 `runs`、`evidences`、`artifacts` 及详情 `url`。用最新的 `base_snapshot` 分派、领取或提交。发生快照变化、并发冲突或写入响应超时时，先回读任务和 Run，再判断先前动作是否生效。

## `get_task_workflow`

传 `task_code`。读取 `execution` 和 `delivery`，包括最新快照、Run 健康状态、取消所需的确认、当前交付编码和哈希、验收人及验收进度。先核对 `allowTaskWrite`，再结合任务操作资格选择写入工具。使用 `get_task` 读取全部验收项、提交证据和产物。

## `create_task_draft`

必填 `feature_code`、`title`、`acceptance`、`idempotency_key`。`acceptance` 由 1–30 条 `{id,text}` 组成，编号唯一，每条描述可观察的通过条件。可选 `brief`、`profile`、`source`、`requirement_code`、`defect_code`、`depends_on_codes`。`profile` 可选 `planner`、`builder` 或 `verifier`，默认为 `builder`。有写权限的成员可创建默认的 `ad-hoc` 草稿，项目负责人或管理员可使用 `requirement`、`defect-fix`、`integration`。`defect-fix` 需绑定同一 Feature 的 `defect_code`。所关联的需求和依赖任务须属于目标项目。

返回 `task_code`、`draft` 状态、`base_snapshot` 和详情链接。同一创建操作超时重试时复用原参数和原 `idempotency_key`。新建不同草稿时使用不同的键。仅要求建草稿时，收到 `draft` 回执即可结束。

示意输入中的编码、标题、验收项和幂等键需要替换为本次实际值。

```json
{
  "projectCode": "00000000000000000001",
  "feature_code": "00000000000000000002",
  "title": "确认回滚能够恢复数据",
  "acceptance": [{"id": "AC-1", "text": "回滚后的记录数与迁移前一致，并附核对结果"}],
  "idempotency_key": "draft-rollback-2026-001"
}
```

## `assign_task`

项目负责人或管理员在明确要分派时调用。必填 `task_code`、最新 `base_snapshot` 和 `assignee_principal_code`。通过同一项目的 `list_project_members` 获取接收人的 `user_code`，选择有写权限的成员。符合状态门槛时可直接分派具备验收项的草稿，也支持待分派任务和符合返工条件的失败任务。返回 `assigned`、接收人编码、新快照和链接。确认成功后通知操作者当前负责人。

## `claim_task`

用于领取当前账号已获分派的 `builder` 任务。必填 `task_code`、最新 `base_snapshot`、真实可访问的 HTTPS `workspace_url` 和 40 或 64 位小写十六进制 `git_base`。工作区和 Git 基线由实际执行环境提供。任务须处于 `assigned`，依赖任务已关闭，且当前没有进行中的 Run。已有设备租约的任务应走对应执行入口。

成功返回 `running`、`run_code`、`workspace_code` 和任务链接。把本次 `run_code` 与目标项目、任务和领取使用的连接一起保留。需要提交时通过 `get_task` 获取最新快照。

## `submit_task_evidence`

用于提交当前连接领取并执行的 Builder Run。先核对任务为 `running` 且 Run 仍是 `active`，备好实际产物和自测。必填 `task_code`、`run_code`、最新 `base_snapshot`、`artifact` 和 `evidence`。

- `artifact.kind` 从 `commit`、`document`、`prototype`、`report`、`other` 选择。`artifact.uri` 填可核验的 HTTPS 链接，`artifact.content_hash` 单独填该产物 40 或 64 位小写十六进制哈希。
- `evidence.result` 填实际通过的 `pass`，`evidence.acceptance_refs` 使用本任务中实际通过的验收项编号，`evidence.summary` 描述执行、观察和结果。可用 `evidence.command` 保存自测命令。自测失败、阻塞或尚未执行时，如实报告当前状态和证据。

返回 `submitted`、产物与证据编码、新快照和任务链接。随后由独立验收流程核验证据。代码提交、推送、PR 与合并走项目自己的 Git 工作流。按需求交付任务链接和证据来源。

## `cancel_task`

项目负责人或管理员可取消执行前或仍处在执行环节的任务。提供 `task_code`、最新 `base_snapshot` 和 `reason`。如果 `execution.cancellation_requires_confirmation` 为真，确认操作者同意中止当前 Run 后传 `confirm_active: true`。可传 `idempotency_key`，同一次请求重试沿用原参数和原键。成功后回读 `cancelled` 和已取消的 Run。平台撤销旧执行的写入资格，保留已有证据和历史。

## `start_task_review`

使用成果作者以外的有权成员账号。通过 `get_task` 核对验收项和实际证据，再通过 `get_task_workflow` 核对验收人和交付版本。传 `task_code` 与最新 `base_snapshot` 开始验收。

## `finish_task_review`

传 `task_code`、最新 `base_snapshot`、已核对的 `submission_code`、`result`、`acceptance_refs` 和 `summary`，可附 `report_uri`。交付编码取自 `get_task_workflow` 的 `delivery.submission_code`。`pass` 须有全部验收项的实际核验证据，成功后进入 `verified`。`return` 进入 `failed`，`request_evidence` 保持 `submitted` 并登记补证要求。

## `close_task`

项目负责人或管理员提供 `task_code` 和最新 `base_snapshot`，关闭已经 `verified` 的任务。成功后回读 `closed`。项目要求的 PR 审批、合入及其他交付记录按各自流程核对。
