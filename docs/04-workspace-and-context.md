# 工作区与功能上下文

## 两层工作区

本地环境明确区分长期存在的“项目工作空间”和一次执行使用的“Run 工作区”。二者不是同一实体，也不共享生命周期。

### 项目工作空间

项目工作空间是某个用户在一台设备上绑定云端项目的本地协作目录。产品、设计和开发岗位都可以使用；没有开发需要时，`code/` 可以保持为空。

```text
/project-workspace               # 根目录本身是一个 Git 仓库
├── .agent/
│   ├── bound-project.yaml       # 本机项目绑定，根 Git 忽略
│   └── repositories.local.yaml # 本机仓库路径登记，根 Git 忽略
├── work/                        # 临时协作材料
├── outbox/                      # 待上传的需求、原型、说明等正式产物
└── code/                        # 根 Git 整体忽略
    ├── web/                     # 独立 Git 仓库，可选
    ├── service/                 # 独立 Git 仓库，可选
    └── cli/                     # 独立 Git 仓库，可选
```

根 Git 只维护工作空间产物；`code/` 下每个代码仓库拥有自己的 remote、分支和提交历史，不使用嵌套目录冒充一个仓库，也不要求使用 Git submodule。代码仓库也可以位于工作空间之外，通过本机登记挂接；本地绝对路径不会上传云端。

云端项目只保存代码仓库的名称、用途、remote URL、默认分支和启用状态，以及项目工作空间的用户、名称和最近活动时间。初始化与按需取代码的标准命令是：

```text
tsp workspace init <project_code> --dir <workspace-dir> --name <device-workspace-name>
tsp repository list
tsp repository clone <repository_code> [--to code/<directory>]
tsp repository attach <repository_code> --dir <existing-git-directory>
tsp repository status
```

`workspace init` 会初始化根 Git、固定目录和 `.gitignore`，再写入 schema v2 的项目绑定。`repository clone` 只拉取明确选择的仓库，因此梳理需求、维护项目计划或制作原型不需要下载全部代码。

`repository clone --to` 只能写入当前工作空间的 `code/`；已有或位于外部目录的 clone 必须使用 `repository attach`。`repository status` 会重新校验登记 remote，remote 缺失或已切换到其他仓库时不会误报为 ready。

### Run 工作区

Run 工作区属于一次具体 Task/Run，由任务执行链路创建或登记：

```text
人 → Agent Profile → Task → Run → Run Workspace
```

同一个人、同一个工具或同一台电脑可以运行多个 Agent，但不能让并行 Run 共用同一个未提交代码目录。标准隔离结构仍是：

```text
/run-workspace
├── project-state/      # 项目状态快照，只读
├── inputs/             # 任务输入，只读
├── repo/               # 独立 Git Worktree，受限读写
├── private/            # 当前 Run 私有工作文件
├── outbox/             # 待发布正式产物
├── cache/              # 可重建缓存
├── logs/               # Run 日志
└── .agent/workspace.yaml
```

`workspace.yaml` 记录非敏感身份和基线；其中对外关联统一使用公开 code：

```yaml
project_code: TBP8SXKNJ092Y9086176
feature_code: 7D833Z6RNRJTJ8DXXP86
task_code: NR6BRJSDFSTVREP6JK9D
run_code: VTV4ZWZYNC0XDREQ5JWE
workspace_code: 7HZN547WQC8DZJJ4SWZ2
agent_profile: builder
project_snapshot: 18
git_base: a92f81c
```

## 功能上下文包

每个 Feature 应提供一个短而可追溯的 `Feature Context Pack`：

```yaml
feature_id: FEATURE-12
title: 用户登录
goal: 支持邮箱密码登录
scope:
  included:
    - 登录
    - 失败限流
  excluded:
    - 第三方登录
acceptance_criteria:
  - 正确密码可以登录
  - 错误密码不泄露账号状态
module_map:
  frontend:
    - apps/web/src/pages/login
  backend:
    - services/auth
entry_points:
  - POST /api/login
contracts:
  - API-CONTRACT-4
tests:
  - tests/auth
baseline:
  project_snapshot: 18
  git_commit: a92f81c
context_graph:
  snapshot: 28
  focus_nodes:
    - feature.user-login
  default_depth: 2
```

上下文分三层供给：

1. 一页功能速览：目标、范围、验收、风险、分工。
2. 模块地图：入口、依赖、接口、数据和测试位置。
3. 按需详情：具体文件、符号、调用链和历史变更。

三层内容应从同一 Project Context Graph 生成或引用，避免速览、模块地图和代码入口分别维护。Agent 获取 Task 时只收到经过权限过滤、以 Feature/Task 为焦点的子图；需要详情时再沿关系按需展开。

Context Pack 的内容组织、必读卡结构、预算分配与生成/回流闭环的详细设计见[Context Pack 详细设计](13-context-pack-design.md)。

## 公共与私有信息边界

| 信息 | 默认位置 | 是否共享 |
|---|---|---|
| 临时思路、调试笔记 | `private/` | 否 |
| 缓存和中间文件 | `cache/` | 否 |
| 未提交代码 | 当前 Worktree | 否 |
| Proposal、阻塞 | 平台任务记录 | 相关参与者 |
| Commit、正式文档 | Artifact | 是 |
| 测试和构建结果 | Evidence | 是 |
| 已生效决策 | 项目共同状态 | 是 |

## 产物发布

私有文件只有在进入 Outbox 并提交清单后，才可能成为正式产物：

```yaml
outputs:
  - path: outbox/api-contract.yaml
    type: contract
    retention: permanent
    requires_review: true
  - path: outbox/test-report.xml
    type: test_report
    retention: 30d
    requires_review: false
```

## 临时文件清理

MVP 采用简单的 `类型 + TTL + 引用检查 + 回收站`：

| 类型 | 默认保留 |
|---|---:|
| cache | Run 结束后立即或 24 小时 |
| scratch/private | 3 天 |
| 成功 Run 工作区 | 3～7 天 |
| 失败 Run 快照 | 14 天 |
| 普通日志 | 30 天 |
| 测试报告 | 30～90 天 |
| 正式代码、决策和契约 | 长期保留 |

清理前必须检查资源是否仍被活动任务、正式发布、事故或人工固定项引用。未提交代码应先生成 Patch 或明确提示，而不是静默删除。
