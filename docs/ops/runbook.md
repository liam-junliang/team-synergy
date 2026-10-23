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
