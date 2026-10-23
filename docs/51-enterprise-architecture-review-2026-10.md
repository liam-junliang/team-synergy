# 企业级架构评审（严苛视角）

- 评审日期：2026-10-23
- 被评对象：team-synergy（`apps/*` + `packages/*`，约 4.1 万行 TS/TSX）
- 评审方式：静态代码走查 + 文档一致性核对 + 本地真实运行验证（独立 PostgreSQL 16 临时实例、真实 HTTP 探测、SQL 语句级计数）
- 结论口径：以"能否通过一家 200~2000 人规模企业的架构评审 / 安全基线 / 生产上线评审"为标准，而非"个人项目能不能跑"

---

## 一、总体结论

**概念设计 A−，工程实现 B−，生产就绪 D。**

一句话判断：这是一份**设计品味明显高于实现成熟度**的系统。双平面分层、平台自有核心域、乐观并发、审计不变量、Agent 沙箱隔离这些"该想对的地方"都想对了；但**规模化读路径、认证面、数据完整性、交付与运维这几条真正决定生产成败的线，目前都在"演示可用、生产不可用"的水平**。

| 维度 | 评分 | 依据 |
|---|---|---|
| 架构分层与边界 | 3.5 / 5 | 分层存在且方向正确，但路由层越过应用层直连 DB，领域层贫血 |
| 数据建模 | 2.5 / 5 | 73 张表、零外键、时间全部 text，完整性只有应用层单点保证 |
| 安全 | 2.0 / 5 | 令牌哈希、权限矩阵做得好；但无防爆破、无安全头、可枚举用户 |
| 可扩展性 | 1.5 / 5 | 一次看板加载 126 次 DB 往返、1.7 MB 响应；写路径被一把全局锁串行化 |
| 可运维性 | 1.5 / 5 | 无容器、无 IaC、无备份/回滚、无 /ready、无优雅停机、无指标 |
| 可测试性 | 3.5 / 5 | 925 个用例真库跑通，但存在源码文本断言与无覆盖率门槛 |
| 文档与治理 | 2.0 / 5 | ADR 写得很好，但权威基线已过期、`docs/` 被 gitignore、历史被压成 4 个提交 |
| 前端工程 | 2.5 / 5 | 类型完备、无 XSS 注入面，但 85 个文件平铺、自研路由、令牌放 localStorage |

**无法直接上线的原因（任一单独成立即可否决）**：读路径无分页且 N+1 鉴权、写路径全局串行、登录无节流、零外键、无部署制品与回滚路径。这五项属于"演示能跑、生产会死"的差别。

---

## 二、我实际做了什么验证（不是只读文档）

| 验证项 | 结果 |
|---|---|
| `pnpm lint` | 通过，70 warnings（门禁 `--max-warnings=80`） |
| `pnpm -r typecheck` | 9 个 workspace 全部通过 |
| `pnpm -r test`（独立 PG16 临时实例） | **925 个用例，924 通过，1 失败**（失败原因是本机 HTTP 代理注入 Node 实验性告警污染子进程 stderr，非产品缺陷） |
| 真实启动 core-api | 成功；启动即自动迁移；首次启动向 stderr 打印一次性管理员口令 |
| 认证面探测 | 无速率限制（1.1 s 内 12 次错误口令全部 401）、无安全响应头、可按时延枚举用户（3 ms vs 64–109 ms） |
| 8 MB 请求体 | 7 MB 口令被接受并进入 scrypt 计算；9 MB 返回 413 且**破坏统一 envelope** |
| 规模测量 | 造 40 个项目 / 5000 任务后，`GET /tasks` 单次 **126 次 DB 往返、1.74 MB 响应、192–323 ms** |
| 无外键验证 | 直接插入 5000 条 `feature_id` 不存在的任务**全部成功**，数据库不报错 |

验证用的临时数据库与进程已全部清理，未改动你的本地 PostgreSQL 实例。

---

## 三、最刺眼的问题：架构文档与实现已经不是一个系统

`docs/00-architecture-baseline.md`（状态 **Confirmed**，自称"当前项目的架构权威入口"）描述的系统是：**多 Agent 协作控制面** —— Agent Client Protocol 启动编码 Agent、Run 绑定 Worktree、MCP 暴露项目上下文、Context Graph 版本化投影、A2A/AG-UI 作为演进方向。

代码里的系统是：**需求/文档/测试/交接协作平台 + 一个受限的文档草稿 Agent**。

| 基线声称 | 代码事实 | 证据 |
|---|---|---|
| Agent Client Protocol 为首选会话协议 | **零实现**，全仓库无 `agent-client-protocol` 引用；`agentd` 直接 `spawn('codex exec -')` 走 CLI 兜底 | `apps/agentd/src/index.ts:33` |
| MCP 向 Agent 暴露上下文 | **零实现**，唯一出现处是一行注释 | `packages/domain/src/identity-binding.ts:5` |
| 版本化 Project Context Graph | Schema 有 `context_nodes/context_edges`，但**无任何投影/查询 API**；`graph-traversal.ts` 无任何引用方（死代码） | `packages/persistence/src/graph-traversal.ts` |
| SSE 推送状态增量 | **零实现**（无 `text/event-stream`），前端改用 8 处 `refetchInterval` 轮询 | `apps/web/src/*.tsx` |
| 建议 `agentctl` CLI | 实际为 `tsp`，114 个子命令 | `apps/cli/src/index.ts` |

**为什么这是最高优先级问题**：架构评审的第一道门是"文档是否可信"。当权威文档描述的系统与运行的系统不是同一个，后续所有基于文档的容量规划、安全评估、新人上手、审计取证全部失效。而且它仍在标 `Confirmed`，比"没有文档"更有害。

同一份文档里更细的漂移：`/docs/` 整目录被 `.gitignore` 排除（`.gitignore:19`），docs/ 下 67 个 Markdown 文件（含 10 份 ADR 与索引）**不在版本控制内**；`git ls-files docs` 为 0。也就是说，这些"约束实现"的 ADR 无法随代码评审、无法追溯修改、clone 后不存在。

---

## 四、P0：上生产前必须解决

### P0-1 读路径不可扩展：无分页 + 鉴权 N+1（实测 126 次往返）

`listTasks` 把"当前用户可见的全部项目"逐个鉴权，再全量拉取任务：

```ts
// packages/application/src/task-service.ts:251-264
const projects = project ? [project] : await db.select().from(schema.projects);   // 全表
const visibleProjects = (await Promise.all(projects.map(async candidate =>
  await resolveProjectAccess(db, candidate.id, principal.id) ? candidate.id : null,  // 每项目 4 次查询
))).filter(...);
const rows = await db.select().from(schema.tasks).where(...);                    // 无 limit，全量
```

实测（40 项目 / 5000 任务）：**41 次 users 查询 + 41 次 projects 查询 + 40 次 team_members 查询 + 5 次批量查询 = 126 次往返**，响应 1.74 MB，前端一次性解析渲染。项目数线性放大：200 个项目 ≈ 600 次往返/次看板刷新。

同类问题：`/devices` 对每台设备单独查会话（`apps/core-api/src/routes/devices.ts:31-34`）；`/tasks/graph` 二次全量查询。

**影响**：这是硬容量天花板。5 人团队无感，50 人团队开始超时，任何一次"首页刷新风暴"就能打满连接池（默认 max=10）。
**修复**：把鉴权改成一条 `join` 的可见项目集合查询（或物化 `project_members` 视图）；列表强制 `limit/offset` + 稳定排序 + 总数单独统计；看板改为按项目维度查询，不做"全部项目"扫描。

### P0-2 写路径被一把全局数据库锁串行化

14 处使用**同一个** advisory lock 键 `1094930512`：

```ts
// packages/application/src/project-document-folders.ts:29 等 14 处
await tx.execute(sql`select pg_advisory_xact_lock(1094930512::bigint)`);
```

所有文档/需求/基线/交接的写事务共用一把全局锁，**跨团队、跨项目互斥**。一个慢请求（例如 6 MiB 架构图写入）会让全站写操作排队；配合 P0-1 的连接池压力，很容易形成"读等待连接、写持有锁"的经典死锁放大。

**影响**：并发写入吞吐被钉死为 1；长事务即全站写停顿。
**修复**：锁键改为按聚合实例派生（如 `hash(project_id)` 或 `entity_id`）；真正需要全局一致性的少数场景单独用序列或唯一约束；补一个并发压测作为回归门槛。

### P0-3 认证面裸奔：无节流、可枚举、请求体过大

- **无速率限制/锁定**：脚本 12 次错误口令 1.1 s 跑完，全 401，无 `Retry-After`/`RateLimit-*`，无验证码、无账号锁定、无失败审计事件。
- **用户枚举**：存在账号 64–109 ms（跑完 scrypt），不存在账号 3 ms（直接返回）。攻击者可批量判定账号有效性。
- **8 MiB 请求体** 全局生效（`apps/core-api/src/server.ts:70`），登录接口同样接受 7 MB 口令并进入 scrypt —— 单机几十并发即可 CPU 打满。
- 无任何安全响应头（实测仅 `Date/Connection/Keep-Alive/Content-Type/Content-Length`）：无 CSP、无 `X-Content-Type-Options`、无 `X-Frame-Options`、无 HSTS。

**修复**：登录/设备授权端点独立限流（IP + 账号双维度）、失败计数与指数退避、未知账号走等时长的哑哈希、口令长度上限（如 128）、`@fastify/helmet` + CSP、全局限流中间件。这四条属于任何企业安全基线的一票否决项。

### P0-4 数据完整性只有应用层单点保证（零外键 + 全文本时间）

`packages/persistence/src/schema.ts:18` 明确写了这是**有意为之**：

> 软引用策略：跨聚合关系不在库层声明 FK，由 application 用例保证业务完整性。

统计：73 张表，`references()` **0 处**、`foreignKey()` **0 处**、`ROW LEVEL SECURITY` **0 处**；**98 个 `*_at` 列 + `audit_events.timestamp` 全部用 `text` 存储，全库 `timestamp`/`timestamptz` 类型使用数为 0**。

实测代价：直接插入 5000 条 `feature_id` 指向不存在 feature 的任务，数据库**全部接受**。也就是说，任何一次用例层漏检（新增路由、脚本导入、迁移回填、DBA 手工修数）都会静默产生孤儿数据，而且**没有任何工具能事后发现**。

时间用 `text` 的连带问题：无法用 `now()` 默认值、无法表达时区语义、无法做区间索引与日期运算、排序正确性依赖"所有写入方都写同格式 ISO 字符串"这一隐性约定——而这恰恰是没有约束保护的。

**修复（可渐进）**：① 至少对核心聚合（projects/features/tasks/runs/members）补 FK；② 加一个每日执行的孤儿数据巡检任务并告警——在没有 FK 之前，这是最低成本的兜底；③ 新表一律用 `timestamptz`，存量表按"新增列 + 回填 + 切换"迁移；④ 多租户若要做强隔离，补 RLS 而不是继续堆应用层判断。

### P0-5 没有可交付、可回滚的部署形态

- 仓库内**无 Dockerfile、无 compose、无 Helm/K8s、无 Terraform**；唯一部署资产是一份 `apps/web/nginx.conf` 示例。
- 迁移在**应用启动时自动执行**（`packages/persistence/src/db.ts:38-42`，`server.ts:65-68`）。43 个迁移里含 **24 处 DROP、19 处 ADD COLUMN NOT NULL、31 处数据回填**，且 Drizzle 不提供 down migration。
- 多实例部署时所有实例并发执行迁移；一次失败迁移 = 新版本起不来 + 旧版本可能已被 DDL 改坏，**无回滚路径**。
- 无备份/恢复/灾备文档（`docs/` 中"灾备"0 命中、"审计日志"0 命中）。

**修复**：迁移从启动流程剥离为独立 job（`tsp db:migrate`）+ 部署前强制备份 + DDL 走 expand/contract（先加可空列，再回填，再收紧）；产出容器镜像与最小 K8s manifest；补一份 runbook（备份、恢复演练、迁移失败处置）。

### P0-6 进程生命周期不完整

`apps/core-api/src/index.ts` 只有 `listen` 与 `catch → exit(1)`：

- **无 SIGTERM/SIGINT 处理**：滚动发布时在途请求被直接切断；system-agent 子进程可能成为孤儿。
- **`/health` 不检查数据库**（`server.ts:159-170` 只返回常量与领域自检），无 `/ready`：编排系统无法区分"进程活着"与"能服务"。
- 启动失败以未捕获异常栈直接退出（实测缺库时输出完整 Drizzle stack），排障信息对运维不友好。
- `system-agent` Worker 跑在 API 进程内（`server.ts:132-142`），无独立的横向扩缩或隔离边界。

---

## 五、P1：企业治理与工程质量的硬伤

### P1-1 契约不可机读：OpenAPI 形同虚设

注册了 `@fastify/swagger`，但 **200+ 条路由里只有 6 处声明了 JSON Schema（分布在 3 个文件）**，且**没有注册任何 `/docs`、`/openapi.json` 路由**（实测 401/不存在）。其余请求校验是每个 handler 里手写的 `if` + `safeParse`，风格各异（对照 `apps/core-api/src/routes/tasks.ts:64-75` 与 `devices.ts`）。少数重体量路由（架构图 24 MB、原型 30 MB、intake、skills、testing）已按路由单独设了 `bodyLimit` 与 schema，属于局部好实践，但未形成统一契约层。

后果：无法生成 SDK、无法做网关级契约校验、无法做契约回归测试、新人只能读 handler 反推接口。ADR 里"Zod 共用一套 Schema"的承诺实际上只在 `packages/contracts` 局部成立。

### P1-2 错误契约靠 250 行手写映射表维护

`apps/core-api/src/error-status.ts` 手工维护 240+ 条 `code → HTTP status`，未知码一律回落 400（`:258-260`）。问题：

- 错误码是**自由字符串**，没有枚举/目录，新增时极易漏映射，且漏了不会报错——只是悄悄变成 400。
- "客户端错误 vs 服务端错误"的分流依赖人工记忆（文件里专门写了注释解释 `internal_error` 必须显式映射 500）。
- 契约不一致：413 返回的是 Fastify 默认 `{statusCode, code, error, message}`，破坏全站 `{ok:false, error:{code,message}}` 的约定（实测确认）。

### P1-3 领域层贫血，业务规则沉在用例与路由里

`packages/domain` 仅 508 行（其中状态机 119 行），`packages/application` 11,602 行。ADR-0002 与架构不变量声称"规则应在领域层执行，而不是分散在 Web 或 CLI 中"，但现实是：

- `task-service.ts` **1,149 行**、`project-use-cases.ts` 794 行、`project-use-cases-project.ts` 767 行；
- 有 3 个路由文件直接 `db.select/insert/update`（如 `devices.ts:30-33`、`tasks.ts:104-111`），绕过应用层；
- 领域包实际承担的是"DTO 校验辅助 + 状态机 + 审计形状"，不是聚合根与不变量。

这不算错，但**它意味着"改一处业务规则需要横跨 application + routes + web 三层搜索"**，与 ADR 承诺的可维护性模型不符。要么把规则收回领域层，要么诚实地把 ADR 改成"事务脚本 + 少量领域对象"。

### P1-4 可观测性近乎为零

无 metrics（Prometheus/OTel）、无 tracing、无 `/ready`、无请求 ID 回传、无慢查询日志、无业务指标（任务流转时长、Agent 作业成功率）。日志是 pino 默认输出，未见字段级脱敏配置。审计事件 61 处写入，但没有对外导出通道（SIEM/Syslog/Webhook），安全事件无法进入企业监控体系。

### P1-5 API 无版本化策略

203 条路由全部挂在根路径，无 `/v1` 前缀、无版本协商、无弃用机制。企业集成方一旦接入，任何字段语义变化都是破坏性变更。

### P1-6 前端：令牌位置与 iframe 沙箱的组合风险

- 设备令牌存 `localStorage`（`apps/web/src/api.ts:2752`），任何 XSS 都可直接窃取。
- 好消息：全仓 **0 处 `dangerouslySetInnerHTML`**，用户 Markdown 走 `react-markdown` 且未启用 `rehype-raw`；HTML 原型 iframe 用 `sandbox="allow-scripts"`（无 `allow-same-origin`），隔离正确。
- 但 draw.io 编辑器 iframe 使用 `sandbox="allow-scripts allow-same-origin"`（`apps/web/src/DrawioEditor.tsx:94`）。同源沙箱 + 第三方在线编辑器，一旦画布内容或编辑器资源被控制，就能触达父页面存储的令牌。建议把 draw.io 放到独立子域，或改为 `postMessage` 严格白名单 + 心跳校验（现在已有协议层，但沙箱权限过宽）。
- 结构问题：`src/` 下 **85 个文件平铺**，无 features 分层；自研路由（`workspaceRouting.ts`）与自研 i18n；无表单库、客户端无 schema 校验；`api.ts` 2,826 行 161 个导出函数，`App.tsx` 721 行 —— 已经进入"没人敢重构"的区间。

### P1-7 测试体系"数量够、结构有偏"

925 个用例是真资产（真库、SSR 渲染、权限矩阵分组齐全）。但：

- `apps/web/tests` 41 个文件里 **46 处 `readFile`** 直接断言源码文本/样式字符串——这类测试重构必坏、却不验证行为，长期会训练团队"改样式先改测试"。
- 无覆盖率门槛、无变异测试、无契约测试。
- 唯一的失败用例是典型的 flaky 结构：断言子进程输出全等，未过滤 Node 实验性告警（`system-agent-runtime.test.mjs:90`），换一台配了代理的机器就红。
- CI 只跑 lint/build/typecheck/test，**没有** `pnpm audit`、SBOM、CodeQL、依赖许可证扫描、镜像扫描。

### P1-8 变更治理不可追溯

`git log` 只有 **4 个提交**，第二个是 `feat: initial public release of Team Synergy`（一次性倾倒约 4 万行）；工作区当前有 **117 个未提交改动**（69 修改 + 48 未跟踪）。无 PR 历史、无 tag/版本发布记录、无 release note 与变更关联。

对一个声称"以需求驱动、以证据验收"的平台，**自己的代码历史却是不可审计的**——这是评审中最容易被追问的点。

### P1-9 存在成规模死代码

`graph-traversal.ts` 实现了递归 CTE 遍历，并有 8 个用例覆盖，但**没有任何生产引用方**；`context_nodes/context_edges` 有表无 API。这类"已实现但未接线"的能力会持续消耗维护预算，并让文档与现实进一步脱节。要么接入（比如真正做 Task 子图投影），要么移除。

---

## 六、P2：值得修，但不影响过审

| 项 | 证据 | 说明 |
|---|---|---|
| 系统 Agent 临时目录永不清理 | `system-agent-runtime.ts:195` `mkdtemp` 后无 `rm` | 每次生成留一个含 home/workspace/tmp 的目录，生产环境是磁盘泄漏 |
| lint 门禁贴着债务走 | 70 warnings / 上限 80 | 其中 52 个 `no-non-null-assertion`、18 个 `exhaustive-deps`；后者是真实的过期闭包风险，不应长期忽略 |
| 仓库根目录 39 个 `.log` | 工作区实测 | 虽被 gitignore，但本地工作目录已不可读；建议统一 `tmp/logs/` |
| CLI 凭据明文落盘 | `apps/cli/src/auth-store.ts:53` `mode: 0o600` | POSIX 下正确；Windows 上 `mode` 不生效，建议 DPAPI/Credential Manager |
| 初始管理员口令 TTL 仅 15 分钟 | `ensureSystemAdmin` 生成后 15 min 过期 | 过期后只能靠重启重新生成，无文档化恢复路径；部署窗口容易被这一步卡住 |
| 服务端错误信息仅中文 | `error-status.ts` 全中文 message | 客户端按 code 翻译的思路是对的，但中文映射表只覆盖 4 个码，英文用户会看到中文 |
| 全局 bodyLimit 8 MiB | `server.ts:70` | 应改为按路由配置：文档/图片 8 MiB，认证类 16 KiB |
| 无 `.nvmrc`/锁版本注释 | `engines.node >=22` | CI 固定 22，本地漂移无感知 |

---

## 七、必须公允记录的优点

严苛评审不等于只挑毛病。以下设计在同类项目里属于**明显高于平均水位**：

1. **双平面边界想清楚了**：控制面只存共享事实、执行面留在成员设备、云端不反向连接开发者电脑。这是对"AI 编码协作"最容易被搞错的地方，这里是清醒的。
2. **乐观并发真的落地了**：`base_snapshot` + 条件更新（`task-service.ts:355-372`），不是只在文档里喊"乐观锁"。
3. **认证基础扎实**：设备令牌只存 SHA-256、90 天过期、改密吊销其他设备并写审计（`auth-device.ts:55`、`auth-use-cases.ts:76`）、`timingSafeEqual` 比较、口令用 scrypt + 随机盐。
4. **身份不可由请求体覆盖**：`principalOf` 明确忽略 body 中的 `user_code`（`auth.ts:97-105`），MCP 身份绑定同理——防越权的基本功到位。
5. **系统 Agent 的沙箱做得相当专业**：子进程环境白名单、`shell:false`、绝对路径校验、禁工具 guard、字节上限、超时、SIGTERM→SIGKILL 升级、凭据只进子进程 env 不进 prompt/日志/错误（`system-agent-runtime.ts` 全文）。这一段的质量明显高于仓库平均。
6. **错误按 code 翻译，不渲染服务端文案**（`apps/web/src/apiError.ts`）——防注入与可国际化的正确姿势。
7. **审计形状被强制**：`assertAuditedChange` 让"忘了写审计"变成类型/运行期错误，而不是靠自觉。
8. **intake 有密钥泄漏检测**（测试里对 `BEGIN PRIVATE KEY` 的拦截用例）。
9. **ADR 写得像样**：10 份 Accepted ADR，有取代机制说明，明确"讨论材料不覆盖 ADR"。

这些是底子。问题集中在"把好设计推到生产"的最后一公里。

---

## 八、建议路线图

### 阶段一：两周内止血（P0）
1. 列表接口强制分页；鉴权改单条 join 查询，去掉逐项目 N+1（目标：看板 DB 往返 < 5）。
2. advisory lock 按聚合分片，删除全局单键；补 100 并发写压测。
3. 登录/设备授权限流 + 失败计数 + 等时哑哈希 + 口令长度上限；挂 helmet/CSP/限流中间件。
4. `/ready`（含 DB 探活）、SIGTERM 优雅停机、启动失败友好退出。
5. Dockerfile + 迁移独立 job + 上线前备份；写一页回滚 runbook。
6. 孤儿数据巡检任务（在补 FK 之前先能"发现"）。

### 阶段二：一个季度补齐治理（P1）
7. 重写 `docs/00` 为"实际系统"基线（C4 Context/Container + 关键时序），旧版归档为历史；`docs/` 纳入版本控制。
8. OpenAPI 由 schema 生成（TypeBox 或 `fastify-zod`），路由校验统一到契约层，顺带产出 SDK。
9. 错误码枚举化 + 目录化，状态码映射由枚举派生而非手写表。
10. 拆 `task-service` / `api.ts` / `cli/index.ts`；把真正的业务不变量收回 domain。
11. metrics + 结构化审计导出（至少 Prometheus + 一个 Syslog/Webhook 出口）。
12. CI 增加 `pnpm audit`、SBOM、许可证清单、覆盖率门槛（先设 60%，只升不降）。
13. 前端令牌迁移到 httpOnly Cookie（配合 CSRF token），draw.io 子域隔离。
14. 把 46 处源码文本断言重写为组件行为断言。

### 阶段三：半年内达到"可规模化交付"（P2 及架构演进）
15. 核心聚合补 FK 或补 RLS；时间列迁移到 `timestamptz`。
16. API 版本化（`/v1`）+ 弃用策略。
17. 清理死代码（graph-traversal 接入或删除）。
18. 容量基线：以"100 项目 / 2 万任务 / 50 并发"为目标写性能预算并纳入 CI。
19. 补安全评审材料：威胁模型、渗透测试报告、依赖许可清单、数据保留与删除策略。

---

## 九、给评审会的一句话

> 这套系统的**架构判断力**足以支撑一个真正的企业级协作平台，但它的**工程交付形态**目前还停在一个高质量内部工具的水平。差距不在想法，在四件事：分页与查询效率、认证面的防护、数据库层的完整性兜底、以及可回滚的交付链路。这四件事补上之前，它适合 5–10 人的团队内网自用，不适合作为企业级平台对外承诺 SLA。
