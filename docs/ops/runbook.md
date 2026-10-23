# Team Synergy 运维与恢复

## 范围与目标

源码在 `F:\workspace\team-synergy`；service 为运行副本，user-space 为成员工作区，禁止覆盖 user-space。凭据从受控环境注入，不写入命令历史、日志或版本库。

目标：RPO ≤ 24 小时（每天备份，部署前另备份）；RTO ≤ 30 分钟（恢复、版本切换与验证）。本地演练不能代表生产容量，数据增长后重新演练。备份包含项目数据与凭据哈希，目录仅允许运维账号访问，另存加密离机副本；本机默认保留最近 7 份。

## 部署前强制备份

通过受控环境设置 PGHOST、PGPORT、PGUSER、PGPASSWORD、PGDATABASE，以及指向同一个数据库的 TSP_DATABASE_URL，再从源码根目录执行：

```powershell
.\scripts\backup-database.ps1 -BackupDirectory F:\workspace\team-synergy-runtime\backups -Keep 7
.\scripts\deploy-runtime.ps1
```

部署入口先备份成功，再同步/构建/重启并检查 ready 与 Web。脚本使用 PG 环境变量，不在进程参数传递口令。pg_dump 和归档检查成功才清理旧备份。失败必须停止部署，禁止直接绕过备份运行 runtime 同步脚本。

## 容器与迁移

1. 设置 URL 安全的随机 POSTGRES_PASSWORD；存量库先完成备份。
2. `docker compose build`，记录新旧镜像不可变 digest。
3. `docker compose up -d`：migrate 一次性 job 成功后才启动 API；API 设置 `TSP_AUTO_MIGRATE=false`。
4. 检查 `docker compose ps -a`、migrate 退出码与 `/ready`、`/api/ready`；`/health` 仅证明进程存活。
5. 再部署时先停止 API，执行 `docker compose run --rm migrate`，成功后才 `docker compose up -d api web`，禁止多实例自行迁移。

本机可执行 `tsp db:migrate`（源码安装需含 persistence 包与迁移目录），或 `node apps/core-api/dist/migrate.js`；二者复用 persistence 路径规则。首次管理员密码只在 stderr 显示一次，应当场录入秘密管理器。

镜像不含 Codex 程序；系统 Agent 需另行受控安装配置，未配置时报告不可用。认证配置：TSP_AUTH_FAILURE_LIMIT 默认 5，TSP_AUTH_LOCK_SECONDS 默认 900。

## 恢复到空库

停止写入并保留故障库取证。使用上述 PG 环境变量，将 PGDATABASE 指向新建恢复库，不覆盖运行库：

```powershell
createdb team_synergy_restore
$env:PGDATABASE = 'team_synergy_restore'
pg_restore --exit-on-error --no-owner --no-privileges --dbname $env:PGDATABASE <已验证的.dump文件>
```

核对所有 public 表行数、迁移 head/hash、关键审计/项目/任务记录。以备份对应的旧版服务连接恢复库，检查 readiness、登录、任务、文档、CLI；通过后切换入口。成功前不删除原库和原始备份。

## 迁移失败与回滚

migrate 非 0、readiness 失败、迁移 head/hash 不匹配或关键业务失败时，立即停止发布及写入。不重复执行破坏性 DDL，不伪造迁移记录。

- 未提交事务：确认 schema/head 仍兼容旧版后，恢复上一镜像 digest。
- 已提交 DDL 或兼容性未知：将部署前备份恢复到新库，运行对应旧版并验证后切换入口。镜像回滚无法撤销已提交 DDL。
- 新迁移采用 expand/contract：可空扩展、回填、兼容窗口后再收紧或删除；旧实例仍运行时不得删除其依赖列。

## 恢复演练

实际耗时与对账证据记录在 docs/53-remediation-execution.md；必须使用隔离库。


## 批次 D：运维指标与审计出口

`GET /metrics` 返回 Prometheus 文本，必须携带当前有效系统管理员会话（Bearer 或已验证的浏览器 Cookie）。请为采集器使用受控的管理员 Bearer 设备凭据，通过秘密文件注入，不把令牌写进抓取 URL、命令历史或日志。未认证为 401，普通成员为 403。指标标签只含方法、路由模板、状态码和固定状态枚举，不含账号、项目编码、请求参数或 SQL。

指标包括 `tsp_http_requests_total`、`tsp_http_request_duration_seconds`、`tsp_db_pool_connections`、`tsp_tasks`、`tsp_system_agent_jobs`、`tsp_system_agent_generation_success_ratio`。查询超过 500ms 时日志只包含时长、route/method/request_id，不记录 SQL、参数或数据库异常。`TSP_DB_STATEMENT_TIMEOUT_MS` 默认 30000；0 仅用于受控长迁移/DDL，不建议关闭在线 API 超时。没有请求上下文的后台查询仅记录时长。

以已登录的系统管理员在 CLI 执行：

```powershell
tsp audit:export --since 2026-10-23T00:00:00Z > audit.ndjson
```

输出每行一个事件，不混入进度或 envelope；按包含起点的时间过滤，使用固定高水位 ID、升序游标分页，高水位限制新分配 ID，不将跨页读取宣称为数据库事务快照；增量采集应重叠时间窗并按事件 code 去重，以覆盖并发事务的延迟提交。导出返回非 0 表示文件可能不完整，不可当作成功归档。新审计入库及历史事件导出均做凭据字段、Bearer、私钥和带口令 URL 脱敏；未结构化的历史坏 payload 以脱敏占位符表示。导出文件仍含业务审计信息，限制访问与保留期限。可选 webhook 和 OTel 未启用。

## 系统 Agent 临时目录

`TSP_SYSTEM_AGENT_WORKSPACE_ROOT` 必须是独立绝对目录，不能位于源码/服务工作目录内，不能为链接或经过链接祖先。成功、失败、取消与超时均回收子进程并删除工作文件；启动时清理超过 24 小时的已识别目录，跳过仍有活动父/子进程的目录、陌生目录和符号链接。

`TSP_SYSTEM_AGENT_RETAIN_FAILED_RUNS` 为 0..20，默认 0。非 0 时仅保留最近 N 次失败的固定格式 failure.json（失败码和时间），不会保留 prompt、stderr、session、home、workspace 或凭据。关闭 Agent 后仍进行安全的启动清理。

## 管理员初始口令过期后的本机恢复

`TSP_BOOTSTRAP_TTL_MINUTES` 默认 30，范围 1..1440，控制 bootstrap 与本机恢复口令的过期时间；普通新用户的一次性密码策略保持原样。

仅服务器安装提供该命令，需要应用与 persistence 模块及数据库凭据，不经过 HTTP。通过受控环境设置显式 `TSP_DATABASE_URL`，并临时启用 `TSP_ALLOW_LOCAL_ADMIN_RESET=1`：

```powershell
$env:TSP_ALLOW_LOCAL_ADMIN_RESET = '1'
tsp admin:reset-password --account <管理员账号>
Remove-Item Env:TSP_ALLOW_LOCAL_ADMIN_RESET
```

默认仅向真实终端展示随机临时密码一次；重定向日志的自动化必须添加 `--password-stdin`，从秘密管理器的安全管道传入一行 8..128 字符的口令，不能在命令行参数或历史中写口令。stdout 只输出账号、到期时间等非秘密元数据。没有 HTTP 重置入口，也不能用此命令将普通成员提升为管理员。

恢复操作强制下次登录改密，清除账号登录锁和绑定口令，吊销待处理及已批准但未兑换的授权，以及全部设备/会话/租约，并写 `admin.password_reset`。审计明确标明本机数据库操作者、主机和 actor_authenticated=false，不伪装成用户会话操作。恢复过程不需要重启 API；IP 限额仍有效，可等待限额窗口结束后登录。禁止为了演练重置实际运行库账号。

## 迁移准入与手工 DDL

执行 `pnpm migration:check`；CI 同步检查。现有 46 个迁移以 LF 规范化 SHA-256 固化为历史基线，不追溯改写旧 SQL。新增迁移必须登记且时间戳单调递增；禁止同一迁移添加 NOT NULL 列并执行 DROP，禁止事务迁移中使用 CONCURRENTLY。

expand/contract：先新增可空列，分批回填并部署兼容双读/双写，记录验证窗口，再用后续迁移收紧约束，最后独立迁移删除旧列。不可通过更新历史摘要或注释豁免违规新 SQL。

大表索引采用 `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`；大表重建使用 `REINDEX ... CONCURRENTLY`。这些命令必须放在独立手工 DDL 文件，禁止写入 Drizzle journal（迁移器包事务）。上线前备份，记录数据库/版本、DDL 文件摘要、开始/结束时间、锁/耗时、实际索引状态；在维护窗口单独 psql 自动提交执行，不开启 BEGIN。查询 pg_index 确认 indisvalid/indisready；失败的 INVALID 索引应确认依赖后单独 DROP INDEX CONCURRENTLY，再按运行记录重试。不要伪造 __drizzle_migrations 来标记手工 DDL。

大表 SET NOT NULL、类型转换、表重写或大批 UPDATE 应先做容量和锁时间评估；回填分批提交，使用 NOT VALID/VALIDATE 的适用约束或兼容窗口，statement_timeout 与 lock_timeout 明确设置，超时/异常立即停止发布，按前文恢复流程处置。
## 批次 B：浏览器会话和登录安全

Web 的会话与安装 proof 改放 HttpOnly Cookie，升级后原 localStorage 凭据直接删除，需要重新登录一次。生产使用 `__Host-` Cookie（Secure、SameSite=Lax、Path=/、无 Domain）；开发只允许 Host 和直连客户端均为回环时使用 HTTP。平台不接受从 forwarded 头推导的降级。部署在 HTTPS 网关后时设置 API 的 `TSP_WEB_ORIGIN=https://实际平台域名`（包含非默认端口），保留原始 Host；网关本身设置 HSTS。普通公网 HTTP 不属于支持的浏览器部署方式。

CLI 继续使用 Bearer。浏览器的 CSRF 只存内存，刷新时从 `/auth/web/session` 恢复；跨站 Origin、缺失/伪造/跨会话 CSRF 均拒绝。退出只有服务端吊销并清 Cookie 成功后才切换到登录页；网络失败保留登录界面并提示重试。安装 proof Cookie 退出后保留，以便下次口令登录仍对应同一浏览器设备。

`user.login_failed`、`user.locked`、`user.unlocked` 可通过原审计出口获取。未知账号只进入 `auth_security_events`，不伪造用户主体。锁到期的解锁在下一次密码尝试时懒记录；改密和本机恢复在真实清锁时记录。指标 `login_failures_total{reason="invalid_credentials|locked|rate_limited"}` 是数据库持久观察总量，抓取不会重复累加；不要与“用户输入错误密码次数”混为一谈。

系统管理员可查询 `GET /admin/security/login-events?group_by=ip&since=2026-10-23T00:00:00Z&limit=50`。也支持 group_by=account、until、offset、account_hash/ip_hash；默认最近一天，最大 31 天，limit 1..200、offset 0..100000。返回哈希分组的失败/锁定/解锁数。原 IP/账号不写安全观察表，哈希仍可关联且可能被字典推断，查询权限和导出保留策略应等同安全审计。该接口没有关闭认证、解锁账号或删除安全事实的能力。

## CSP 报告窗口与安全响应头

API 使用 Helmet；Vite dev/preview 和 nginx Web 入口独立设置 nosniff、DENY、no-referrer。HTTP 不发送 HSTS；真正面向用户的 HTTPS 终止层必须发送 `Strict-Transport-Security: max-age=31536000`，不能相信客户端自带的 X-Forwarded-Proto。上线后分别检查页面与 `/api/ready` 的最终外部 HTTPS 响应头。

本批于 2026-10-23 开始报告模式，最早在 2026-10-30 根据真实使用报告复核切换，不自动切换或创建定时任务。基础 `frame-ancestors 'none'; object-src 'none'; base-uri 'none'` 在 Web 立即强制。完整策略的 `Content-Security-Policy-Report-Only` 包含 `/api/security/csp-report`；浏览器原生报告无需 CSRF。服务端每分钟最多记录 120 条固定白名单 directive，不记录 blocked/document URL、源码片段或 Cookie。检测日志 `CSP policy violation`，联系实际流程重新复现，不能把没有日志直接当作全部功能通过。

报告窗口覆盖登录/刷新/改密/退出、任务看板、文档 Markdown/图片、Mermaid/draw.io 编辑与预览、HTML 原型及受沙箱限制的外部 URL 预览，并观察浏览器控制台。真实长期使用无新增违规且关键流程复测通过后，API/Vite 设置 `TSP_CSP_MODE=enforce` 并重启；nginx 将完整策略的响应头名从 Report-Only 改为 Content-Security-Policy，执行 nginx -t 后发布。若强制后出现新违规，回到报告模式定位，保留基础禁止被嵌入的策略。

当前生产 Web 策略保留 unsafe-inline（既有沙箱 HTML 原型需要）以及 HTTPS 外部预览 frame-src，未声称严格 CSP 已完成；后续收紧必须保持 S-08 并重新验证原型。draw.io 仍固定指向 embed.diagrams.net 的独立 origin，不能未经复核改成同源载体。图源会发送到该第三方服务；本批没有改成离线编辑器。

请求体默认 1 MiB，认证 POST 16 KiB，普通交接/需求文档显式 8 MiB，架构文档 24 MiB，原型 30 MiB；既有 intake/testing/skills 的独立限制保留。解析超限统一 HTTP 413 和 request_body_too_large envelope，具体内容验证仍可在更小的领域限制处拒绝。
