# 测试与证据工具

用同一 HTTP Connector 的项目编码、任务及用例开展核验。项目成员与执行环境提供真实测试结果。登记测试事实和提交 Builder 任务可分别进行。

## `list_test_cases`

传 `projectCode`。可选 `query`，按用例编码或内容中的文字查找。返回匹配用例的 `code`、`current_revision`、前置条件、步骤与预期、关联需求和 `asset_codes`。保存实际执行用例的编码与修订。执行依赖资料时获取该资料的确切版本，避免用新版覆盖历史执行所用版本。

## `record_test_execution`

仅在操作者要求登记结果且具备项目写权限与任务协作授权时调用。必填 `projectCode`、当前项目的 `task_code`、`title`、实际 `environment`、`tested_version` 和 `results`。可选 `commit_sha`、`notes_markdown`、`asset_refs`。`commit_sha` 填实际测试提交的 40 或 64 位小写十六进制值。`asset_refs` 最多 20 项，以 `{asset_code,revision}` 为每个关联资料指定确切版本。引用 Git 资料时固定仓库和提交。执行涉及多个仓库时分别核对各自的固定提交。

`results` 每次 1–20 项，每个用例只能出现一次。单项必填 `case_code`、实际执行的 `case_revision` 和 `result`，可选 `actual_result`、`notes` 和最多 5 个 HTTPS `report_urls`。用 `pass` 或 `fail` 记录实际判定，用 `blocked` 记录阻塞，用 `skipped` 记录跳过，用 `not_run` 记录尚未执行。补充观察结果与证据。若用例关联 `asset_codes`，为每项关联资料提供对应 `asset_refs`。

示意输入中的编码、版本和结果均需换为实际值。

```json
{
  "projectCode": "00000000000000000001",
  "task_code": "00000000000000000003",
  "title": "回滚后数据校验",
  "environment": "隔离的迁移验证环境",
  "tested_version": "build-42",
  "results": [{
    "case_code": "00000000000000000004",
    "case_revision": 2,
    "result": "pass",
    "actual_result": "回滚后与迁移前均为 128 条记录",
    "report_urls": ["https://reports.example.test/build-42/rollback"]
  }]
}
```

返回执行记录 `code`、各状态 `counts`、关联任务编码和执行记录 `url`。用此链接引用单次执行报告及日志。任务状态通过各自的领取、提交与验收动作推进。需要提交 Builder 结果时另用 `submit_task_evidence`，用任务的验收项编号关联通过证据。
