# 账号权限与系统管理：代码规格只读试点

日期：2026-10-18。**这是候选规格与证据样本，未导入平台，未修改 TS Platform 业务数据。**

## 结果

从当前工作区梳理出 **4 个建议模块、9 个 Feature、16 条行为规格、4 项后续任务建议**。模块划分是待审阅的产品建议；行为规格来自代码观察，不意味着业务已验收或满足生产要求。

对应[机器可读 JSON](auth-admin-pilot.json)与[功能设计](../../47-existing-project-intake.md)。

## 代码范围与版本

- Git HEAD：`88cd8bc57d13363cfdefdb47227ee783f1156908`；分支 `main`；工作区存在未提交内容。
- 证据清单：35 个文件；SHA-256：`93099d3a76f5631a0dae3381a50f6e85a36262409a65dbf2a306023dc9b7d87d`。
- 文件指纹在本次测试结束后采集；本任务没有修改业务源码，没有测试前全工作区证明。工作区后续变化会使样本过期。
- 仅覆盖账号权限、所有权、系统管理及相关接入配置。其他功能未分析，不代表功能缺失。
- 未读取或匹配线上现有实体，因此不能将这些候选全部直接新建到平台。

## 建议业务拆分

- **账号认证与设备接入**：密码登录与改密；设备、会话与浏览器授权。
- **团队与项目授权**：项目访问策略与外部协作；成员角色管理及工作交接保护。
- **所有权与账号生命周期**：唯一负责人及接受式转移；账号注销责任交接。
- **平台系统管理**：管理入口与团队项目治理；系统用户状态管理；CLI 地址配置与发布可用性。

## 规格索引

| 现状规格 | 稳定候选键 | 证据 |
| --- | --- | --- |
| 账号密码登录与强制改密 | auth.password-lifecycle | 3 组关联测试 |
| 稳定设备身份、独立会话与最后登录时间 | auth.stable-device-sessions | 3 组关联测试 |
| CLI 浏览器授权与一次性兑换 | auth.cli-browser-authorization | 3 组关联测试 |
| 项目独立授权及团队默认访问 | access.effective-project-role | 2 组关联测试 |
| 团队与项目成员角色管理边界 | members.management-boundaries | 2 组关联测试 |
| 权限收回前保护未完成任务和运行 | members.permission-change-handoff | 3 组关联测试 |
| 固定创建者与唯一现任负责人 | ownership.creator-and-owner | 2 组关联测试 |
| 接收确认的团队与项目所有权转移 | ownership.accepted-transfer | 3 组关联测试 |
| 注销前责任转移及历史保留 | account.closure-responsibility | 4 组关联测试 |
| 系统管理入口与业务权限分离 | admin.workspace-and-authority | 4 组关联测试 |
| 全局团队项目检索与有审计的元数据维护 | admin.metadata-governance | 3 组关联测试 |
| 运行及交接中的项目禁止直接归档 | admin.running-project-archive | 1 组关联测试 |
| 恢复普通用户不恢复旧凭据和租约 | admin.user-reactivation | 1 组关联测试 |
| 平台公开地址的安全校验、版本保存与审计 | admin.versioned-public-addresses | 4 组关联测试 |
| CLI 指引使用平台公开地址并等待配置加载 | admin.cli-guide-addresses | 3 组关联测试 |
| CLI 安装发布清单与实际可下载状态 | admin.cli-release-availability | 4 组关联测试 |

## 验证记录

使用独立测试数据库 `acp_intake_pilot_test`，先重新构建 Application 及依赖和 Core API，再执行 13 个相关测试文件。**共 108 项，107 通过，1 跳过，0 失败**。完整命令、测试名称与结果保存在 JSON 的 `verification.runs`。

跳过的是安装包符号链接逃逸测试，原因是当前 Windows 不允许创建测试符号链接；不能算通过。Web 检查是函数/API 适配与 SSR 测试，真实浏览器页面访问被已保存的权限设置阻止，本次没有进行浏览器交互验证。

上述是本机测试报告，不是服务端独立证明；关联测试只覆盖各自场景，不能把整条规格的全部行为都判为已验证，更不能关闭历史任务。

## 待确认及差距

- **项目创建权限错误文案不符实际行为**：createProject 使用 isProjectManager 允许团队 Owner/Admin，但拒绝文案仍为只有团队 Owner 可以创建项目。现有测试定义明确覆盖团队 Admin 创建成功。 作为文案修正候选核对，不自动登记已确认生产缺陷。
- **生产环境旧身份通道配置待确认**：未设置开关且不是 production 时接受声明式 x-principal-code；生产显式设置 ACP_ALLOW_LEGACY_IDENTITY=1 也会开启。未检查实际部署环境。 验证部署变量后才能声明生产已禁用旧通道。
- **会话到期与历史迁移策略待确定**：新会话期限固定为 90 天，旧凭据迁移会话未设置到期时间。 是否统一迁移到期或提供管理员策略属于目标需求，不能标记为已有能力。
- **外部协作者与所有权接收人的资格差异**：项目可授权外部成员，但所有权接收人必须是所属团队的正式成员。 规格中保留该现状边界，不把所有项目成员均可接收所有权作为推断结果。
- **真实浏览器保存配置后更新指引尚未验证**：本次权限设置阻止浏览器访问本地站点；接口和 SSR 通过不能替代保存、导航、重新聚焦及多标签页交互。 恢复可用浏览器测试环境后验证交互，保持未验证状态，不推断实际存在缺陷。
- **README 导航说明落后于当前路由**：README 的项目首页说明仍将文档置于任务之后且未列测试；当前 PROJECT_SECTIONS 为项目、文档、计划、需求、设计、任务、测试、缺陷、交接。 作为资料漂移候选，在全量资料同步时修订，不改写产品行为。

## 后续任务候选

- **统一项目创建权限的错误提示**：普通团队成员被拒绝时提示 Owner/Admin 可创建；原权限行为不改变。
- **验证配置保存后的 CLI 指引刷新交互**：覆盖保存后导航、刷新、重新聚焦和其他标签页；区分同客户端缓存失效与跨标签页更新。
- **确认生产部署的旧身份通道策略**：记录目标部署配置，验证未认证声明式身份不能访问需要 Bearer 的接口；不把开发默认值当成生产事实。
- **修订 README 的项目导航说明**：当前导航顺序与 workspaceRouting 一致，保留必要的历史兼容说明。

这些建议没有登记为实际缺陷或任务。会话期限是否可配置属于待确认目标，不能从当前固定期限反推产品需求；外部项目成员不能直接接收所有权是现状规则，不自动当作缺陷。

## 逐条现状

### 账号密码登录与强制改密

候选键：`auth.password-lifecycle`。

- 账号密码登录拒绝无效密码或非 active 账号；初始密码必须未过期。
- 需要改密的会话只允许 whoami、改密和退出，其他路由返回 password_change_required。
- 改密必须验证当前密码，新密码长度为 8–128 字符。
- 携带当前会话改密时保留该会话，吊销其他设备及同设备的其他会话；未提供当前会话时吊销全部设备。

实现依据：[packages/application/src/auth-use-cases.ts:37](../../../packages/application/src/auth-use-cases.ts)、[packages/application/src/auth-use-cases.ts:57](../../../packages/application/src/auth-use-cases.ts)、[apps/core-api/src/auth.ts:40](../../../apps/core-api/src/auth.ts)。

关联测试：

- [packages/application/tests/auth-use-cases.test.mjs:58](../../../packages/application/tests/auth-use-cases.test.mjs) — `initial password login requires a password change before normal use`（passed）。
- [packages/application/tests/auth-use-cases.test.mjs:95](../../../packages/application/tests/auth-use-cases.test.mjs) — `proactive password change requires the current password and revokes other devices`（passed）。
- [apps/core-api/tests/auth.test.mjs:162](../../../apps/core-api/tests/auth.test.mjs) — `initial password login blocks non-auth routes until the user changes password`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 稳定设备身份、独立会话与最后登录时间

候选键：`auth.stable-device-sessions`。

- 设备使用用户、client_type、installation_id 与安装密钥校验，不使用 MAC 地址。
- 同一安装再次登录复用设备及执行凭据，但创建新的会话；最后登录时间仅成功登录更新。
- 每个用户最多 10 个未吊销设备，新会话默认有效期 90 天。
- 退出只吊销当前会话；吊销设备会同时吊销其全部会话和运行租约。
- 重新登录不复活旧会话，旧设备凭据支持一次性迁移为会话。

实现依据：[packages/application/src/auth-device.ts:10](../../../packages/application/src/auth-device.ts)、[packages/application/src/auth-device.ts:30](../../../packages/application/src/auth-device.ts)、[packages/application/src/auth-device.ts:61](../../../packages/application/src/auth-device.ts)、[packages/application/src/auth-device.ts:83](../../../packages/application/src/auth-device.ts)、[packages/application/src/auth-use-cases.ts:104](../../../packages/application/src/auth-use-cases.ts)。

关联测试：

- [packages/application/tests/device-sessions.test.mjs:18](../../../packages/application/tests/device-sessions.test.mjs) — `the same verified installation receives separate sessions, preserves identity and updates only successful login timestamps`（passed）。
- [packages/application/tests/device-sessions.test.mjs:38](../../../packages/application/tests/device-sessions.test.mjs) — `concurrent password logins cannot bypass the unique installation or ten-device ceiling`（passed）。
- [packages/application/tests/device-sessions.test.mjs:89](../../../packages/application/tests/device-sessions.test.mjs) — `relogin on the same installation recovers an existing Run lease, different devices cannot, and device revocation invalidates it`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### CLI 浏览器授权与一次性兑换

候选键：`auth.cli-browser-authorization`。

- CLI 携带安装身份申请授权，获得用户授权码及轮询密钥；请求有效期 10 分钟。
- 用户须登录、完成初始改密并明确批准；拒绝、过期或已处理请求不能继续授权。
- CLI 初始轮询间隔 5 秒，过快轮询返回 slow_down 并增加间隔。
- 批准后仅轮询密钥可兑换会话，兑换在事务中只成功一次；浏览器自身会话不交给 CLI。

实现依据：[packages/application/src/device-authorization-use-cases.ts:10](../../../packages/application/src/device-authorization-use-cases.ts)、[packages/application/src/device-authorization-use-cases.ts:36](../../../packages/application/src/device-authorization-use-cases.ts)、[packages/application/src/device-authorization-use-cases.ts:54](../../../packages/application/src/device-authorization-use-cases.ts)。

关联测试：

- [packages/application/tests/device-sessions.test.mjs:60](../../../packages/application/tests/device-sessions.test.mjs) — `device authorization needs explicit approval, throttles polling and consumes the secret atomically once`（passed）。
- [packages/application/tests/device-sessions.test.mjs:78](../../../packages/application/tests/device-sessions.test.mjs) — `denied, expired and forced-password-change authorization never creates a session`（passed）。
- [apps/core-api/tests/device-sessions.test.mjs:49](../../../apps/core-api/tests/device-sessions.test.mjs) — `browser authorizes a CLI without sharing its own token and only the polling secret exchanges once`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 项目独立授权及团队默认访问

候选键：`access.effective-project-role`。

- 有效项目权限依次取唯一负责人、项目显式授权、团队默认策略，否则无权限。
- private 不提供团队继承权限；team_read 继承 Viewer；team_write 继承 Member。
- 项目显式 Viewer 覆盖 team_write，团队管理员身份本身不提供私有项目访问。
- 非团队成员可通过项目显式授权参与，并标记 isExternal。
- Viewer 可读不可写；Owner/Admin 可管理；仅 Owner 可管理管理员、访问策略、转移和归档。
- 非 active 或已注销账号无项目权限；归档项目保留读取，常规写入和管理被拒绝。

实现依据：[packages/application/src/project-access.ts:9](../../../packages/application/src/project-access.ts)、[packages/application/src/project-access.ts:28](../../../packages/application/src/project-access.ts)、[packages/application/src/project-access.ts:52](../../../packages/application/src/project-access.ts)。

关联测试：

- [packages/application/tests/permissions-policy.test.mjs:24](../../../packages/application/tests/permissions-policy.test.mjs) — `${policy}: effective access follows owner, explicit grant, team default, then no access`（passed）。
- [packages/application/tests/permissions-policy.test.mjs:196](../../../packages/application/tests/permissions-policy.test.mjs) — `archived projects retain read access but reject policy, member, and content changes`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 团队与项目成员角色管理边界

候选键：`members.management-boundaries`。

- 团队可授予 Admin/Member，项目可授予 Admin/Member/Viewer；不能直接授予 Owner。
- Owner 可任免管理员；Admin 可管理普通成员，但不能修改管理员同级、自己或 Owner。
- 项目 Owner 只能通过所有权转移变更，不能直接移除或降级。
- 撤销项目显式授权后重新计算团队继承权限；团队成员可能恢复默认访问，外部成员失去访问。
- 归档项目不允许成员权限变更，成功变更记录角色前后值及访问来源审计。

实现依据：[packages/application/src/team-use-cases.ts:18](../../../packages/application/src/team-use-cases.ts)、[packages/application/src/member-use-cases.ts:13](../../../packages/application/src/member-use-cases.ts)、[packages/application/src/member-use-cases.ts:62](../../../packages/application/src/member-use-cases.ts)。

关联测试：

- [packages/application/tests/permission-members.test.mjs:49](../../../packages/application/tests/permission-members.test.mjs) — `team and project admins manage ordinary members but cannot change peers, owners, or themselves`（passed）。
- [packages/application/tests/permission-members.test.mjs:85](../../../packages/application/tests/permission-members.test.mjs) — `removing an explicit role reports restored team access; external access is fully revoked`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 权限收回前保护未完成任务和运行

候选键：`members.permission-change-handoff`。

- 成员失去写权限或被移除前，检查其未结束任务及 active/preparing/suspended Run。
- 存在未完成工作时拒绝变更，返回任务和 Run 编码，权限及审计不发生部分写入。
- 只有项目 Owner 可预览及修改团队访问策略；预览返回新增读取/写入、失去访问/写入及显式例外数量。
- team_write 降为 team_read/private 时，只检查真正失去写权限的继承成员；Owner 与显式写授权不被默认策略覆盖。

实现依据：[packages/application/src/member-use-cases.ts:27](../../../packages/application/src/member-use-cases.ts)、[packages/application/src/member-use-cases.ts:71](../../../packages/application/src/member-use-cases.ts)、[packages/application/src/project-policy-use-cases.ts:11](../../../packages/application/src/project-policy-use-cases.ts)、[packages/application/src/project-policy-use-cases.ts:44](../../../packages/application/src/project-policy-use-cases.ts)。

关联测试：

- [packages/application/tests/permission-members.test.mjs:131](../../../packages/application/tests/permission-members.test.mjs) — `open work blocks readonly downgrades and removals atomically`（passed）。
- [packages/application/tests/permissions-policy.test.mjs:129](../../../packages/application/tests/permissions-policy.test.mjs) — `team_write to ${nextPolicy} requires inherited writers to hand off unfinished tasks`（passed）。
- [packages/application/tests/permissions-policy.test.mjs:175](../../../packages/application/tests/permissions-policy.test.mjs) — `team_write to ${nextPolicy} preserves owner and explicit writers without requiring unrelated handoffs`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 固定创建者与唯一现任负责人

候选键：`ownership.creator-and-owner`。

- 创建团队时记录 created_by 和唯一 owner_principal_id，创建者初始为 Owner，底层成员角色存 Admin。
- 团队 Owner/Admin 可以创建项目，普通团队成员不能。
- 项目创建者成为项目唯一 Owner，默认访问策略为 team_read；团队 Owner 不自动成为该项目 Owner。
- 待注销账号不能创建新的团队或项目。

实现依据：[packages/application/src/team-use-cases.ts:31](../../../packages/application/src/team-use-cases.ts)、[packages/application/src/project-use-cases-project.ts:40](../../../packages/application/src/project-use-cases-project.ts)。

关联测试：

- [packages/application/tests/permission-members.test.mjs:33](../../../packages/application/tests/permission-members.test.mjs) — `new team records immutable creator and unique owner while storing an admin membership`（passed）。
- [packages/application/tests/permissions-policy.test.mjs:52](../../../packages/application/tests/permissions-policy.test.mjs) — `team manager may create a project with a visible team_read default and becomes its sole owner`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 接收确认的团队与项目所有权转移

候选键：`ownership.accepted-transfer`。

- 正常转移由当前 Owner 发起，接收人必须是有效、非待注销的所属团队正式成员；项目外部协作者不能直接接收 Owner。
- 每个团队或项目只能存在一个有效待接收请求，请求 7 天过期。
- 接收人本人接受后才变更 Owner；前任 Owner 保留 Admin，created_by 保持不变。
- 团队和项目分别转移；转移项目不会自动转移团队，归档状态不被转移改变。
- 取消、过期或已处理请求不能重复接受；失效负责人恢复须专门权限及原因，并仍由接收人确认。

实现依据：[packages/application/src/ownership-use-cases.ts:48](../../../packages/application/src/ownership-use-cases.ts)、[packages/application/src/ownership-use-cases.ts:107](../../../packages/application/src/ownership-use-cases.ts)、[packages/application/src/ownership-use-cases.ts:141](../../../packages/application/src/ownership-use-cases.ts)。

关联测试：

- [packages/application/tests/permissions-ownership.test.mjs:27](../../../packages/application/tests/permissions-ownership.test.mjs) — `ownership changes only after recipient acceptance, retains creator and makes previous owner admin`（passed）。
- [packages/application/tests/permissions-ownership.test.mjs:47](../../../packages/application/tests/permissions-ownership.test.mjs) — `concurrent acceptance succeeds once and only one pending request exists per scope`（passed）。
- [packages/application/tests/permissions-ownership.test.mjs:75](../../../packages/application/tests/permissions-ownership.test.mjs) — `recipient eligibility is checked both on request and acceptance`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 注销前责任转移及历史保留

候选键：`account.closure-responsibility`。

- 注销采用开始、取消、完成阶段；待注销期间仍允许转出已有所有权。
- 完成注销前必须清空所有团队/项目所有权，包括归档项目及未确认的历史 Owner，并结束或交接任务和活动 Run。
- 最后一位有效系统管理员不能注销。
- 注销后禁用账号、清空密码及绑定令牌、吊销设备会话和租约，保留创建者、历史任务及设备记录。

实现依据：[packages/application/src/ownership-use-cases.ts:222](../../../packages/application/src/ownership-use-cases.ts)、[packages/application/src/ownership-use-cases.ts:245](../../../packages/application/src/ownership-use-cases.ts)。

关联测试：

- [packages/application/tests/permissions-ownership.test.mjs:168](../../../packages/application/tests/permissions-ownership.test.mjs) — `closure includes archived and unresolved legacy ownership and blocks until all responsibility is transferred`（passed）。
- [packages/application/tests/permissions-ownership.test.mjs:184](../../../packages/application/tests/permissions-ownership.test.mjs) — `closure blocks open work, then revokes credentials and leases while preserving history`（passed）。
- [packages/application/tests/permissions-ownership.test.mjs:213](../../../packages/application/tests/permissions-ownership.test.mjs) — `pending closure still permits outgoing transfers and former owners can close after separate team and project acceptance`（passed）。
- [packages/application/tests/permissions-ownership.test.mjs:250](../../../packages/application/tests/permissions-ownership.test.mjs) — `concurrent platform administrator closures retain one active administrator`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 系统管理入口与业务权限分离

候选键：`admin.workspace-and-authority`。

- 系统管理员的默认登录入口是 /admin/teams，管理台提供团队项目、用户和配置管理；显式项目和浏览器授权深链接保留。
- 普通账号不能挂载管理数据页面；管理接口使用 Bearer 身份并重新检查有效系统管理员权限。
- 全局元数据查看不自动加入团队或项目，不提供未授权的项目文档、需求和任务读取权。

实现依据：[apps/web/src/workspaceRouting.ts:184](../../../apps/web/src/workspaceRouting.ts)、[apps/web/src/AdminWorkspace.tsx:8](../../../apps/web/src/AdminWorkspace.tsx)、[packages/application/src/admin-governance-use-cases.ts:11](../../../packages/application/src/admin-governance-use-cases.ts)。

关联测试：

- [apps/web/tests/admin-workspace.test.mjs:29](../../../apps/web/tests/admin-workspace.test.mjs) — `admins land in management while browser approval and explicit project links survive login`（passed）。
- [apps/web/tests/admin-workspace.test.mjs:42](../../../apps/web/tests/admin-workspace.test.mjs) — `ordinary users cannot mount any admin data surface or issue admin queries`（passed）。
- [apps/core-api/tests/admin-governance.test.mjs:37](../../../apps/core-api/tests/admin-governance.test.mjs) — `system administrators see global metadata without becoming team or project members`（passed）。
- [apps/core-api/tests/admin-governance.test.mjs:62](../../../apps/core-api/tests/admin-governance.test.mjs) — `governance rejects business owners, legacy identity, anonymous, stale or disabled administrator authority`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 全局团队项目检索与有审计的元数据维护

候选键：`admin.metadata-governance`。

- 团队、项目支持搜索和分页，项目可按团队及状态筛选，成员数遵循有效成员访问规则。
- 修改团队名称、项目名称/说明/归档状态需要填写管理原因，业务变更和审计记录在同一事务内保存。
- 项目修改必须携带 base_snapshot，旧版本拒绝覆盖新内容；不改变创建者、现任负责人或成员授权。
- 团队名称修改当前采用行锁，没有与项目相同的调用者 base_snapshot 字段，不把项目并发规则泛化到团队。

实现依据：[packages/application/src/admin-governance-use-cases.ts:19](../../../packages/application/src/admin-governance-use-cases.ts)、[packages/application/src/admin-governance-use-cases.ts:110](../../../packages/application/src/admin-governance-use-cases.ts)。

关联测试：

- [apps/core-api/tests/admin-governance.test.mjs:79](../../../apps/core-api/tests/admin-governance.test.mjs) — `governance search and pagination preserve filters and count effective inherited membership`（passed）。
- [apps/core-api/tests/admin-governance.test.mjs:100](../../../apps/core-api/tests/admin-governance.test.mjs) — `metadata edits require reason, audit old/new values and preserve owners and membership`（passed）。
- [apps/core-api/tests/admin-governance.test.mjs:149](../../../apps/core-api/tests/admin-governance.test.mjs) — `stale administrator edits cannot restore an archived project or overwrite newer metadata`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 运行及交接中的项目禁止直接归档

候选键：`admin.running-project-archive`。

- 管理员归档项目时检查 active、preparing、suspended Run；存在这些运行或挂起交接时拒绝归档并返回运行编码。
- 通过检查的归档变更保持原负责人、成员及任务历史；归档不等同于删除。

实现依据：[packages/application/src/admin-governance-use-cases.ts:132](../../../packages/application/src/admin-governance-use-cases.ts)。

关联测试：

- [apps/core-api/tests/admin-governance.test.mjs:132](../../../apps/core-api/tests/admin-governance.test.mjs) — `admin archival guards all execution and handover run states without changing running work`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 恢复普通用户不恢复旧凭据和租约

候选键：`admin.user-reactivation`。

- 有效系统管理员可恢复被禁用的普通用户；拒绝系统管理员、已注销及待注销目标。
- 恢复前清理旧设备、登录会话及活动租约，账号须重新登录，恢复动作保留审计。

实现依据：[packages/application/src/user-use-cases.ts:263](../../../packages/application/src/user-use-cases.ts)。

关联测试：

- [apps/core-api/tests/admin-governance.test.mjs:250](../../../apps/core-api/tests/admin-governance.test.mjs) — `reenabling normal users is audited, refuses deletion, and cannot revive old device credentials`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### 平台公开地址的安全校验、版本保存与审计

候选键：`admin.versioned-public-addresses`。

- 管理员设置公开 Web/API 地址；留空清除覆盖值，Web 仅站点根路径，API 可有安全路径。
- 地址使用 HTTPS，本机回环允许 HTTP；拒绝凭据、查询参数、片段、控制字符及命令字符。
- 保存需完整字段和 base_revision；行锁检查版本，冲突不写入，真实变更递增版本并同事务审计，相同值不产生额外版本。
- 普通有效账号仅能读取两个公开地址，不能获取管理字段或保存设置。

实现依据：[packages/application/src/system-settings-use-cases.ts:18](../../../packages/application/src/system-settings-use-cases.ts)、[packages/application/src/system-settings-use-cases.ts:41](../../../packages/application/src/system-settings-use-cases.ts)。

关联测试：

- [apps/core-api/tests/system-settings.test.mjs:29](../../../apps/core-api/tests/system-settings.test.mjs) — `settings require active system-admin bearer credentials and client-config exposes only public URLs`（passed）。
- [apps/core-api/tests/system-settings.test.mjs:46](../../../apps/core-api/tests/system-settings.test.mjs) — `settings persist normalized URLs, version changes atomically with audit, and keep Host out of configuration`（passed）。
- [apps/core-api/tests/system-settings.test.mjs:97](../../../apps/core-api/tests/system-settings.test.mjs) — `URL validation rejects unsafe schemes, credentials, deployment paths and command injection without partial writes`（passed）。
- [apps/core-api/tests/system-settings.test.mjs:128](../../../apps/core-api/tests/system-settings.test.mjs) — `concurrent admins cannot overwrite an unseen settings revision or produce a phantom audit`（passed）。

限制：相关测试结果不代表所有分支及生产部署都已验证。

### CLI 指引使用平台公开地址并等待配置加载

候选键：`admin.cli-guide-addresses`。

- CLI 指引经同源已认证 API 获取公开地址，依据配置生成 --api 与必要的 --web 参数，不向配置域名发送当前平台认证请求。
- 无配置时使用当前站点回退；配置未加载或失败时不显示猜测的登录命令。
- 设置保存成功会更新设置缓存并使同一客户端的 platform-client-config 缓存失效；不把它等同于已验证的跨浏览器即时广播。

实现依据：[apps/web/src/platformClientConfig.ts:10](../../../apps/web/src/platformClientConfig.ts)、[apps/web/src/SystemSettings.tsx:22](../../../apps/web/src/SystemSettings.tsx)。

关联测试：

- [apps/web/tests/platform-client-config.test.mjs:16](../../../apps/web/tests/platform-client-config.test.mjs) — `connection commands use configured public addresses and preserve a distinct browser origin`（passed）。
- [apps/web/tests/platform-client-config.test.mjs:28](../../../apps/web/tests/platform-client-config.test.mjs) — `configuration is read only from the authenticated same-origin API, never from configured external hosts`（passed）。
- [apps/web/tests/platform-client-config.test.mjs:41](../../../apps/web/tests/platform-client-config.test.mjs) — `the CLI guide waits for settings instead of offering potentially incorrect local connection commands`（passed）。

限制：自动测试覆盖命令生成、同源请求和 SSR 初始呈现；本次未验证真实浏览器点击保存后的跳转、重新聚焦及其他标签页更新。

### CLI 安装发布清单与实际可下载状态

候选键：`admin.cli-release-availability`。

- 配置页按 Windows/macOS/Linux × x64/arm64 展示六种发布目标，状态来自服务端清单。
- 公共下载仅允许精确安装脚本、发布清单及清单所列文件；缺失或大小不匹配的安装包不对外宣称可用。
- 服务端清单过滤检查文件存在和大小，不能据此声称服务端已对每次下载执行 SHA-256 校验。

实现依据：[apps/web/src/SystemSettings.tsx:55](../../../apps/web/src/SystemSettings.tsx)、[apps/core-api/src/routes/cli-distribution.ts:12](../../../apps/core-api/src/routes/cli-distribution.ts)。

关联测试：

- [apps/web/tests/admin-workspace.test.mjs:61](../../../apps/web/tests/admin-workspace.test.mjs) — `release status reports all six targets using actual artifacts rather than OS assumptions`（passed）。
- [apps/core-api/tests/cli-distribution.test.mjs:24](../../../apps/core-api/tests/cli-distribution.test.mjs) — `only the precise distribution routes are public`（passed）。
- [apps/core-api/tests/cli-distribution.test.mjs:45](../../../apps/core-api/tests/cli-distribution.test.mjs) — `install pages never advertise missing or incomplete artifacts from a stale manifest`（passed）。
- [apps/core-api/tests/cli-distribution.test.mjs:60](../../../apps/core-api/tests/cli-distribution.test.mjs) — `release symlinks cannot expose files outside the distribution directory`（skipped）。

限制：符号链接逃逸回归因当前 Windows 无法创建测试符号链接而跳过；六种系统的安装器真实安装未在本次运行。
