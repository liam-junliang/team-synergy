# 代码规格接入操作指南

第一版支持把现有代码整理成候选模块、Feature、需求文档、需求和 Mermaid 架构资料，在项目内审阅后新增或关联已有资料。不会清空项目、覆盖已有正文、创建历史讨论或自动结束任务。

## 1. 绑定本机项目与仓库

使用已经从平台安装并授权的 `tsp`。在项目工作空间执行，先确认 `tsp auth whoami`、`tsp project identify` 和 `tsp repository status` 返回预期身份、项目与本机仓库绑定。仓库必须经过 `tsp repository attach` 或 `clone` 注册；有平台权限不代表自动获得 Git 访问权限。

接入使用当前 Bearer 登录身份。成员可以读取和提交候选；只有项目负责人、管理员可以审阅和发布。观看者不能读取候选与源码定位。系统管理员身份本身不授予项目接入权，外部项目成员按其实际项目角色处理。

## 2. 准备分析材料

```sh
tsp intake prepare --repository <仓库编码> --scope src tests --out outbox/intake-001
```

企业级项目档案使用：

```sh
tsp intake prepare --repository <仓库编码> --scope apps packages --profile enterprise --out outbox/intake-enterprise-001
tsp intake validate outbox/intake-enterprise-001/intake.json --profile enterprise
```

企业级档位会生成 `dossier-plan.md`、`templates/*.md` 和更严格的 SKILL 说明，要求提交项目章程、上下文、领域模型、需求、NFR、架构、API/数据、测试策略、安全、运维和 ADR 等产物；详见 [企业级项目档案](49-enterprise-dossier.md)。

命令使用当前工作空间绑定。可加 `--project <项目编码>`，但必须与本机绑定一致。`--scope` 接受一个或多个仓库相对路径，用 `/` 分隔；`.` 表示整个仓库。输出目录必须是新目录，建议放在工作空间的 `outbox/`。重新分析时用新目录，保留上一批候选。

生成三个文件：

- `intake.json`：来源指纹和空候选模板。
- `context.json`：当前角色可见的项目资料索引与历史来源关联。
- `SKILL.md`：随 CLI 固定版本的分析说明。

`prepare` 不调用模型。让本机 Agent 阅读 `SKILL.md`，在绑定仓库内阅读选定代码，填写候选 `items`。空模板不能提交。使用平台技能库管理其他分析规范时，可额外采用已审核的固定版本技能；协议中的 `skill_version` 仍记录本次内置接入技能版本。

清单只包含 Git 跟踪的 UTF-8 文本文件。未跟踪文件、环境与凭据文件、私钥、依赖、生成目录、锁文件、二进制和超过 2 MiB 的文件被排除；路径穿越、符号链接与目录联接被拒绝。需要分析新增源码时先明确检查并 `git add`，然后重新准备。平台仅接收候选及定位、指纹，不接收整仓源码；Agent 使用哪个模型服务取决于本机配置。

Git 采集关闭 hooks、fsmonitor、可选索引写入和自定义 `clean` / `process` 过滤器，不下载 Git LFS 内容或执行过滤器扩展。`dirty` 反映未经过自定义过滤器处理的本机文件状态；来源指纹始终对应实际读取字节。不会为了生成清单隐式执行仓库程序。

工作空间在 `.agent/intake/<仓库编码>.json` 保存稳定 `namespace`。保留该文件；后续 Agent 按 `context.json` 的既有关联复用候选 `key`，不能因标题或文件改名生成新身份。跨工作空间迁移时恢复此来源记录，或审阅时明确关联已有条目。

## 3. 校验与提交

```sh
tsp intake validate outbox/intake-001/intake.json
tsp intake submit outbox/intake-001/intake.json --idempotency-key intake-submit-001
```

校验检查严格协议、同包引用、证据行号、清单摘要、当前绑定仓库的文件内容及 Git 状态。提交和替换候选都会重新校验。代码变动后需重新准备并复核，不能直接改 SHA-256 绕过检查。测试仅有定义时填写 `defined` 或 `not_run`；只有真实运行才能填写结果并在 `note` 记录命令、时间、环境与来源指纹。所有上传测试结果仍是客户端报告。

提交只写候选区，不创建业务实体。返回的批次编码用于后续读取。网络中断或结果不确定时，用相同请求内容和相同幂等键重试；同键不同内容会冲突。幂等键为 8–100 个字母、数字或 `. _ : -`。

## 4. 预览、审阅与发布

```sh
tsp intake list
tsp intake preview <批次编码>
tsp intake status <批次编码>
```

在 Web「项目 → 代码规格」选择批次，阅读候选、证据、未验证项与已有资料。负责人或管理员逐项选择新增、关联已有或跳过，提交审阅后冻结计划。关联已有条目只建立来源映射，不改正文或历史版本。子项依赖的模块、Feature 或需求文档也必须有可发布或可关联的候选。

可以在 Web 发布，也可以使用已审阅的计划摘要：

```sh
tsp intake apply <批次编码> --plan <已审阅的计划SHA256> --idempotency-key intake-apply-001
```

CLI 不隐式批准候选。权限、计划版本和依赖由服务端重新检查。发布按条目保存结果与映射；有成功项时，后续失败不代表全部回滚。先读取 `status` 再处理失败。

已结束或已停止的 attempt 使用原幂等键只读取持久化批次状态，不触发新的续传。若服务中断时 attempt 仍在执行，使用相同键可在事务锁下继续未完成项。主动停止或发生部分失败后要恢复发布，确认当前状态和计划后使用新的 attempt 键；已成功项不会重新创建。停止后如需修改候选，重新审阅，再执行新计划。

材料锁持续繁忙时，服务端会返回冲突并保留运行中记录。CLI 可使用原请求键恢复。Web 先重新读取批次；如果持续显示发布中且没有新进展，可以停止此批次，再选择继续发布。此操作保留已经提交的结果，不需要重新上传或重新创建已有条目。

## 5. 修订候选与停止

```sh
tsp intake replace <批次编码> outbox/intake-002/intake.json --base-revision <已读取版本>
tsp intake stop <批次编码> --base-revision <已读取版本>
```

成员只能修改本人可编辑批次，负责人和管理员可管理项目内批次。成功发布的项受到保护。替换候选使旧审阅计划失效，需要重新审阅；不能用该命令改已有业务正文。

`stop` 阻止后续条目发布，保留已提交资料与收据，当前正在提交的一项可能完成。它不是回滚或删除操作。项目归档或权限撤销后不能继续发布，历史事实保留。

所有命令使用 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": ... }` 的 JSON envelope，失败退出码非零。脚本应按稳定错误码处理，不按界面文案解析。Web 审阅、`tsp` 提交和发布使用同一项目权限与审计链路。
