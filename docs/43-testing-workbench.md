# 测试工作台

测试工作台用于维护项目的测试范围、执行方法和已发生的测试结果。Web 导航位于「任务」之后、「缺陷」之前，「交接」位于「缺陷」之后，路径为 `/projects/:project_code/testing`。页面分为「测试用例」「测试资料」「执行记录」三个页签，Web、API 和 `tsp test` 读取同一份版本化数据。

## 第一版范围

| 对象 | 保存内容 | 历史规则 |
| --- | --- | --- |
| 测试用例 | 标题、摘要、模块、关联需求、优先级、手工/自动化方式、套件名、标签、前置条件、操作步骤与预期结果、Markdown 说明、关联资料 | 每次修订生成版本，旧版本可读取 |
| 测试资料 | 说明、脚本、数据、环境、报告；来源为 Markdown、文件、URL 或项目 Git 仓库引用 | 原始文件、正文和来源随版本保存 |
| 执行记录 | 执行人、来源、时间、环境、被测版本、commit、可选任务、用例结果与证据、资料版本 | 保存时固定快照，不随用例或资料更新而变化 |

套件是用例上的命名分组，例如 `smoke`、`login-regression`；不单独增加套件实体。环境说明作为 `environment` 用途的资料，执行记录仍须填写本轮实际环境。复杂排期、自动调度、CI 报告解析、覆盖率计算不属于第一版。

资料用途与存储方式分别描述“用来做什么”和“内容在哪里”：

- `purpose`：`guide`、`script`、`data`、`environment`、`report`。
- `storage_kind`：`markdown`、`file`、`url`、`git`。
- 脚本可作为文件上传，也可引用项目仓库里的文件或目录；报告可作为 Markdown、附件或链接保存。
- 文件保存原名、媒体类型、字节数与 SHA-256，最多 6 MiB。服务端校验字节和摘要；文件作为资料存储，不自动执行。

## 文档库与版本

文档库默认包含固定的「测试资料」系统文件夹。与项目规范、需求文档、架构设计的系统目录规则一致：系统文件夹不能删除、改名、移动或新增子文件夹。测试资料在此自动归集，测试页面与文档库使用同一条源记录和同一份修订历史，避免生成两套正文或版本。

结构化测试用例和执行结果在测试工作台管理；它们不伪装成 Markdown 文档。资料可以直接预览说明和来源，PNG、JPEG、WebP、GIF 等常见位图直接显示，文本脚本可展开查看，其他附件按需下载。Git 引用显示仓库、路径及执行说明。查看历史版本时，标题、正文、文件和来源一起切换。

测试页面与文档库复用同一个资料阅读器，内部沿用平台标准的吸顶文档标题、正文和版本侧栏结构；Markdown 继续使用共享渲染器。两处编辑均修订源资料，没有单独的文档库副本。`tsp docs show <asset_code>` 在 `testing_asset` 字段返回完整测试资料；`--output` 只导出 Markdown 说明。读取完整历史来源使用 `tsp test asset show`，原始附件使用 `tsp test asset download`。

创建对象返回服务端生成的公开 `code` 和 `current_revision`。修订必须提交实际读取过的 `base_revision` 与 `change_summary`；并发修改返回冲突，调用方先重新读取再决定如何合并，不能静默覆盖。

## Git 与可复现执行

Git 资料保存 `repository_code`、`path`、`ref`、`commit`、`command` 和 `setup`。仓库必须属于当前项目；可以是现有业务仓库的 `tests/`，也可以是项目已登记的独立测试仓库。平台保存来源信息，源码仍由 Git 管理，不自动 clone 或运行命令。记录执行时，服务端还把当时登记的仓库 `remote_url` 保存到 Git 快照，之后修改项目仓库地址不会改变该历史执行的来源地址。

资料定义允许只记录分支或 tag，便于维护入口；正式记录一次执行时，必须得到实际固定 commit。Git 资料版本已保存的 commit 优先用于该资料快照；缺失时，执行输入的 `commit_sha` 仅可在仓库归属明确时补足。多个不同仓库不能把同一个 commit 默认套用给所有来源，应分别在对应资料版本中固定 commit。

执行结果必须指定 `case_code` 和 `case_revision`，资料通过 `asset_refs` 明确指定版本。服务端验证这些版本确实存在且属于当前项目，保存完整用例快照和资料快照；二进制内容通过不可变的资料版本引用读取，不重复复制到每条执行记录中。新版用例发布后，历史执行展示 `is_outdated` 提示，并保留旧版步骤、预期和结果。

Web 历史执行中的「下载执行时的文件」使用快照里的资料编码与版本精确读取附件，并校对快照摘要；找不到原版本时显示错误，不回退下载最新版。执行时的用例详情也不提供通向最新版资料的混淆链接，资料统一从本次执行的快照区域读取。

`tested_version` 是本轮构建、发行或部署版本的可读标识；`environment` 是本轮环境说明，二者必填。`source: manual | agent | ci` 是提交者声明的执行来源，真实执行记录提交人始终来自认证会话，不能通过 JSON 伪造。

## 结果、缺陷与任务验收

逐项结果使用 `not_run`、`pass`、`fail`、`blocked`、`skipped`，记录实际结果、补充说明和报告 URL。记录至少包含一个用例，不允许同一记录重复列出同一个用例。汇总按这些状态计数。

只有失败项可以创建或关联缺陷。关联目标必须属于同一项目；创建缺陷时复现步骤、当时的预期、实际结果与证据来自已保存的结果快照，避免引用后来修改过的用例。缺陷关联可补充，原始执行结果不可改写。

测试工作台的执行记录与任务的 `Run`、verifier 验收是不同对象。记录测试通过不会调用 `task verify`，不会关闭任务，也不会自动改变关联任务或缺陷的状态。正式交付继续遵循原有任务提交、验证与关闭流程。

## 权限

- 项目所有有效成员均可读取，包括 Viewer 与获得访问权限的外部协作者。
- Member、Admin、Owner 可创建用例、资料和执行记录；Viewer 只读。
- 现有用例和资料由作者或 Owner/Admin 修订，且调用者此刻仍须有写权限。作者降为 Viewer 后不能继续编辑。
- 已归档项目禁止写入。模块、需求、资料、仓库、任务和缺陷引用都进行同项目检查。
- 创建与修订遵循用户、团队、项目的事务锁顺序，并记录审计；不可用过期权限绕过归档或成员权限调整。

身份、继承与管理员边界沿用 [团队与项目权限](42-team-project-permissions.md)。环境资料记录配置方法和凭据获取位置；不要把实际密码、令牌或生产数据作为测试说明提交。

## CLI 工作流

所有命令复用已登录的 HTTP 客户端。创建和列表默认使用当前目录的项目绑定，`--project <project_code>` 可以显式指定；按对象编码读取或修订时，服务端重新校验项目访问权限。输出沿用 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": ... }`，失败进程退出码为 1。

### 用例

`login-case.json`：

```json
{
  "title": "错误密码登录提示",
  "summary": "验证用户可以理解并恢复登录失败",
  "priority": "high",
  "method": "manual",
  "suite": "login-regression",
  "tags": ["login", "smoke"],
  "preconditions": "测试用户已存在，浏览器处于退出状态",
  "steps": [
    { "action": "输入正确账号和错误密码并提交", "expected": "显示密码错误提示，保留账号输入" },
    { "action": "改为正确密码并提交", "expected": "进入团队与项目页面" }
  ],
  "notes_markdown": "使用隔离的测试账号。",
  "requirement_codes": [],
  "asset_codes": []
}
```

```sh
tsp test case create --file login-case.json --project PROJECT_CODE
tsp test case list --suite login-regression --method manual
tsp test case search "登录" --requirement REQUIREMENT_CODE
tsp test case show CASE_CODE --revision 1
tsp test case revise CASE_CODE --file case-patch.json --base-revision 1 --change "补充登录恢复步骤"
```

`case-patch.json` 只需包含修改字段；数组字段提供完整的新数组。可用 `--notes-file notes.md` 导入 Markdown 说明。`list/search` 还支持 `--module`、`--query`；搜索覆盖正文、步骤和元数据。

### 资料

```sh
tsp test asset create --title "发布冒烟说明" --purpose guide --file smoke.md
tsp test asset create --title "登录自动化脚本" --purpose script --file login.spec.ts --notes-file script-guide.md
tsp test asset create --title "测试报告" --purpose report --url https://ci.example.com/build/42/report
tsp test asset list --purpose script --kind git
tsp test asset search "登录"
tsp test asset show ASSET_CODE --revision 2
tsp test asset revise ASSET_CODE --base-revision 2 --change "更新测试数据" --file fixtures.json
tsp test asset download ASSET_CODE --revision 3 --output ./fixtures.json
```

`.md`/`.markdown` 默认作为 Markdown 正文，其他扩展名默认作为文件附件；`--kind file` 可把 Markdown 作为原始附件。默认媒体类型为 `application/octet-stream`，可通过 `--mime` 明确指定。完整资料 JSON（含模块、需求、标签）使用 `--input asset.json`；命令行字段覆盖 JSON 中对应字段。

Git 来源使用 `--git-file git-source.json`，例如：

```json
{
  "repository_code": "REPOSITORY_CODE",
  "path": "tests/e2e",
  "ref": "main",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "command": "pnpm test:e2e",
  "setup": "pnpm install；按环境说明准备本地测试账号"
}
```

示例 commit 仅表示格式，提交时必须填写实际测试使用的 commit。

```sh
tsp test asset create --title "Web E2E 仓库入口" --purpose script --git-file git-source.json
```

下载必须明确指定 `--output`，默认拒绝覆盖；确认覆盖普通文件时使用 `--force`。下载历史版本不会替换成最新版，附件写出前校验大小与 SHA-256。URL 和 Git 来源不由 CLI 下载、访问或执行，应使用 `show` 获取入口后由本地工具处理。

### 执行与缺陷

`execution.json`：

```json
{
  "title": "登录回归 · build 42",
  "environment": "staging / Chrome / 隔离测试数据集",
  "tested_version": "build-42",
  "commit_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "source": "agent",
  "asset_refs": [{ "asset_code": "ASSET_CODE", "revision": 2 }],
  "results": [{
    "case_code": "CASE_CODE",
    "case_revision": 1,
    "result": "fail",
    "actual_result": "错误密码返回 500，页面没有反馈",
    "notes": "相同输入复现两次",
    "report_urls": ["https://ci.example.com/build/42/report"]
  }]
}
```

```sh
tsp test execution record --file execution.json
tsp test execution list --query "build-42"
tsp test execution show EXECUTION_CODE
tsp test execution defect EXECUTION_CODE RESULT_CODE --feature FEATURE_CODE --title "错误密码触发 500" --severity high
tsp test execution defect EXECUTION_CODE RESULT_CODE --defect DEFECT_CODE
```

最后两条分别用于新建和关联，不应为同一结果重复执行。新建严重程度使用 `critical/high/medium/low`。用例编码、资料编码和结果编码均使用服务端返回的真实值。

任务 Context Pack 仅包含测试的检索入口，不自动复制项目全部测试资料或二进制附件。Agent 先 `list/search` 获取索引，再 `show --revision` 或 `download --revision --output` 精确读取所需版本。

## HTTP 接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET/POST /projects/:project_code/test-cases` | 搜索用例 / 创建用例 |
| `GET/PATCH /test-cases/:code` | 读取版本 / 修订用例 |
| `GET/POST /projects/:project_code/test-assets` | 搜索资料 / 创建资料 |
| `GET/PATCH /test-assets/:code` | 读取版本 / 修订资料 |
| `GET/POST /projects/:project_code/test-executions` | 执行索引 / 记录执行 |
| `GET /test-executions/:code` | 固定快照、结果和证据 |
| `POST /test-executions/:code/results/:result_code/defect` | 从失败结果创建或关联缺陷 |

接口以当前认证身份授权，列表不包含文件字节。类型契约位于 `packages/contracts/src/testing.ts`；客户端不直接读写数据库。
