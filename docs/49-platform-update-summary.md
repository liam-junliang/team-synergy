# 平台改动汇总（2026-10-19）

- 提交：`fcf46a4` Make existing projects and local agents share governed project workflows
- 分支：`main`，已推送 `origin/main`
- 规模：299 个文件，新增 23,537 行、删除 3,564 行
- 数据库：新增迁移 `0034`–`0039`，必须按顺序执行
- 影响面：Web、Core API、`tsp` CLI、`agentd`、CLI 安装脚本与发布流水线

本轮把项目治理、质量工作台、Agent 接入和既有代码接入合并为一次平台更新。共享 API、contracts 和迁移作为同一批交付，避免产生不可运行的中间版本；因此没有按功能拆成多个提交。

## 一、交付能力

| 能力 | 变化 | 主要入口 | 文档 | 迁移 |
| --- | --- | --- | --- | --- |
| 双语界面与项目切换 | 简体中文/英文即时切换；项目顶部下拉切换；文档阅读器固定头与资料列表滚动规范 | `apps/web/src/i18n.ts`、`LanguageSwitcher.tsx`、`ProjectSwitcher.tsx`、`DocumentReaderHeader.tsx` | [41](41-web-internationalization.md)、[34](34-web-ui-design-system.md) | — |
| 团队与项目权限 | Owner/Admin/Member/Viewer 分层；唯一负责人；所有权转移需接收人确认；外部成员；Web、CLI、Agent 按实时权限校验 | `packages/application/src/project-access.ts`、`member-use-cases.ts`、`ownership-use-cases.ts`、`apps/core-api/src/routes/ownership.ts` | [42](42-team-project-permissions.md) | `0034_permissions_ownership` |
| 测试工作台 | 测试用例、测试资料、执行记录；资料支持 Markdown/文件/URL/仓库引用；执行结果关联需求与缺陷 | `apps/web/src/TestingWorkbench.tsx`、`packages/application/src/testing-use-cases.ts`、`apps/core-api/src/routes/testing.ts`、`apps/cli/src/testing.ts` | [43](43-testing-workbench.md) | `0035_testing` |
| Agent 工作台与技能库 | 团队/项目技能目录、不可变修订、跨团队共享、项目固定版本、`tsp skill sync` 本机同步 | `packages/application/src/skills-*.ts`、`apps/web/src/SkillsWorkbench.tsx`、`apps/cli/src/skills.ts`、`skill-sync.ts` | [44](44-agent-workspace-skills-proposal.md) | `0036_skills` |
| CLI 分发与设备会话 | 含运行时的安装脚本；浏览器授权；设备与登录会话分离；任务租约；兼容旧绑定令牌 | `scripts/cli-install/`、`scripts/build-cli-distribution.mjs`、`apps/cli/src/browser-auth.ts`、`apps/core-api/src/routes/cli-distribution.ts` | [45](45-cli-distribution-device-sessions.md)、[40](40-cli-naming-and-installation.md) | `0037_device_sessions` |
| 系统管理台 | 用户、团队与项目治理，账号停用与密码重置，平台公开地址配置 | `apps/web/src/AdminWorkspace.tsx`、`AdminTeamsProjects.tsx`、`SystemSettings.tsx`、`apps/core-api/src/routes/admin-governance.ts` | [46](46-system-administration.md) | `0038_system_settings` |
| 代码规格接入 | 本机安全采集、候选预览、逐项审阅与冻结、新增或关联发布、停止与幂等续传 | `apps/cli/src/intake*.ts`、`packages/application/src/intake-use-cases.ts`、`apps/web/src/IntakeWorkbench.tsx`、`apps/core-api/src/routes/intake.ts` | [47](47-existing-project-intake.md)、[48](48-code-spec-intake-guide.md) | `0039_project_intake` |

同时补齐的支撑改动：

- `apps/core-api/src/error-status.ts`：业务错误映射为 4xx/5xx，不再一律返回 HTTP 200。
- `apps/core-api/src/auth.ts`：legacy `x-principal-code` 身份通道增加显式环境开关，默认只在非生产环境放行。
- `packages/application/src/execution-guard.ts`：Run 租约、执行代数与设备绑定校验。
- `.github/workflows/cli-release.yml`：CLI 安装包矩阵构建与发布。

## 二、升级与部署

1. 升级前备份数据库。
2. 按 `0034` → `0039` 顺序执行迁移。`core-api` 启动时会自动迁移，但生产升级仍应先备份并确认目标版本。
3. 同一版本更新 Core API、Web、CLI 和 `agentd`，不要混用旧客户端与新 API。
4. 成员重新安装或升级 CLI，然后执行 `tsp auth login --api http://<host>:5173/api` 走浏览器授权；已有绑定令牌登录继续兼容。
5. 在系统管理台确认平台公开地址，保证安装脚本与浏览器授权链接指向可访问的主机。

## 三、验证

- 提交记录：870 项包级测试通过；代码规格接入 API/CLI 端到端 6 项通过；20 轮并发重复测试通过；构建、类型检查、lint 通过。
- 1 项 CLI 分发符号链接测试因 Windows 环境限制跳过；lint 保留 70 项既有警告。
- 2026-10-19 复核：`pnpm -r typecheck` 与 `pnpm lint` 通过；未重跑 870 项全量测试。
- 真实浏览器点击验收仍未完成：保存的浏览器访问权限限制了自动化点击，本次使用 SSR、API 与 CLI 集成测试验证，不能替代视觉走查。

## 四、数据兼容

- 开发库核对的 16 张既有业务表，行数及内容摘要保持一致；本轮没有清理现有项目数据。
- 旧 `/#/...` 链接继续兼容；既有文档编码、Revision 和任务历史保留。
- 需求文档、架构资料与测试资料继续通过固定系统目录归集，规则见 [39](39-unified-document-library.md)。

## 五、已知边界

- Agent Client Protocol（Spike 2）与薄 MCP（Spike 3）仍未完成；`agentd` 目前是进程级会话管理。
- 没有 Dockerfile/compose 或一键部署包，局域网部署仍需手工步骤。
- 真实浏览器视觉验收、局域网多机实测和 Agent 准确率测量仍待补。

详细设计和使用步骤见文档 41–48，代码规格操作见 [48-code-spec-intake-guide.md](48-code-spec-intake-guide.md)。
