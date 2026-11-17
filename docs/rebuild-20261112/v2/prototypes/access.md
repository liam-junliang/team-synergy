# 成员入项与权限变更交互说明

交互稿为同目录的 [成员入项与权限变更原型](access.html)。打开即为成员首页，侧栏可进入项目列表、名册、计划、设备授权和治理控制台。页面数据是独立测试夹具；“切换负责人演示视角”供走查角色边界，“重新载入初始示例”回到初始数据。没有网络请求、真实身份、凭据、项目写入或浏览器存储。

## 如何复现一次权限收紧

1. 从首页打开“查看成员与权限”。当前人陈禾为团队继承 Member，名册另有一位 Owner、一位显式 Viewer、一位外部 Member。
2. 点击“检查管理资格”得到拒绝。从名册切换到林青的负责人示例，再选“团队可读”。预览显示只有陈禾失去写权；此时尚未生效。
3. 选择“仍有工作 · 保存策略”得到阻塞，在原状态保留团队写权。切换独立的已交接夹具后保存，查看新名册中陈禾为 Viewer，两个显式例外仍在。
4. 独立测试“私有项目”。预览与确认都显示陈禾失去项目访问。没有其他项目的成员可看到成功加载后的空列表。

## 页面、字段、角色和验证依据

| 入口与状态定位 | 谁有权 / 输入与操作 | 可观察输出、异常和验收依据 |
| --- | --- | --- |
| `#projects`、`#workspace`、`#empty`、`#readonly` | 有效成员查看已授权项目、所属团队和自身角色；从项目名进入。空数据示例无任何授权。外部 Viewer 只读其获授权项目。 | 首页可查背景、参与指引、仓库与成员入口；空列表展示无项目，外部角色不因此获取团队名册。对应 M01-F02、M02-F03、M03-F01。 `apps/web/tests/teams-project-access.test.mjs:54-102`、`apps/core-api/tests/project-home.test.mjs:39-75` |
| `#members`、`#restricted` | 项目成员查看姓名、授权来源和有效角色；成员检查管理资格。 | 可以查看名册，普通 Member 和 Viewer 均不能提交项目策略。对应 M02-F05/F06。 `packages/application/src/project-access.ts:23-74`、`packages/application/tests/permission-members.test.mjs:66-99` |
| `#owner`、`#preview`、`#private-preview` | 唯一 Owner 从 team_write 选择 team_read 或 private。预览列出一名继承成员的原角色、目标角色及影响数。 | 本例中变更只作用于陈禾。确认前保持当前策略，取消回到选择页。两名显式被授权者和 Owner 不计入变化。对应 M02-F05。 `packages/application/src/project-policy-use-cases.ts:12-42`、`packages/application/tests/permissions-policy.test.mjs:91-108` |
| `#blocked`、`#saved`、`#private-saved` | Owner 保存，同一动作提供“有未交接工作”及“已交接”两套独立前置。 | 拒绝分支保持原规则；成功的只读分支显示保存后的四人名册，私有分支删除陈禾继承访问。对应 M02-F05/F06。 `packages/application/src/project-policy-use-cases.ts:45-74`、`packages/application/src/member-use-cases.ts:28-40` |
| `#plan`、`#schedule`、`#schedule-error`、`#schedule-saved` | 成员看到试点阶段、里程碑和两项 Feature；切换示例 Owner 后为“售后申请”选择起止日期。 | 初始 1 项待规划；窗口含 11 月 30 日，贴边排期可保存，跨到 12 月 1 日拒绝且保留待规划。对应 M03-F03/F04/F05。 `packages/application/src/schedule.ts:24-49`、`apps/web/src/ProjectPlanWorkbench.tsx:668-691` |
| `#identity`、`#approved`、`#denied` | 已登录且不需首次改密的成员核对 CLI 名称、平台及示例码；勾选后可批准，也可直接拒绝。 | 未勾选时无批准动作；批准仅表示浏览器确认，终端须单独兑换；拒绝不产生会话。对应 M01-F04。 `apps/web/src/DeviceAuthorization.tsx:8-18`、`apps/core-api/tests/device-sessions.test.mjs:49-72` |
| `#governance`、`#gov-list`、`#gov-denied`、`#gov-stale` | 有效平台管理员选择项目、看状态与快照，可尝试提交过期快照；单纯项目 Owner 被拒。 | 平台目录权限不授予项目正文。示例当前版本 17，提交 16 时冲突，可刷新，原项目不被覆盖。对应 M12-F01/F02。 `apps/core-api/tests/admin-governance.test.mjs:37-79`、`packages/application/src/admin-governance-use-cases.ts:125-157` |

**交互边界。** 原型使用原生链接、勾选框、可折叠说明与 CSS 片段导航。字段示例固定，影响数由既定夹具展示。正式系统中的目录网络错误、并发写入、CLI 轮询及 Git 连接需按模块文档的验收步骤在隔离环境另测。此稿的交互检查只验证展示层。
