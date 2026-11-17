# 独立 PostgreSQL 测试环境

数据库测试使用独立的 PostgreSQL 16 实例：`127.0.0.1:55432`。本机数据目录为 `F:/workspace/team-synergy-runtime/test-postgres/data`，配置文件为同目录上一级的 `runtime.private.json`。配置、随机密码与运行记录属于本机私有文件，不提交到仓库。

测试不会读取运行服务或备份中的连接串。`tsp_test_runner` 使用独立随机密码，权限为 `NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS`；初始化管理员只存在于这个测试实例中。测试子进程不会收到初始化管理员密码。

## 运行

```powershell
pnpm test:db:provision
pnpm test:db:check
pnpm test
pnpm --filter @team-synergy/application test
pnpm test:isolated -- node --test packages/application/tests/personal-memory.test.mjs
pnpm test:isolated -- node --test tests/test-database-guard.test.mjs tests/test-postgres-isolation.test.mjs
```

本机使用现有 `F:/DB/PostgreSQL/16/bin` 工具。首次 provision 只创建新的测试目录和实例；已有目录缺少可信身份时拒绝覆盖，端口已被其他进程占用时也拒绝接管。已登记的本机实例停止后，provision 先核对离线 cluster ID，再启动同一目录。CI 使用新建的 PostgreSQL 16 service、同一专用端口和同样的测试身份校验；其 `PGPORT` 配置遵循 [PostgreSQL 16 官方文档](https://www.postgresql.org/docs/16/app-postgres.html)。

各数据库 package 的 `test` 命令都通过中央 runner。嵌套 runner 重新验证并继承父运行的租约，不创建递归运行。测试前应清除外部 `TSP_TEST_DATABASE_URL`、`TSP_INTEGRITY_TEST_DATABASE_URL`、`TSP_DATABASE_URL` 覆盖；runner 会自行创建本次专用库并设置子进程环境。直接 `node` 运行数据库入口而没有有效租约会被拒绝。

原生 Agent 评估也从同一个入口启动，例如：

```powershell
pnpm test:isolated -- node apps/core-api/tests/native-memory-live.mjs --prepare-only
```

模型和双引擎评估的其他参数仍由相应评估脚本控制。Agent 的环境应移除 PG 密码及测试控制租约，成员通过平台 API 访问自己的资源。

## 三层核验

1. 打开 socket 前核验固定 loopback、端口、测试用户名与测试配置中的随机凭据，拒绝其他端点或 URL 选项。测试专用 preload 同时覆盖原始 `pg.Client`、`pg.Pool` 和 `openDb` 的连接。
2. 连接成功后核验真实 `pg_control_system()` 标识、数据目录、实例标记和角色权限。所有新数据库继承管理员拥有的 `tsp_test_guard` schema，测试角色不能修改其归属记录。
3. 每次创建前检查库名不存在；创建后登记数据库 OID、本次 run token 与 fixture token。DROP/TRUNCATE 前再次核验身份；清理前核验原 OID、owner 和受保护 token，再删除并确认不存在。重置 `public`/`drizzle` 不会清掉归属证明。

`scripts/orphan-fixture.mjs`、三个 reset/TRUNCATE helper、CLI/agentd HTTP fixture、迁移升级 fixture 和 native-memory-live 共用中央 allocator。需要独立库的新测试应调用 `createTestFixture(label)`，先关闭自己的连接，再调用返回的 `dispose()`；不要自行从任意 URL 改成 `/postgres` 后执行 CREATE/DROP。

## 运行记录与失败处理

`test-postgres/runs/<run-token>/` 保存子进程 PID、开始时间和每个 fixture 的创建/销毁记录，其中的连接信息是私有凭据。正常结束只清理本次登记且身份一致的库。异常中断、库被替换、标记变化或仍有连接时保留记录并报错；不会遍历删除未知库，也不会为清理而强制终止其他连接。

隔离负例验证错误端口、用户、实例标记、OID 和租约会被拒绝。业务端口负例在打开 socket 前阻断，不发送业务密码，也不需要连接业务实例。
