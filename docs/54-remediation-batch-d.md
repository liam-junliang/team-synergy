# 批次 D 执行计划与证据

## 范围

只执行 D-01～D-05，守住 S-01～S-10；源码仓库修改并分项提交，门禁通过后备份、同步 service、独立迁移和启动。user-space 不修改。可选 OTel/webhook 不纳入，先提供可用 Prometheus 与 NDJSON 审计出口。

## 施工计划（先测试再修改）

1. D-03：先运行现有受限 Agent 回归；补成功/失败/取消/超时清理与启动过期清理测试，再增加 finally 清理。保留 N 份失败现场仅保留脱敏固定摘要；专用根目录，拒绝符号链接/越界，不删活跃 run。
2. D-01：新增隔离 metrics 注册器，固定 route/method/status 标签；连接池与任务/作业指标；SQL 超时与 >500ms 的无 SQL/参数慢查询事件。scrape 必须鉴权，防止运维数据越权。
3. D-02：先测试导出权限、时间边界、分页完整性和脱敏，再实现应用层有界审计分页与 HTTP 路由；CLI 输出逐条 NDJSON。只允许当前有效系统管理员，导出不成为普通成员全局数据通道。
4. D-04：先测试过期管理员恢复、审计与令牌吊销，再提供服务器本机命令和可配 TTL；不重置任何运行库账号。密码经 stdin/TTY，不进入参数、日志、JSON或测试快照。
5. D-05：对 46 个既有迁移记录摘要基线，新增迁移走 expand/contract 检查；拒绝同文件添加 NOT NULL 与破坏性 DROP、拒绝事务迁移中的 CONCURRENTLY。单测覆盖注释/字符串/函数体误判及违规案例，再接 CI。手工大表 DDL 独立运行、单独记证据，不伪造 Drizzle head。

## 验证

使用单独 Docker PostgreSQL 15432，完整回归库保持 team_synergy_test；各分工使用独立库。依次执行 build、typecheck、lint、迁移策略与全套串行测试，保留既有条件跳过。对新增运维功能做权限与无敏感输出验证；最后备份部署并探测 readiness/Web 与 metrics 访问限制。


## 完成证据（2026-10-23）

- D-03 / `8881b30`：受限 Agent 正常、失败、取消、超时均回收进程并清理临时目录；新增 3 个生命周期测试，覆盖保留上限、脱敏摘要、24h 历史、活动进程和链接边界。启动钩子在未启用模型时也清理已配置目录；默认保留 0，不调用付费模型做验收。
- D-01 / `e6574db`：独立 Prometheus registry，HTTP counter/histogram、pool total/idle/active/waiting、task/job 固定状态与生成成功率；仅当前系统管理员 Bearer 可 scrape。真实 HTTP 验证 route 模板与 >500ms 慢查询关联，日志无 SQL/参数/错误内容。pool/transaction/callback 查询行为与 statement_timeout 取消后恢复均覆盖；metrics+旧生命周期 7/7。新增 prom-client 是清单指定依赖，未引入 OTel 自动埋点；其传递依赖带入 @opentelemetry/api，lock 已统一 Drizzle peer 并重新构建。
- D-02 / `9264e5d`：应用层有界 ID 游标+固定高水位导出；since 保留微秒和时区、拒绝无效日历日期。API 拒绝普通成员及 legacy 身份，CLI 逐行 NDJSON 与稳定分页测试通过。敏感字段支持下划线/连字符、嵌套 JSON 字符串、Bearer、私钥与带口令 URL；原有 execution/handover/task-baseline 直接审计插入归并至 insertAudit，保护新入库和历史导出。失败只写 stderr、退出非 0，提示部分文件不可当作成功归档。可选 webhook 不纳入。
- D-04 / `701048d`：bootstrap 默认 30min、可配置 1..1440；本机命令要求明确数据库地址及 TSP_ALLOW_LOCAL_ADMIN_RESET=1。stdin/真实 TTY 传递临时口令，stdout 不含密码，强制改密并吊销设备/会话/租约。评审真实复现“旧批准 grant 在重置并改密后复活登录”，修复后同时吊销待处理/已批准授权；维护事务先锁授权表资源再锁用户，批准与兑换并发测试均通过，无新增全局 advisory 键。恢复/设备回归 13/13、CLI 5/5。未重置实际运行库任何账号。
- D-05 / `bfa34de`：CI 执行 pnpm migration:check；46 个历史 SQL 摘要不可改写，新增文件须登记、journal 单调且无重复。禁止 ADD NOT NULL 与 DROP 同文件，覆盖省略 COLUMN 的 DROP；CONCURRENTLY 从事务迁移分离。注释/字符串及 dollar body 中真实 DDL 的测试、历史改写与未登记文件回归 3/3。动态构造 DDL 仍须人工审查，静态检查不能替代迁移评审。

## 整批门禁

- build：9 workspace 通过；typecheck：通过；lint：0 errors、70 既有 warnings；diff whitespace：通过。
- workspace 串行回归：1084 个测试，1082 通过、0 失败、2 既有条件跳过（Windows 符号链接权限、未配置真实 DSH）。
- 迁移策略独立测试 3/3；新增错误码翻译的 Web i18n/admin 定向回归 18/18。没有删除用例或放宽既有断言。
- Docker API 镜像 synergy-remediation-d-api 构建成功，259,280,721 字节。原有容器非 root 和独立迁移配置保持不变。

## 运行副本

部署前已完成备份，经 scripts/deploy-runtime.ps1 同步、构建、独立迁移和启动；本批没有新增数据库迁移，仍为 74 张表/46 个 SQL 迁移。

实测 8080/health=200、8080/ready=200、5173/=200；匿名 metrics=401，现有普通成员 CLI 会话访问 metrics/audit-export 均为 403。管理员正向路径在独立数据库测试中验证，没有为了 smoke test 在运行库创建令牌或重置账号。

504 个已追踪源码/脚本/测试文件与 service 副本逐字节一致，8080/5173 监听进程路径均属于 team-synergy-runtime/team-synergy-service。user-space 未修改。

## 改动与限制

主要改动：core-api 的 metrics、audit 路由和 Agent 目录存储；application 的运维聚合、审计读写脱敏和本机恢复；persistence 的 pool 观察器；CLI 两个命令；CI 的迁移策略脚本。ADR-0012 和 ops/runbook 记录权限、锁序、环境变量与操作步骤。

审计高水位不是跨页数据库事务快照；SIEM 增量采集应重叠时间窗、按事件 code 去重。失败现场只保留固定安全摘要，不保留含凭据风险的原始运行目录。历史审计不改写，导出再次脱敏。RLS 与 B/C/E/F 后续范围不在本批。

下一批为 B：先 B-05 请求体分层，再 B-01 安全头、B-04 安全事件、B-02 Cookie/CSRF、B-03 draw.io 隔离。
