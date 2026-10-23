# 架构评审 · 施工清单（Agent 可执行版）

- 生成日期：2026-10-23
- 依据：[51-enterprise-architecture-review-2026-10.md](51-enterprise-architecture-review-2026-10.md)
- 用途：逐表喂给编码 Agent 施工；每行都有可验证的完成标准
- 状态语义：`✅ 已完成` = 已具备、**施工时不得回退**；`🟡 部分完成` = 已做一半，见"缺口"；`⬜ 待施工` = 未开始；`⛔ 待决策` = 需人拍板后再动

---

## 0. 怎么喂给 Agent

**一次只喂一个批次**，并且带上第 1 节的基线数字和第 6 节的全局门禁。推荐提示词模板：

```text
你是本仓库的施工 Agent。任务范围：只做批次 A（A-01 ~ A-06），不要顺手改其它模块。

约束：
1. 第 2 节 S-01 ~ S-10 是已完成能力，任何改动不得使它们回退；
2. 每完成一项，按该项「验收标准」执行验证并贴出输出；
3. 每项单独提交，提交信息遵循仓库既有 conventional commit 规范；
4. 遇到需要产品/架构决策的，停下来提问，不要自行选择。

输入：docs/52-remediation-backlog.md 的批次 A 表格。
```

**禁止事项**（写进每次提示词）：
- 不得为了让测试变绿而修改测试断言或删除用例；
- 不得绕过 `packages/application` 直接在路由层写 SQL（`devices.ts`、`tasks.ts` 的既有直连属于待偿还债务，新增一律禁止）；
- 不得把 `docs/` 加入 `.gitignore` 的任何新条目；
- 不得引入新的全局 advisory lock 键；
- 不得把密钥、口令、令牌写进日志、提示词或测试快照。

---

## 1. 基线数字（施工前后都应对得上）

| 指标 | 当前实测值 | 采集方式 |
|---|---|---|
| TS/TSX 源文件 / 行数 | 241 个 / 41,412 行 | `apps` + `packages`，排除 `dist`、`node_modules` |
| workspace 数量 | 9（4 apps + 5 packages） | `pnpm-workspace.yaml` |
| 数据库表 | 73 张 | `schema.ts` 中 `pgTable(` 计数 |
| 迁移脚本 | 43 个（DROP 24 处、ADD COLUMN NOT NULL 19 处、UPDATE 回填 31 处、CONCURRENTLY 0 处） | `packages/persistence/drizzle/*.sql` |
| 外键 / RLS | 0 / 0 | `references(` = 0，`ROW LEVEL SECURITY` = 0 |
| 时间列类型 | `text` 99 个（98 个 `*_at` + `audit_events.timestamp`），`timestamp`/`timestamptz` **0 个** | `schema.ts` |
| HTTP 路由 | 203 处注册（含 `/health` 等内联） | `app.get`/`post`/`put`/`patch`/`delete` 计数 |
| 声明了 JSON Schema 的路由 | 6 处，分布于 3 个文件 | `schema: {` 计数 |
| 路由级 `bodyLimit` | 8 处；全局默认 8 MiB | `server.ts:70` + 路由选项 |
| CLI 子命令 | 114 个 | `apps/cli/src/index.ts` |
| 测试文件 / 用例 | 137 个 / 925 个（924 通过） | `pnpm -r --workspace-concurrency=1 test` |
| 一次任务看板加载 | 126 次 DB 往返、1.74 MB、192–323 ms（40 项目 / 5000 任务） | PG `log_statement=all` 计数 |
| 全局 advisory lock | 14 处，共用键 `1094930512` | `packages/application/src` 下 6 个文件 |
| Lint | 70 warnings（门禁 80）→ 52 个非空断言、18 个 hooks 依赖 | `pnpm lint` |
| 版本控制 | 4 个提交、117 个未提交改动、`docs/` 未入库 | `git log` / `git status` |

---

## 2. 已完成能力表（施工时的"守恒项"，不得回退）

| 编号 | 已具备能力 | 证据位置 | 施工约束（Agent 必须遵守） | 状态 |
|---|---|---|---|---|
| S-01 | 控制面/执行面双平面边界清晰：云端只存共享事实，本地执行面主动出站 | `docs/00` 系统边界；`apps/agentd/src/index.ts` | 新增功能不得让云端反向直连开发者机器，不得把执行面状态写入项目正式事实 | ✅ |
| S-02 | 乐观并发：`base_snapshot` 条件更新，冲突返回 409 并提示刷新 | `task-service.ts:355-372`、`:481-513` | 任何状态变更仍必须带 `base_snapshot` 与条件 `WHERE`，不得改成"读-改-写" | ✅ |
| S-03 | 设备令牌只存 SHA-256、90 天过期、改密吊销其他设备并写审计 | `auth-device.ts:55`、`auth-use-cases.ts:76-78` | 不得改为明文存储或无限期令牌；新增凭据一律哈希落库 | ✅ |
| S-04 | 请求体不得覆盖身份：`principalOf` 忽略 body 中的 `user_code` | `apps/core-api/src/auth.ts:97-105` | 新路由一律从 `request.principal` 取身份，不读 body 身份字段 | ✅ |
| S-05 | 系统 Agent 强隔离：环境白名单、`shell:false`、禁工具 guard、字节上限、超时、SIGTERM→SIGKILL | `system-agent-runtime.ts:66-113`、`:205-207`、`:322-338` | 任何改动不得放宽工具白名单、不得把密钥写进 prompt/日志/错误信息 | ✅ |
| S-06 | 错误按稳定 code 翻译，不渲染服务端文案 | `apps/web/src/apiError.ts` | 新增错误码必须同时补 code→文案映射，禁止直接展示 `message` | ✅ |
| S-07 | 审计形状强制校验，忘写审计会报错 | `packages/domain/src/audit.ts`、`assertAuditedChange` | 新增写操作必须走 `assertAuditedChange` + `insertAudit` | ✅ |
| S-08 | 用户内容不进入可执行上下文：0 处 `dangerouslySetInnerHTML`，Markdown 未启用 `rehype-raw`，HTML 原型 iframe 无 `allow-same-origin` | `apps/web/src/api.ts`、`DesignWorkbench.tsx:355` | 不得引入 raw HTML 渲染；新增 iframe 默认 `sandbox="allow-scripts"` | ✅ |
| S-09 | 上传内容含密钥检测（私钥等），并有用例覆盖 | `apps/cli/tests/intake-cli.test.mjs:38`、`packages/application/tests/intake.test.mjs:282` | 新增导入通道必须复用同一检测器 | ✅ |
| S-10 | 架构决策有 ADR 记录与取代机制；提交信息有校验钩子 | `docs/adr/*`、`.githooks`、`scripts/check-commit-message.mjs` | 新增决策必须写 ADR；不得绕过 commit 钩子 | ✅ |

---

## 3. 批次 A：P0 止血（目标 1–2 周）

| 编号 | 现状与证据 | 目标与施工要点 | 验收标准（DoD） | 状态 | 工作量 |
|---|---|---|---|---|---|
| **A-01** | `listTasks` 先全表取项目、再逐项目鉴权、再全量取任务，无 `limit`：`task-service.ts:251-264`。实测 40 项目/5000 任务 = **126 次往返、1.74 MB、192–323 ms**。同类：`devices.ts:31-34` 对每台设备单查会话；`tasks.ts:97-130` graph 端点二次全量查询 | ① 新增"可见项目集合"单查询（`projects` join `members` join `team_members`，一次取全）；② `listTasks` 改为 `limit/offset` + 稳定排序（`created_at desc, id desc`）+ 独立 `count(*)`；③ 响应加 `page`/`total`/`has_more`；④ 前端看板按 `project_code` 查询，不再做"全部项目"扫描；⑤ 修 `devices` 的逐台查询为一次 `inArray` 聚合 | 造 40 项目/5000 任务：`GET /tasks?limit=50` 的 DB 往返 ≤ 8；响应 ≤ 200 KB；`EXPLAIN` 中 `tasks` 走索引；`GET /devices` 往返数与设备数无关；新增分页用例覆盖"越界页/非法 limit" | ✅ 已完成（证据见 53） | 3–4 人日 |
| **A-02** | 14 处共用同一 advisory lock 键 `1094930512`：`baseline-use-cases.ts:174,205`、`handover-use-cases.ts:265,302,474,487,517`、`ownership-use-cases.ts:252`、`project-document-folders.ts:29,34`、`project-home-use-cases.ts:91`、`project-use-cases-project.ts:378`、`project-use-cases.ts:453`、`task-baseline-use-cases.ts:16` | ① 抽 `lockScope(kind, id)` 生成派生键：把 kind 与 id 拼成字符串后取 `hashtext`，作为 `pg_advisory_xact_lock` 的参数；② 按聚合粒度分片（project / document / baseline / handover）；③ 真正需要全局唯一的场景改用唯一约束而非锁；④ 保留 `try_` 变体用于快速失败路径 | 并发 100 个写请求（不同项目）不出现锁等待链；同一项目并发写仍正确串行；`pg_locks` 中不再出现单一常量键；补并发用例（同项目冲突必须 409，不同项目必须都成功） | ✅ 已完成（证据见 53） | 2–3 人日 |
| **A-03** | 12 次错误口令 1.1 s 全返回 401、无限流；存在账号 64–109 ms vs 不存在 3 ms；无失败审计 | ① `@fastify/rate-limit`：登录/设备授权按 IP+账号双维度（如 5 次/分钟、20 次/小时）；② 未知账号走等时哑哈希（固定时间消耗）；③ 口令长度上限 128、超限拒绝；④ 失败计数落库并写审计事件 `user.login_failed`；⑤ 连续失败 N 次锁定 T（可配置）并返回 429 | 12 次错误口令中第 6 次起返回 429 且带 `Retry-After`；未知账号与存在账号响应时延差 < 20 ms（各测 20 次取中位数）；失败登录在审计表可查；`Retry-After` 用例入库 | ✅ 已完成（证据见 53） | 2 人日 |
| **A-04** | `index.ts:1-15` 无 SIGTERM/SIGINT；`/health`（`server.ts:159-170`）不查 DB、无 `/ready`；启动失败直接抛栈退出 | ① `SIGTERM`/`SIGINT` → `app.close()`（已有 `onClose` 会关池与停 worker）；② 新增 `/ready`：`select 1` + 迁移版本检查，失败返回 503；③ 启动失败输出一行可读原因（缺库/连不上/迁移失败）并 `exit(1)`；④ `/health` 保留为 liveness，不含依赖 | `kill -TERM` 后在途请求正常完成、进程 0 退出；库停掉后 `/ready` 返回 503 而 `/health` 仍 200；启动时库不存在只输出一行原因 | ✅ 已完成（证据见 53） | 1–2 人日 |
| **A-05** | 无 Dockerfile/compose/Helm/Terraform；迁移在启动时自动执行（`db.ts:38-42`，`server.ts:65-68`） | ① 多阶段 Dockerfile（Node 22 + pnpm，非 root 用户，`NODE_ENV=production`）；② 迁移抽成独立命令 `tsp db:migrate`（复用同一 `migrationsFolder` 解析逻辑）；③ compose 示例含 postgres + api + web；④ `openDb` 增加 `migrate:false` 开关由部署配置控制（已有参数，接线即可） | 全新机器 `docker compose up` 后 `/ready` 200；删除数据库卷再起，迁移 job 成功且 api 不自动迁移；镜像大小 < 400 MB；镜像内不含 `.git`/`docs`/`tests` | ✅ 已完成（证据见 53） | 2–3 人日 |
| **A-06** | 无备份/恢复/灾备文档（`docs/` 中"灾备"0 命中）；43 个迁移含 24 处 DROP，Drizzle 无 down migration | ① 部署前 `pg_dump` 强制备份 + 保留 N 份；② 写 `docs/ops/runbook.md`：备份、恢复、迁移失败处置、回滚到上一镜像；③ 至少做一次恢复演练并记录耗时（RTO/RPO 目标写在文档里） | runbook 存在且按步骤能在空库恢复出完整数据；恢复演练记录含实际耗时；迁移失败场景有明确"停止并回滚镜像"的判定条件 | ✅ 已完成（证据见 53） | 1–2 人日 |

---

## 4. 批次 B：安全加固（目标 2–3 周，可与 C/D 并行）

| 编号 | 现状与证据 | 目标与施工要点 | 验收标准（DoD） | 状态 | 工作量 |
|---|---|---|---|---|---|
| **B-01** | 实测响应头仅 `Date/Connection/Keep-Alive/Content-Type/Content-Length`：无 CSP、无 `X-Content-Type-Options`、无 `X-Frame-Options`、无 HSTS | 接 `@fastify/helmet`；CSP 先以 `report-only` 上线收集，再转强制；`frame-ancestors 'none'`；HTTPS 环境加 HSTS | `curl -I` 可见 CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`；CSP 报告期无新增违规；Web 主流程无控制台 CSP 报错 | ⬜ | 1 人日 |
| **B-02** | 设备令牌存 `localStorage`：`api.ts:1208,1212,2752`。缓解面已存在（S-08：无 innerHTML、Markdown 不解析 raw HTML） | ① 登录改为 `Set-Cookie: HttpOnly; Secure; SameSite=Lax` + 双提交 CSRF token；② 保留 `Authorization: Bearer` 给 CLI（CLI 不走 Cookie）；③ Web 端删除 localStorage 令牌读写，仅保留用户展示信息 | XSS 注入点无法读取令牌（人工验证 `document.cookie` 不含令牌）；Web 登录/刷新/登出全流程正常；CSRF 缺失时跨站 POST 被拒；CLI 鉴权不受影响 | 🟡 令牌仍在 localStorage，但 XSS 面已收敛 | 3 人日 |
| **B-03** | draw.io 编辑器 iframe 同时具备 `allow-scripts allow-same-origin`：`DrawioEditor.tsx:92-94` | ① 将 draw.io 载体放到独立子域（不同 origin），或② 保留同源但移除 `allow-same-origin` 并验证嵌入协议仍工作；③ `postMessage` 增加 `event.origin` 白名单与消息结构校验 | iframe 内脚本无法访问父页面 `localStorage`/`cookie`；编辑-保存-预览全链路正常；非法 origin 的消息被丢弃且有用例 | ⬜ | 2 人日 |
| **B-04** | 失败登录无审计、无锁定、无告警出口（见 A-03） | 在 A-03 基础上：审计表新增 `user.login_failed`/`user.locked`；指标 `login_failures_total`；支持按账号/IP 聚合查询 | 连续失败后审计表有对应记录；`/metrics` 可见计数；锁定与解锁都有审计 | ⬜ | 1 人日 |
| **B-05** | 全局 `bodyLimit: 8 * 1024 * 1024`（`server.ts:70`）对登录同样生效：实测 7 MB 口令被接受 | 全局降到 1 MiB；认证类路由 16 KiB；文档/架构图/原型按现有 8/24/30 MiB 显式声明（已有 8 处，补齐其余） | 登录 20 KiB 返回 413；文档上传仍可到 24 MiB；413 响应保持 `{ok:false,error:{code,message}}` 结构（见 E-04） | 🟡 已有 8 处路由级 bodyLimit | 1 人日 |

---

## 5. 批次 C：数据完整性（目标 3–4 周）

| 编号 | 现状与证据 | 目标与施工要点 | 验收标准（DoD） | 状态 | 工作量 |
|---|---|---|---|---|---|
| **C-01** | 零外键（`schema.ts:18` 明确"软引用"策略）；实测插入 5000 条 `feature_id` 不存在的任务全部成功 | ① 走 ADR 变更：把"软引用"限定在跨聚合弱关系，核心聚合补 FK；② 分批：`tasks.feature_id`、`members.project_id`、`features.project_id`、`runs.task_id`、`device_sessions.device_id`；③ 先 `NOT VALID` 加约束 → 修数据 → `VALIDATE CONSTRAINT`；④ 每个 FK 配 `ON DELETE RESTRICT`（不用 CASCADE） | 上述 5 个 FK 在 `information_schema` 可见且 `convalidated=true`；插入孤儿行返回 23503；删除被引用行被拒；迁移可在存量数据上幂等重跑 | 🟡 策略性选择，需 ADR 变更 | 5 人日 |
| **C-02** | 无任何数据一致性巡检 | 新增 `tsp db:check-orphans`：对无 FK 的关系逐条 `left join` 计数；输出 JSON；可接 cron 并经 webhook 告警 | 命令能在 10 秒内跑完并输出各类孤儿计数；人为制造孤儿后能被检出；CI 中以"孤児数=0"为门禁 | ⬜ | 2 人日 |
| **C-03** | 99 个时间列全为 `text`，`timestamp` 类型 0 个；无法用 `now()` 默认值、无法时区换算、无法区间索引 | ① 新表一律 `timestamptz`；② 存量按"加新列 → 回填 → 双写 → 切读 → 删旧列"分迁移推进，先做 `audit_events`、`tasks`、`projects` 三张核心表；③ 建 `ck_*_iso8601` 校验现存字符串格式作为过渡防线 | 三张核心表的 `*_at` 均为 `timestamptz`；`WHERE created_at > now() - interval '7 days'` 可用且走索引；旧列删除前有双写期验证记录 | 🟡 0 处类型化时间，需从零推进 | 5–8 人日 |
| **C-04** | 零 RLS，多租户隔离完全依赖应用层 `assertProjectAccess`（86 处调用） | 决策项：是否引入 RLS。若引入：按 `team_id` 建 policy + 连接级 `SET LOCAL app.principal_id`；若不引入：C-02 巡检必须覆盖越权读路径 | 需先回答：是否有"同一数据库多客户"的部署诉求。**未决策前不要动** | ⛔ | 需决策 |

---

## 6. 批次 D：可运维性（目标 2–3 周）

| 编号 | 现状与证据 | 目标与施工要点 | 验收标准（DoD） | 状态 | 工作量 |
|---|---|---|---|---|---|
| **D-01** | 有 pino 结构化日志与 61 处审计写入；无 metrics、无 tracing、无慢查询日志、无业务指标 | ① `prom-client` 暴露 `/metrics`（HTTP 时延直方图、DB 连接池、任务状态计数、Agent 作业成功率）；② OTel HTTP 自动埋点（可选）；③ 慢查询：池级别 `statement_timeout` + 应用侧 >500 ms 打点 | `/metrics` 返回 Prometheus 文本；压测时能看到 QPS/时延/池占用；一次慢请求能在日志中定位到具体 route | 🟡 有日志与审计，无指标 | 2–3 人日 |
| **D-02** | 审计事件只落库，无对外出口；安全团队接不进 SIEM | ① `tsp audit:export --since` 输出 NDJSON；② 可选 webhook 推送（失败重试 + 死信表）；③ 字段级脱敏（口令、令牌、密钥永不入库） | 导出命令能按时间窗输出完整事件；人为触发敏感操作后能在导出中出现；脱敏断言有用例 | ⬜ | 2 人日 |
| **D-03** | `system-agent-runtime.ts:195` `mkdtemp` 后从不删除，每次生成遗留 home/workspace/tmp | ① `try/finally` 中 `rm(runDir, {recursive:true, force:true})`；② 保留最近 N 次失败现场（可配置），其余清理；③ 启动时清理超过 24 h 的历史目录 | 成功/失败/取消/超时四条路径后 `draft-*` 目录都被清理；启动清理逻辑有单测；磁盘占用不随使用时长增长 | ⬜ | 0.5 人日 |
| **D-04** | 初始管理员口令 15 分钟过期，过期后只能重启重新生成，无文档化恢复路径 | ① TTL 改为环境变量 `TSP_BOOTSTRAP_TTL_MINUTES`（默认 30）；② 提供 `tsp admin:reset-password --account` 受控命令（需服务器本机执行 + 写审计）；③ runbook 写明步骤 | 过期后可用命令重置且不重启服务；重置写审计；TTL 可配置并有用例 | ⬜ | 1–2 人日 |
| **D-05** | 43 个迁移含 24 处 DROP、19 处 ADD COLUMN NOT NULL，全部在启动时执行，无 down 迁移 | ① 立规范：破坏性变更必须 expand/contract 两步；② 迁移 CI 检查：禁止单迁移内同时 ADD NOT NULL 与 DROP；③ 大表 DDL 用 `CONCURRENTLY`（需 `migrate:false` + 手动执行） | CI 能对违反规范的迁移报错；新迁移全部通过检查；文档写明"哪些 DDL 必须手动执行" | ⬜ | 2 人日 |

---

## 7. 批次 E：工程治理（目标 1–2 月）

| 编号 | 现状与证据 | 目标与施工要点 | 验收标准（DoD） | 状态 | 工作量 |
|---|---|---|---|---|---|
| **E-01** | `docs/00`（Confirmed，自称权威入口）描述 ACP/MCP/Context Graph 协作控制面；代码中 ACP 0 实现、MCP 0 实现（仅 1 行注释）、SSE 0 实现、`graph-traversal.ts` 无引用、`agentd` 实际 `spawn('codex exec -')` | ① 按实际系统重写基线：C4 Context/Container + 关键时序（登录、任务闭环、文档修订、系统 Agent 作业）；② 旧版归档为 `docs/archive/00-architecture-baseline-v0.4.md`；③ 明确"已实现/未实现/已废弃"三态清单 | 新基线中每条能力可对应到代码位置或标"未实现"；评审人按新基线能在 30 分钟内建立系统心智模型；旧版可查且标注 superseded | ⬜ | 3 人日 |
| **E-02** | `.gitignore:19` 排除 `/docs/`；`git ls-files docs` = 0；docs/ 下 67 个 Markdown（含 10 份 ADR 与索引）不在版本控制 | ① 移除 `/docs/` 忽略项并全量入库；② 文档改动走 PR 评审；③ ADR 增加 `superseded_by` 字段；④ 建立 4 个提交 + 117 个未提交改动的收敛策略（先提交现状形成基线再谈历史） | `git ls-files docs` 返回全部文档；PR 中改文档能看到 diff；ADR 索引表状态与实际一致 | ✅ 已完成（证据见 53） | 1 人日 + 收敛流程 |
| **E-03** | 全局 203 处路由注册，仅 6 处 JSON Schema（3 个文件）；swagger 已注册但无 `/docs`、`/openapi.json` 路由 | ① 统一用 TypeBox 或 `fastify-zod` 声明 params/body/querystring；② 暴露 `/openapi.json`（生产可选关闭）；③ 生成 SDK 或至少生成前端类型；④ 迁移顺序：先认证与任务域，再文档域 | `/openapi.json` 可访问且 schema 覆盖率 ≥ 90%（按路由数）；关闭校验时会话拒绝策略；前端 `api.ts` 类型与 schema 单一来源 | 🟡 swagger 已注册，6 处 schema | 5–8 人日 |
| **E-04** | `error-status.ts` 250 行手写映射 240+ 码，未知码回落 400；413 返回 Fastify 默认结构破坏 envelope | ① 错误码改为枚举/常量对象 + 目录（code、http、面向用户文案 key、是否可重试）；② 状态码由枚举派生，未登记码在测试期直接抛错；③ 统一 413/404/500 的 envelope；④ 增加"错误码清单"快照测试，新增码必须登记 | 新增未登记错误码时 CI 失败；所有错误响应结构一致；错误码清单可导出为文档 | 🟡 有映射表，方向正确但手写 | 3 人日 |
| **E-05** | 领域层 508 行、应用层 11,602 行；`task-service.ts` 1149 行、`project-use-cases.ts` 794、`project-use-cases-project.ts` 767、`api.ts` 2826、`cli/index.ts` 2579 | ① 按聚合拆 `task-service`（claim/submit/verify/close 各一文件）；② `api.ts` 按域拆（task/project/doc/testing/skill）并保留 barrel；③ CLI 命令按域拆到 `commands/`；④ 路由层禁止直连 DB（`devices.ts`、`tasks.ts`、`cli-distribution.ts` 逐步收回应用层） | 单文件 ≤ 400 行；路由层无 `db.select/insert/update`；拆分后测试全绿且无行为变化（纯重构提交可单独 review） | ⬜ | 8–10 人日 |
| **E-06** | 全部路由挂根路径，无 `/v1`，无版本协商与弃用机制 | ① 新增 `/v1` 前缀并用 rewrite 兼容旧路径（过渡期双挂载）；② 弃用响应头 `Deprecation`/`Sunset`；③ 文档写明版本策略 | 新旧路径同时可用且行为一致；新版路由全部在 `/v1` 下；弃用流程有文档 | ⬜ | 3 人日 |
| **E-07** | CI 仅 lint/build/typecheck/test，无 `pnpm audit`、SBOM、许可证扫描、镜像扫描 | ① CI 加 `pnpm audit --audit-level=high`；② `pnpm licenses list` 产出清单并归档；③ CycloneDX SBOM；④ 依赖更新机器人 | CI 中可见 audit 结果；SBOM 产物可下载；高危依赖会导致流水线失败 | 🟡 CI 已含真库测试与提交信息校验 | 1–2 人日 |
| **E-08** | 41 个 Web 测试文件里 46 处 `readFile` 断言源码文本；无覆盖率门槛；1 个用例因未过滤 Node 告警而 flaky（`system-agent-runtime.test.mjs:90`） | ① 源码文本断言改为 SSR 行为断言（已具备 `renderToStaticMarkup` + vite `ssrLoadModule` 基建）；② 引入 `c8`，门槛起步 60% 且只升不降；③ 子进程断言过滤 `Warning:`/代理告警行 | 源码文本断言清零；覆盖率报告入 CI 且有阈值；连续 10 次运行无 flaky | ⬜ | 5 人日 |
| **E-09** | 70 warnings / 门禁 80，其中 52 个非空断言、18 个 `exhaustive-deps`（后者是真实过期闭包风险） | ① 先把 `exhaustive-deps` 修到 0（18 处逐个确认）；② 门禁降到 60 → 50，每批下调；③ 新代码 `max-warnings=0`（按目录 override） | `exhaustive-deps` = 0；门禁值随批次下降且有记录；新增文件零告警 | 🟡 已有门禁但贴线 | 3 人日 |
| **E-10** | 4 个提交（含一次 4 万行"initial public release"）、117 个未提交改动、无 tag/发布记录；已有 commit message 校验钩子 | ① 收敛工作区为可评审的若干个提交；② 打首个语义化版本 tag 并写 release note；③ 每批施工一个 PR | 工作区干净；`git tag` 有版本；每个批次有对应 PR 与 release note | 🟡 有提交信息校验，无历史与发布流程 | 2 人日 |

---

## 8. 批次 F：清理与优化（随时可做）

| 编号 | 现状与证据 | 目标与施工要点 | 验收标准（DoD） | 状态 | 工作量 |
|---|---|---|---|---|---|
| **F-01** | `graph-traversal.ts` 实现递归 CTE 遍历并有 8 个用例，但**无任何生产引用**；`context_nodes/context_edges` 有表无 API | 二选一：① 接入为 Task 子图投影 API（需产品决策）；② 连同表与测试一起移除 | 决策记录在 ADR；无论哪种，`grep graph-traversal` 结果与决策一致，无"实现但不接线"的代码 | ⬜ | 1 人日 + 决策 |
| **F-02** | 仓库根目录 39 个 `.log` 文件；`tmp/` 长期存在 | 统一到 `tmp/logs/`，加清理脚本与文档；`.gitignore` 已有 `*.log` 不需改 | 根目录无游离日志；清理脚本可重复执行 | ⬜ | 0.5 人日 |
| **F-03** | CLI 凭据明文 `~/.agentctl/auth.json`（`auth-store.ts:53`，`mode: 0o600`；Windows 上 mode 不生效） | Windows 用 DPAPI，macOS 用 Keychain，Linux 用 libsecret；不可用时降级并提示风险 | Windows 下文件内容不可被其他用户读取（验证 `icacls`）；读取路径与降级提示有用例 | ⬜ | 2 人日 |
| **F-04** | 无 `.nvmrc`；`engines.node >= 22`；`packageManager` 已锁 pnpm 10.33.0 | 加 `.nvmrc`（22）与 `.tool-versions`；README 写明版本要求 | 新机器按文档一步装好；CI 与本地版本一致 | ⬜ | 0.2 人日 |

---

## 9. 全局门禁（每批施工都必须全绿）

```powershell
pnpm lint                        # 0 errors；warnings 不得超过当批下调后的门禁
pnpm -r typecheck                # 9 个 workspace 全绿
pnpm -r build                    # 全绿
$env:TSP_TEST_DATABASE_URL='postgres://.../team_synergy_test'
pnpm -r --workspace-concurrency=1 test    # 用例数不得减少
```

附加门禁（随批次逐步启用）：

| 门禁 | 启用批次 | 阈值 |
|---|---|---|
| 单文件行数 | E-05 起 | ≤ 400 行（存量不追溯，新增不得超） |
| 路由层禁止直连 DB | E-05 起 | 新增文件 0 处 `db.select/insert/update` |
| 未登记错误码 | E-04 起 | 0 |
| 孤儿数据 | C-02 起 | 0 |
| 覆盖率 | E-08 起 | ≥ 60%（只升不降） |
| 高危依赖 | E-07 起 | 0 |

---

## 10. 建议施工顺序与依赖

```text
批次 A（A-01 分页/鉴权 → A-02 锁分片 → A-03 登录限流 → A-04 readiness/停机 → A-05 容器/迁移 → A-06 runbook）
   ↓ 无强依赖，可并行
批次 D（D-03 临时目录 0.5 人日，先做；D-01 指标；D-05 迁移规范；D-02 审计出口；D-04 口令恢复）
   ↓
批次 B（B-05 请求体分层 → B-01 安全头 → B-04 失败审计 → B-02 令牌 Cookie → B-03 iframe 隔离）
   ↓
批次 C（C-02 巡检 → C-01 外键 → C-03 时间类型 → C-04 RLS 待决策）
   ↓
批次 E（E-02 文档入库 → E-01 基线重写 → E-10 版本收敛 → E-04 错误码 → E-03 OpenAPI → E-05 拆分 → E-06 版本化 → E-08 测试 → E-07 供应链 → E-09 lint）
   ↓
批次 F（随时）
```

**先做 E-02（文档入库）再动代码**：否则每批施工都无法在 PR 里留下设计依据，等于重复当前的治理问题。

---

## 11. 上轮 31 条问题与本清单的对照

| 上轮序号 | 本轮编号 | 上轮序号 | 本轮编号 |
|---|---|---|---|
| 1 看板 126 趟 | A-01 | 17 没有体检 | A-04 |
| 2 无翻页 | A-01 | 18 拔插头 | A-04 |
| 3 权限一个个问 | A-01 | 19 会议不退房 | D-03 |
| 4 一支笔 | A-02 | 20 说明书错 | E-01 |
| 5 试密码不限次 | A-03 | 21 图纸没入档 | E-02 |
| 6 猜账号 | A-03 | 22 一年记一句 | E-10 |
| 7 8MB 密码 | B-05 | 23 接口说明空白 | E-03 |
| 8 没防弹衣 | B-01 | 24 报错手抄表 | E-04 |
| 9 钥匙鞋柜 | B-02 | 25 规则散落 | E-05 |
| 10 高权限窗口 | B-03 | 26 没仪表盘 | D-01 |
| 11 没有外键 | C-01 | 27 没版本号 | E-06 |
| 12 时间便利贴 | C-03 | 28 抄课文测试 | E-08 |
| 13 数据库不做权限 | C-04 | 29 机器没插电 | F-01 |
| 14 没安装包 | A-05 | 30 红线定现状 | E-09 |
| 15 开业前砸墙 | A-05 / D-05 | 31 零件不查来源 | E-07 |
| 16 没备份 | A-06 | — 失败登录无审计 | B-04 |

---

## 12. 进度看板（施工时逐项勾选）

| 批次 | 项数 | ⬜ 待施工 | 🟡 部分 | ⛔ 待决策 | 完成判据 |
|---|---|---|---|---|---|
| A 止血 | 6 | 0 | 0 | 0 | ✅ 6/6 已验收，证据见 53-remediation-execution.md |
| B 安全 | 5 | 3 | 2 | 0 | 安全头齐全；令牌不在 localStorage；iframe 隔离 |
| C 数据 | 4 | 1 | 2 | 1 | 5 个核心 FK；巡检为 0；核心表 timestamptz；C-04 需先决策 |
| D 运维 | 5 | 4 | 1 | 0 | `/metrics` 可抓；临时目录不增长；runbook 可执行 |
| E 治理 | 10 | 4 | 5 | 0 | ✅ E-02 文档入库；OpenAPI ≥ 90%；单文件 ≤ 400 行 |
| F 清理 | 4 | 4 | 0 | 0 | 无死代码；根目录干净 |
| **合计** | **34** | **16** | **10** | **1** | 已完成 7 项（A-01～A-06、E-02） |
