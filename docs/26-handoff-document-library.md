# 项目文档库

## 定位

文档库是项目级资料的统一查询入口，汇总项目规范、需求文档、架构设计，以及接口、联调、部署、数据迁移、发布和运维等资料。需求与架构关联原始文档及历史版本，保留各自的业务维护入口。

每个项目可以创建多级文件夹和多份 Markdown 文档。文档当前内容保存在主记录中，每次修订同时生成不可变 Revision，任务交付后可以固定引用具体文档版本。

## 建议目录

- 接口与联调
  - 前后端对接
  - 外部系统
- 部署与环境
- 数据与迁移
- 发布与运维

目录是查找结构，不承担功能模块、Feature、阶段或里程碑的语义。功能结构在“项目”中维护，需求和计划仍在各自页面维护。项目规范、需求文档、架构设计三个系统根目录自动创建，不允许改名、移动、删除、归档或新建/移入子文件夹，详见[统一文档库与系统目录](39-unified-document-library.md)。

## 文档类型

- `doc`：通用 Markdown 文档，显示为 DOC
- `api`：接口定义、鉴权、请求响应、错误码、幂等和示例
- `diagram`：图表资料，显示为 DIAGRAM

旧用途分类继续兼容并保留原值；联调、部署、数据、运维、发布等用途通过目录和内容组织。Mermaid、draw.io 和图片图源通过 `tsp architecture` 保存。

## Agent 查阅与维护

Agent 可通过以下 CLI 操作文档库：

```text
tsp docs list --project <project_code>
tsp docs search <关键词> --project <project_code>
tsp docs show <document_code> --output <local.md>
tsp docs folder-create --project <project_code> --name <name> [--parent <folder_code>]
tsp docs create --project <project_code> --folder <folder_code> --kind api --title <title> --file <local.md>
tsp docs upload <local.md> --project <project_code> [--folder <folder_code>] [--kind api]
tsp docs upload <local-folder> --project <project_code> [--folder <folder_code>] [--kind auto]
tsp docs revise <document_code> --file <local.md> --change <summary>
```

`tsp docs upload` 接受单个 Markdown 或一个本地文件夹。上传文件夹时，CLI 会创建同名云端根文件夹，递归保留子目录，并上传其中的 `.md`、`.markdown` 和 `.txt` 文档；`.git`、`.agent`、`node_modules`、构建输出和符号链接会被忽略。`--kind auto` 根据文件名、目录名和 Mermaid 代码块识别 API 或 DIAGRAM，其余作为 DOC，也可以为整批文档显式指定类型。系统目录限制同样适用于 CLI。

`tsp docs search` 当前按关键词查询，返回索引条目；确认文档编码后用 `tsp docs show` 读取内容。需求和架构的创建、修订分别使用 `tsp requirement-doc` 与 `tsp architecture`。旧 `agentctl handoff`、`acp docs` 保留兼容，新的指引统一使用 `tsp docs`，详见[CLI 命名与安装](40-cli-naming-and-installation.md)。

Web 左侧文档库的每个文件夹可独立展开或收起；切换文档时，其所在目录路径会自动展开，搜索状态下会展开目录以避免隐藏匹配结果。

领取任务或绑定外部 Agent Run 时，CLI 会把文档库索引和当前普通文档副本写入 `.agent/project-state/handoff/`。需求和架构继续通过各自资料通道读取，避免重复装入上下文。平台数据库仍是真相源，本地文件只是执行上下文快照；旧快照路径与字段保持兼容。

## 后续关联标准

任务不应笼统关联“项目文档”。任务简报可以引用需要阅读的交接文档编码；提交任务时，非代码交付物或接口变更应固定记录文档编码和 Revision。代码 diff 属于 Change Set，测试结果属于 Evidence，交接文档属于 Artifact，三者分别记录。
