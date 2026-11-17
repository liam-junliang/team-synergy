# 项目评审：缺漏审计与修复计划（2026-08-25）

> 本轮评审覆盖 main 分支全部未提交变更（约 120 个修改文件 + 60 个新文件）。
> 验证基线：`pnpm -r --workspace-concurrency=1 typecheck` 通过；全仓测试 **272/272 通过**
> （web 60、application 66、agentctl 28、persistence 27、domain 25、core-api 21、
> integrations 12、agentd 7、contracts 6）。功能层面无损坏，问题集中在安全与工程化。

## 一、阻塞问题（合入前必须修复）

### B1 改密不验旧密码、不吊销其他设备

- 位置：`apps/core-api/src/routes/auth.ts:41`、`packages/application/src/auth-use-cases.ts:130-147`
- `/auth/password-change` 只校验 Bearer token，body 只取 `new_password`；
  `changePassword` 只更新 `password_hash/must_change_password/password_expires_at`，
  全程不触碰 `devices` 表。任何持有设备 token 的人可独占账号；改密前被窃的其他
  token 全部存活。
- `loginWithPassword` 每次成功登录新建 device 行（`auth-use-cases.ts:107-114`），
  无上限、无过期，token 无限累积。

### B2 legacy 身份头可冒充任意用户

- 位置：`apps/core-api/src/auth.ts:50-55` + `principalOf`（auth.ts:61-69）
- 无 Authorization 头时，请求头 `x-principal-code: <code>` 直接成为
  `request.principal`（authKind='legacy'），中间件不验证该 code 是否存在或 active；
  projects/tasks/teams/requirements/defects/design-prototypes 等业务路由没有任何
  `authKind` 检查，填入他人 user code 即可完全冒充对方操作。
- 这是 docs/23 记录的开发过渡通道，但没有环境开关，生产默认开启即是身份伪造面。

### B3 admin 初始密码明文进结构化日志

- 位置：`apps/core-api/src/server.ts:58-63`
- `app.log.warn({ account, initial_password, expires_at }, ...)` 把明文初始密码写入
  pino JSON 日志。结构化日志常被采集聚合，等同凭据泄露面。

## 二、工程化缺漏

1. **CI / lint / hooks 全缺**：无 `.github/workflows`；主工程无 eslint/prettier/biome
   配置（唯一命中是 workspace 外的 `prototype-ui/eslint.config.mjs`）；无 pre-commit。
2. **HTTP 错误语义不规范**：无 `setErrorHandler`；所有业务错误（ok:false /
   DomainError）一律返回 HTTP 200，仅认证路径显式 401/403。网关与监控无法按状态码
   发现异常。建议统一 error handler 把 DomainError 映射到 4xx。
3. **请求体无 schema 校验**：路由层用 `String(body.x ?? '')` 强转（如
   `routes/users.ts:22-24`），zod 只用于 enum 校验。contracts 包已有 schema 基础，
   补 body pipeline 成本不高。
4. **默认数据库密码硬编码并已进 git**：`postgres://postgres:postgres@...` 出现在
   `packages/persistence/src/db.ts:8`、多个测试 helper、README/HANDOFF。单机试点可
   接受，但应标注“仅限本机开发”，并让生产路径强制显式 `ACP_DATABASE_URL`
   （去掉代码兜底默认值）。
5. **`.gitignore` 覆盖缺口**：`.tmp/`（含 19MB 运行日志与 db 备份 dump）、
   `alltest.txt` 等 5 个散落 txt、`HANDOFF.md`、`.omx/` 均不在忽略规则内，易误提交。
   根目录 `acp.sqlite*` 是 SQLite 时代遗留（已迁 PostgreSQL），可删。
6. **部署形态空白**：迁移在启动时自动执行（`packages/persistence/src/db.ts:37-42`），
   但没有 Dockerfile/compose 或一键安装脚本；对“局域网共享给小团队”的定位而言，
   这是下一个真实用户的第一道门槛。

## 三、功能缺漏与建议（按优先级）

### P0 —— 补上闭环里的“假门”（工作量小、价值直接）

1. **Verifier 只能记录 pass**：应用层把非 pass 全部拒绝为 `evidence_not_passing`
   （`packages/application/src/project-use-cases.ts:586`、`task-service.ts:775`），
   contracts/persistence 的 `fail/inconclusive` 枚举是死代码。“验证失败”是协作平台
   最核心的真实信号，当前只能口头绕过。
2. **状态机缺 rework/superseded**：任务 11 态邻接表（`task-state-machine.ts:16-28`）
   没有验证失败后回到 Builder 的正式路径；需求侧已有完整状态机
   （`requirement-use-cases.ts:32-33`），任务侧应对齐。
3. **里程碑/交付状态全靠手工**：`updateMilestone` 的 status 只是 cmd 直通
   （`project-structure-use-cases.ts:588`）；Feature 的 `'delivered'` 状态没有任何代码
   路径会写入它——甘特图交付统计永远是 0。任务→closed 的审计事实已齐全，做一个
   “任务 closed → Feature delivered 判定 → 里程碑进度派生”的投影即可，符合架构
   不变量 8（状态从事实派生，`derived-status.ts`）。

### P1 —— 路线图欠账（docs/07 顺序）

4. **Spike 2 只完成约 30%**：agentd 目前是进程级 session 管理
   （start/resume/stop + 尾部 50 行输出快照），无 ACP 协议帧、无流式事件、无权限
   请求；默认命令硬编码 `codex --dangerously-bypass-approvals-and-sandbox`
   （`supervisor.ts:163-178`）。至少先补 Claude Code / OpenCode 的 CLI Adapter 兜底。
5. **Spike 3（薄 MCP）零动工**：`task_get_current` / `feature_get_context` 无任何实现
   （全仓 grep 仅命中 docs 与 seed 数据）。这是“Agent 准确率测量”欠账的前提。
6. **实时通知缺失**：只有 React Query 10 秒轮询（`queryPolicy.ts:3`），无 SSE/
   WebSocket；多 Agent 并行时互相无感知。
7. **Context Pack 注入 API schema**：pack 已注入需求/设计/交接文档，但未注入精确
   API schema（HANDOFF.md 自认）；swagger 已挂在 server 上（`server.ts:73`），导出
   OpenAPI JSON 注入 pack 是低成本高收益的一步。

### P2 —— 产品完整性

8. **CLI 缺 password-login**：初始密码用户在 CLI 场景被 403 中间件拦截所有业务请求
   且无法自助解封（Web 能改密，CLI 不能）。补 `tsp auth login-password` +
   `auth passwd` 即可。
9. **Cytoscape 依赖图随编排页删除而消失**：Context Graph 可视化是 docs/07 MVP 成功
   标准第 8 条的一部分，删除 OrchestrationWorkbench 后彻底没了。
10. **议题时间线 N+1 查询**（`requirement-collaboration-use-cases.ts:107+`）：列表场景
    每行 3-4 个查询，数据量上来后会慢，可批量预取。
11. **测试库资源锁**：目前靠根命令 `--workspace-concurrency=1` 串行规避，PostgreSQL
    advisory lock 是标准解法，能解锁并行测试提速。

## 四、做得好的地方

- 密码哈希 scrypt+随机盐+timingSafeEqual（`password-auth.ts`）；bind token 单次使用
  有条件 UPDATE 竞争保护。
- 审计事实表（audit_events）与运行日志分离清晰，几乎每个 use-case 都留痕。
- Web markdown 自研解析器产出 React 元素无 XSS 面；原型 HTML 用
  `sandbox="allow-scripts"`（无 allow-same-origin）iframe 隔离。
- 公开 code 两层标识模型贯彻彻底，路由层零数字 ID 泄露。
- 代码注释 TODO/FIXME 零残留，欠账如实记录在 HANDOFF.md。

## 五、修复计划

| 优先级 | 动作 | 状态 |
|---|---|---|
| P0 | B1：password-change 要求 old_password + 吊销其他设备 + 设备数上限 | ✅ 已完成（2026-08-25） |
| P0 | B2：legacy x-principal-code 加环境开关，默认拒绝 | ✅ 已完成（2026-08-25） |
| P0 | B3：admin 初始密码改 stderr 一次性输出，不再进 pino 日志 | ✅ 已完成（2026-08-25） |
| P0 | 同步 Web PasswordChangePage / api.ts 传 old_password；docs/23 更新 | ✅ 已完成（2026-08-25） |
| P1 | 统一 HTTP 错误码映射（DomainError → 4xx） | ✅ 已完成（2026-08-25） |
| P1 | CI workflow + lint 基线 + `.gitignore` 补齐（`.tmp/`、散落 txt） | ✅ 已完成（2026-08-25） |
| P2 | Verifier fail/inconclusive + 任务 rework 状态机 | ✅ 已完成（2026-08-26） |
| P2 | Feature delivered / 里程碑进度派生投影 | ✅ 已完成（2026-08-26） |
| P2 | CLI password-login / passwd 命令 | ✅ 已完成（2026-08-26） |

> 决策记录：本轮先修 B1~B3 及其连带的前端同步与测试；其余项按上表顺序排入后续迭代。

## 五点五、P1 修复记录（2026-08-25）

### 统一 HTTP 错误状态码映射

- 新增 `apps/core-api/src/error-status.ts`：`httpStatusForError(code)` 把约 60 个
  业务错误码映射到语义化状态码——认证类 401、权限/会话类 403、资源不存在 404、
  冲突与并发 409、参数校验 422；未收录错误码回落 400。
- `apps/core-api/src/server.ts` 挂 `preSerialization` hook：仅当响应为 200 且
  payload 是 `ok:false` envelope 时按 `error.code` 提升状态码。envelope 结构不变，
  路由层零改动。
- `apps/web/src/api.ts` `fetchEnvelope` 同步适配：非 200 响应也解析 body 并保留
  `error.code/message` 详情（此前丢弃为 "HTTP xxx"）；401 时仍清会话并广播
  `acp:auth-expired`。CLI `api-client` 按 body envelope 解析，天然兼容，无需改动。
- 测试同步：core-api 5 处断言更新为新状态码（缺 current_password→400、旧密码错→401、
  feature_forbidden / claim_assignee_mismatch→403、claim_not_assigned→409）。

### CI + lint + gitignore

- 新增 `.github/workflows/ci.yml`：push(main)/PR 触发；Node 22 matrix；
  postgres:16 service 容器（healthcheck + `ACP_TEST_DATABASE_URL` 指向 service）；
  步骤为 lint → build → typecheck → 串行 test。
- 新增根 `eslint.config.js`（typescript-eslint recommended + react-hooks +
  no-console/no-explicit-any/eqeqeq），新增 `pnpm lint` script。基线达成：
  **0 errors / 60 warnings**（warnings 为非阻塞的 non-null assertion 与 hooks
  依赖提示，后续清理）。顺带删除了一批死代码（未使用的 usersByIds/documentsByIds/
  featuresByIds/ProjectRow/RevisionRow/entityKindLabel 等）。
- `.gitignore` 补齐：`.tmp/`、`.omx/`、`.reasonix/tasks/`、`.agent/reports|task-briefs/`、
  散落 txt 与 `HANDOFF.md`；并用 `git rm --cached` 将其移出索引（本地文件保留）。
- `packages/application/tests/test-db.mjs` 补上 `ACP_TEST_DATABASE_URL` 环境变量
  覆盖（此前硬编码本机连接串），CI 才能指向 service 数据库。

### P1 验证基线

- `pnpm lint`：0 errors / 60 warnings。
- `pnpm -r build` / `typecheck` 通过。
- 全量测试 0 失败：web 60、contracts 6、domain 25、integrations 12、persistence 27、
  agentd 7、application 68、core-api 30、agentctl 28。

### P1 二次修复（同日 review 后）

- **CI 测试库指向修正**：`ACP_TEST_DATABASE_URL` 从 service 管理库 `postgres` 改为
  `acp_test`——`ensureTestDatabase()` 以 URL 库名判断是否 CREATE DATABASE，指向管理库
  会导致测试迁移+TRUNCATE 清空系统库。
- **internal_error 显式映射 500**：`fail()` 会把非 DomainError 异常包装成
  `internal_error` envelope，此前回落 400 会把服务端故障伪装成客户端错误、误导监控分流。
- **Web fetchEnvelope 豁免 `/auth/*`**：password-login 失败的 401 是正常业务结果，
  不应清掉会话或广播全局登出。
- **`.reasonix/`、`.omx/` 彻底移出 git 索引**：首次只加了 ignore 规则未执行
  `git rm --cached`；已补齐并验证 `git ls-files` 为 0。同时去重 `.gitignore` 中
  重复的 `HANDOFF.md` 条目。
- **映射表直接单测**：新增 `apps/core-api/tests/error-status.test.mjs`（6 组断言：
  401/403/404/409/422 各类 + internal_error→500 + 未收录校验码回落 400），
  并纳入 core-api test script。
- 映射表补充说明注释：路由层大量 `*_invalid` 校验码不逐一收录，由回落规则统一
  返回 400，避免表与代码漂移。

### 已知遗留

- CLI 编排者机器身份通道（显式 `--as` 仅发 `x-principal-code`）在生产默认被 B2
  开关拒绝，需委托凭据机制或部署侧显式开启开关（见上文二次加固章节）。

## 六、B1~B3 修复记录（2026-08-25）

### B1 密码生命周期

- `packages/application/src/auth-use-cases.ts`：`changePassword` 新增
  `{ currentPassword, currentDeviceToken }` 参数。首次改密（`must_change_password=true`，
  初始密码流程）不要求旧密码；主动改密必须提供正确旧密码，否则返回
  `auth_current_password_required` / `auth_credentials_invalid`。改密在事务内吊销该用户
  除当前设备外的全部设备并写入 `user.password_changed` 审计事件。
- `bindDevice` / `loginWithPassword` 增加每用户设备数上限
  `MAX_DEVICES_PER_USER = 10`，超限返回 `auth_device_limit_reached`。
- `apps/core-api/src/routes/auth.ts`：路由层把 Bearer 设备 token 与请求体中的
  `current_password` 传入 use-case。
- `apps/web/src/api.ts` + `PasswordChangePage.tsx`：改密表单新增“当前密码”必填字段。
- 测试：application 层新增“主动改密验旧密码+设备吊销”“设备数上限”两个用例；
  core-api 层新增“缺旧密码拒绝”“改密保留当前设备/吊销其他设备”两个集成用例，
  首登用例同步 `current_password=初始密码` 与 `revoked_devices` 字段。

### B2 legacy 身份开关

- `apps/core-api/src/auth.ts` 新增 `allowLegacyIdentity()`：显式设置
  `ACP_ALLOW_LEGACY_IDENTITY=1/true` 时强制开启；未设置时仅在非生产环境
  （`NODE_ENV !== 'production' && ACP_ENV !== 'production'`）放行。
- 开关关闭时携带 `x-principal-code` 的请求返回 401 `legacy_identity_disabled`。
- 测试环境默认放行，既有 92 处 legacy 头测试无需改动；新增生产环境拒绝用例。

### B3 初始密码输出

- `apps/core-api/src/server.ts`：`initial_password` 不再进入 pino 结构化日志字段，
  改为 `process.stderr.write` 一次性明文提示块；日志仅保留 account 与 expires_at。

### 验证基线

- `pnpm -r --workspace-concurrency=1 build` / `typecheck` 通过。
- 全量测试 0 失败：web 60、contracts 6、domain 25、integrations 12、persistence 27、
  agentd 7、application 68、core-api 24、agentctl 28（净增 5 个安全回归用例）。

### 二次加固（同日 review 后）

- **审计原子性**：`changePassword` 的审计写入移入改密事务内——审计失败即整体回滚，
  不可能出现“无审计的成功改密”（与 `routes/devices.ts` 做法对齐）。
- **设备上限并发安全**：`bindDevice` / `loginWithPassword` 的上限检查改为事务 +
  `users` 行 `SELECT … FOR UPDATE`，串行化同一用户的并发绑定/登录，上限无法被并发绕过。
- **首改窗口收口**：首次改密同样必须验证 `currentPassword`（填管理员发放的初始密码），
  堵住“持有被窃 bearer token 即可在不知道初始密码的情况下换锁”的窗口；
  Web 端补 `auth_initial_password_expired` 提示。
- 已知遗留（记录为 P1）：CLI 编排者机器身份通道（显式 `--as` 时仅发
  `x-principal-code`）在生产默认被 B2 开关拒绝；需要“设备 token 代表身份”的委托凭据
  机制或部署侧显式开启开关，当前单机/局域网试点形态不受影响。

## 七、P2 修复记录（2026-08-26）

### P2-1 验证失败语义与返工回退路径

- `packages/domain/src/task-state-machine.ts`：邻接表新增 `submitted → failed`
  （`failed → ready` 原已存在），验证失败从此有正式的返工重入路径。
- `packages/application/src/project-use-cases.ts` `verifyTask`：按
  `evidence.result` 分支——`pass` 走原 verified 正向闭环（仍要求验收全覆盖）；
  `fail / inconclusive` 转 `failed`，两种结果都落库 verifier_review Evidence、
  结束 Run 并写审计（`task.verified` / `task.verification_failed`）。
- `assignTask` 支持 `failed → ready → assigned` 重分派：Owner 可把失败任务直接
  指派给 Builder 返工。
- 此前"Verifier 只能记录 pass"的假门（docs/30 P0 清单第 1 条）就此拆除。

### P2-2 交付事实投影

- `closeTask` 事务内新增派生投影（架构不变量 8"状态从事实派生"）：Feature 下不存在
  未完结任务（非 closed/cancelled）且状态为 active 时，自动置为 `delivered` 并写
  `feature.delivered` 审计（payload 含 `derived_from_task`）。甘特图交付统计不再恒为 0。
- `updateMilestone` 新增完成门槛：里程碑标记 `completed` 必须至少关联一个未归档
  Feature 且全部处于 delivered，否则返回 `milestone_completion_blocked`
  （含 feature_total/delivered 计数）。此前 status 只是 cmd 直通。

### P2-3 CLI 密码生命周期命令

- `apps/cli/src/api-client.ts` 新增 `passwordLogin` / `changePassword` 方法。
- CLI auth 命令族新增两个子命令：
  - `tsp auth login-password --api <url> --account <account> --password <pwd>
    [--new-password <pwd>]`：账号密码登录并保存设备凭据；初始密码用户可加
    `--new-password` 一步完成首改；输出 `must_change_password` 状态，
    需要改密时给出 `auth passwd` 提示。
  - `tsp auth passwd --current <pwd> --new <pwd>`：修改当前账号密码，
    返回吊销的其他设备数。CLI 初始密码用户不再被 403 中间件锁死。

### 测试补充

- application：里程碑完成门槛三态断言（全 delivered 放行 / 无 Feature 拒绝 /
  有未交付 Feature 拒绝），68 通过。
- core-api routes：验证失败→failed→Owner 重分派返工全链路集成用例；
  关闭最后一个任务→Feature 自动 delivered 集成用例，32 通过。
- agentctl auth-cli：login-password/passwd 完整生命周期（首登提示、错旧密码拒绝、
  改密成功、旧密码失效、--new-password 一步式），29 通过。
- http-test-helpers 的 `insertUser` 补齐 password 三字段支持。

### P2 验证基线

- `pnpm lint`：0 errors / 60 warnings；build / typecheck 通过。
- 全量测试 **267 个，0 失败**：web 60、application 68、core-api 33、agentctl 29、
  persistence 27、domain 25、integrations 12、agentd 7、contracts 6。

### P2 二次加固（同日 review 后）

- **`deriveView` 补 failed 映射**：`failed` 任务此前落入 `drafting` 兜底，与看板
  "执行中"分组矛盾；现映射为 `ci_failed`。
- **createMilestone 封堵绕过路径**：新建里程碑不允许直接以 `completed` 起步，
  返回 `milestone_completion_blocked`——完成只能来自交付事实。
- **updateMilestone 审计移入事务**：更新与审计同事务提交（与 closeTask/
  changePassword 约定一致），审计缺失即整体回滚。
- **inconclusive 分支测试补齐**：新增集成用例验证 inconclusive → failed、
  Evidence 以 inconclusive 结果落库可追溯。
