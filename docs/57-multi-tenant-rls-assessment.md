# 共库多客户隔离与 RLS 架构评估

- 评估日期：2026-10-23（Asia/Singapore）。
- 对应：施工清单 C-04；用户已确认“多个客户共用数据库，需要评估 RLS”。
- 产品决定：用户已选择本文三项推荐边界，已记入 [ADR-0017](adr/0017-multi-customer-boundaries.md)，状态 Accepted；RLS、tenant schema 与租户事务尚未上线。
- 范围：代码只读检查、隔离数据库实验、实施方案。**本次没有增加客户实体、业务 policy、schema 或迁移，也没有变更运行库。**
- 检查基点：`5ec8fd0` 工作区及本批 C 并行施工中的 schema；当前 `schema.ts` 声明 75 张业务表。C-01/C-03 的外键与时间迁移应另看实际交付记录。

## 1. 结论与先决条件

建议引入 RLS，作为“一个客户不能读取或写入另一个客户私有行”的数据库防线；先建立客户归属和受控事务入口，再小范围启用。当前不能直接按 `team_id` 全库添加 policy：系统没有客户实体，团队并不等于客户，部分数据没有团队列，还有刻意设计的跨团队共享。

推荐层次为 `tenant（客户）→ teams（协作组）→ projects`。用户保留全局登录身份，通过独立的 `tenant_members` 加入一个或多个客户；团队、项目角色继续决定客户内部权限。每次业务请求有一个经验证的活动客户，不把“用户在其它客户有成员关系”自动扩张成当前请求的权限。

RLS 不替代 `assertProjectAccess`、Owner/Admin/Viewer、草稿可见性、归档限制、审计、乐观并发或技能版本授权。只满足租户相等，不能让 Viewer 写项目，也不能让一个客户的所有成员看到其全部私有项目。

独立 PoC、事务改造清单及三项产品边界已经具备。下一阶段按第 11 节的小批次评审和实施；产品决定已确认不等于数据库隔离已实现，不能声称“多客户隔离已上线”。

## 2. 实际模型与需要修正的旧假设

| 检查位置 | 代码事实 | 对 RLS 的影响 |
|---|---|---|
| `packages/persistence/src/schema.ts` 的 `teams/projects/users/team_members/members` | 没有 tenant/customer 实体或 tenant_id；项目属于一个 team；用户可以加入多团队，也可以取得非所属团队项目的显式授权 | 同一客户可能有多个团队；跨团队授权不能自动解释为跨客户授权 |
| `packages/application/src/project-access.ts` | 项目 Owner、显式成员、`team_read/team_write` 继承三条访问路径；`isExternal` 表示不在项目所属团队 | 客户成员资格是新增外层约束；“外部成员”现指团队外部，不能直接重解释为客户外部 |
| `user-use-cases.ts: normalizeAccount/listUserDirectory` 与 schema `uq_users_account` | 登录账号全局唯一；有效登录用户可列出全部活跃用户的 code/account/display_name | 当前目录会暴露其它客户的人员身份；上线共库客户前必须限制目录与邀请搜索 |
| `admin-governance-use-cases.ts`、`audit-export.ts`、`login-security.ts` | `is_system_admin` 管理全局团队/项目、导出全局审计、查询认证事件；它不是团队 Owner | 客户管理员不能复用此位；平台控制面与客户数据访问必须分开 |
| `skills-access.ts`、`skills-use-cases.ts: shareSkill` | 技能属于 team/project；共享指定已发布版本、目标 team/project，并有 `allow_projects/allow_external`；安装和源成员权限互相独立 | 一条“所有相关行必须同 tenant”的政策会破坏合法共享；必须逐版本保留精确交付权 |
| `skills-use-cases.ts: listSkills` | 先从全局技能集合读取，再执行可见性过滤；没有匿名公开市场 scope | 目前“共享”不等于互联网公共库。不能把全部已发布技能设成公共数据 |
| `auth.ts: isPublicRoute`、`routes/project-documents.ts` | 项目文档没有匿名公共阅读路由；公开端点是健康、CLI 分发、认证入口及 CSP 上报 | `publicCode()` 是标识符，不是公开授权；平台文档、项目共享文档与将来公共内容要区分 |
| `packages/persistence/src/db.ts` | 一个 `pg.Pool` 与 Drizzle 根 Db；读取和写入混用根 Db/tx；目前不设置租户上下文 | 不能在 onRequest 上对 pool 执行一次 SET 后假定后续查询仍用同一连接 |
| `routes/auth.ts: whoami`、`routes/devices.ts` | 仍有直接 Db 查询/事务；应用层也存在事务外查询和 Promise.all | 只改部分 application 用例会漏掉真实查询路径；所有租户数据路径都需要受控连接 |
| `system-agent-use-cases.ts: claimJob` | 队列跨项目扫描、`FOR UPDATE SKIP LOCKED`，随后按 requester 重查权限 | worker 需要专门的调度入口与每任务客户上下文，不能给普通业务池一个全局绕过位 |
| `compose.yaml` | migrate/API 使用同一个 `team_synergy` 数据库账号；Postgres 镜像为 16；示例没有独立应用角色 | 该连接配置不能直接作为 RLS 上线凭证。角色属性、表 owner 和成员关系都要实际验证 |

上述现状不证明系统已有客户间授权；只是说明划分客户时，不能把既有跨团队合作悄悄切断或默认对所有客户开放。

## 3. 全部现有表的归属分类

下表覆盖这次检查的 75 张表，每张只列一次。分类描述拟议归属，不表示已有对应列。迁移账本 `drizzle.__drizzle_migrations` 是部署控制数据，不计入业务表，也不给普通应用池迁移权限。

<!-- TABLE_INVENTORY_START -->
| 类别 | 数量 | 表 | 拟议边界 |
|---|---:|---|---|
| 全局身份、认证与部署 | 7 | `system_settings`, `users`, `devices`, `device_sessions`, `device_authorization_requests`, `auth_rate_limits`, `auth_security_events` | 独立身份/控制平面角色；不把认证秘密开放给客户业务连接。匿名认证尚无可靠 tenant，不能凭输入账号或 IP 猜归属 |
| 团队与授权治理 | 5 | `teams`, `team_members`, `members`, `ownership_transfers`, `project_orders` | 团队归一个 tenant；成员/个人排序继承其资源 tenant。多态 ownership scope 须分别验证 team/project 归属 |
| 直接项目资源 | 26 | `projects`, `project_repositories`, `project_workspaces`, `project_document_folders`, `project_documents`, `system_agent_jobs`, `project_modules`, `project_phases`, `project_milestones`, `requirement_documents`, `requirement_ideas`, `requirement_topics`, `design_prototypes`, `architecture_documents`, `features`, `requirement_baselines`, `context_snapshots`, `artifacts`, `context_graphs`, `test_cases`, `test_assets`, `test_executions`, `project_skill_states`, `project_skill_installations`, `intake_batches`, `intake_bindings` | 以项目确定客户；工作空间路径、仓库地址、任务输入/执行内容同样是客户数据。技能安装的**目标项目**归此类，技能来源另走跨客户授权桥 |
| 项目后代、修订和关系 | 32 | `project_document_revisions`, `requirement_document_revisions`, `requirement_topic_ideas`, `requirement_topic_entries`, `requirement_topic_entry_images`, `requirement_topic_documents`, `requirement_document_reviews`, `requirement_document_review_votes`, `design_prototype_revisions`, `design_prototype_requirements`, `architecture_document_revisions`, `requirements`, `requirement_revisions`, `defects`, `requirement_baseline_items`, `tasks`, `task_dependencies`, `workspaces`, `runs`, `task_handovers`, `run_leases`, `agent_sessions`, `evidences`, `context_graph_snapshots`, `context_nodes`, `context_edges`, `test_case_revisions`, `test_asset_revisions`, `test_execution_results`, `run_skill_manifests`, `intake_items`, `intake_attempts` | 沿资源链继承 tenant；关系表所有端点须满足客户一致性；不可只检查其中一个父节点 |
| 技能来源与共享桥 | 3 | `skills`, `skill_revisions`, `skill_shares` | 私有来源归源 tenant；跨客户读取仅限明确获授的已发布版本，来源团队、草稿、其它版本不能跟随开放 |
| 命令回执 | 1 | `command_receipts` | 现只有 principal/device/operation/key/result，没有可可靠推导的项目归属；必须在创建时记录 tenant，幂等键也加入 tenant，不能靠解析 result JSON 回填猜测 |
| 混合审计 | 1 | `audit_events` | project/task/skill 等事件归对应客户；全局身份、部署和平台操作事件单独控制。不能用“tenant_id 为空就是所有客户可见”作为兜底 |
<!-- TABLE_INVENTORY_END -->

需要特别盘点的关系：

- `requirements` 的 feature/module/document 可能同时存在；所有非空父引用均要一致，不能只用第一项推导。
- `task_dependencies`、图边两端、原型需求关系、议题/想法/文档关联、评审投票等，要检查两侧；是否还要求同项目，保留现有业务语义，不借 RLS 新增未经决定的限制。
- `run_leases` 的 run 是租户资源，而 device 是全局身份资源：应验证设备用户的活动客户及执行授权，不把 device 主键硬改成客户专有。
- `context_snapshots.manifest`、`run_skill_manifests.manifest_json`、测试 snapshot、intake JSON、回执 result 可嵌入正文和标识符。RLS 只过滤行，不能修复一行 JSON 内已经混入的其它客户私有内容。
- 仅有 `case_code/task_code/defect_code` 的测试引用仍需客户约束和只读巡检；字符串引用不会因启用 RLS 自动成为外键。

## 4. 客户、用户与外键方案

建议新增 `tenants(id, code, name, status)`、`tenant_members(tenant_id, principal_id, role, status)`；租户管理员角色与平台 `is_system_admin` 分离。`teams.tenant_id` 固定归属，创建项目时从 team 推导，不能接受请求体声称的 tenant 作为事实。

保留一个全局用户可以加入多个客户的能力，是避免破坏当前多团队身份的推荐方案。每次切换客户先验证活跃 tenant_members，再加载该客户的 team/project 权限。未加入客户的项目外部协作者，需要受邀的受限客户成员身份，不能仅凭原有跨团队 members 记录越过新边界。历史外部成员映射须逐项盘点，而不是自动授予完整客户成员资格。

全局 `users.account` 继续唯一是推荐选项，不代表客户可以枚举该全局目录。客户目录只返回本客户和经明确协作授权的必要展示字段；邀请流程不能通过“账号已存在”等差异暴露其它客户身份。若产品要求每客户相同短账号各自登录，则需另设 `(tenant_id, login_account)`，登录入口明确客户，不能直接删除现有唯一索引。

租户资源建议显式保存不可随意修改的 `tenant_id`，并为被引用端建立 `UNIQUE(tenant_id,id)`：

```sql
-- 方案示意，不是本次迁移。
FOREIGN KEY (tenant_id, team_id) REFERENCES teams(tenant_id,id);
FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id,id);
FOREIGN KEY (tenant_id, feature_id) REFERENCES features(tenant_id,id);
```

单列 FK 只能证明父记录存在；复合 FK 才能阻止 A 客户任务引用 B 客户 feature。RLS `WITH CHECK` 也不等于引用关系完整性。tenant 列由受控写入从父资源推导，应用角色无权把既有对象“改租户”；客户搬迁应是单独的审计、全关联迁移流程。

对 revision/association 表也建立复合约束。针对多态 scope，应考虑拆分类型化引用或增加经校验的映射表；不要用一个无外键的 `(scope_type,scope_id)` 继续承载所有租户关系。新增客户列的展开、回填、约束验证与收紧分阶段完成，不能把不确定历史数据统一填成默认客户来“消除 NULL”。

索引从真实过滤/排序出发补 `(tenant_id,project_id,...)`、`(tenant_id,created_at,id)` 等；PoC 用实际列表和连接验证 EXPLAIN，避免几十层 RLS parent EXISTS 重复查询抵消 A-01 的查询优化。

## 5. 共享、平台内容与管理员边界

### 已有技能共享必须保留的语义

`allow_external` 当前表示目标项目含团队外部成员，**不等同于允许向任意其它客户分发**。客户映射建立后，先区分“同客户不同 team”和“真正跨客户”的现有 share，不自动删除，也不自动扩大。

推荐跨客户共享继续显式、逐已发布版本授权，额外记录源/目标客户与接收方确认。可以增加类型化 grant：`source_tenant_id + skill_id + revision + target_tenant_id + target_scope`，目标安装行以本客户项目为 owner，另以源客户复合 FK 引用技能。此处刻意允许跨客户引用，不套用普通资源的同 tenant FK。

目标用户的授权视图仅返回被允许的技能内容和必要元数据；不让目标读取源 team 成员、源项目、草稿、私有修订或其它 share。撤销、停用和冻结 Run manifest 保留现有审计/重放语义；接收确认不扩张为无限期读取源私有资源的许可，也不能暗中删除已冻结交付证据。

不要给普通业务表加宽泛的第二条 permissive `OR published` policy。核心私有表使用单调收紧的 tenant 防线；跨客户技能授权只在明确的技能交付入口/授权桥中实现，且新旧应用授权测试同时通过。未来若确实需要平台公共技能/模板，应为经选择发布的脱敏内容建立单独目录投影，不把“版本已发布”或 `tenant_id IS NULL` 当成公开授权。

### 平台与客户管理员

现有 `is_system_admin` 的全局治理能力是真实存在的，不能直接当作客户管理员发给各公司。推荐日常平台管理默认只看账号运行状态、客户目录与必要运营元数据；客户正文访问需要限客户、限时、附原因的支持授权，写审计。平台超级管理员也不让普通 API 连接成为数据库 BYPASSRLS/owner。

全局安全事件、登录账号哈希、IP 哈希、密码恢复、认证令牌和全局审计进入单独平台权限域。客户管理界面只能看属于该客户的授权事件与脱敏统计。应用的“我是系统管理员”布尔 GUC 或普通请求头，不是数据库绕过策略的依据。

数据库备份、恢复、灾备、完整性巡检可能确需全库权限，应使用与 API 分离的受控运维账号和审计通道。全库导出不能静默借助客户 API 池完成；客户导出必须同时限定内容、对象存储附件和租户范围。

## 6. 数据库角色与事务接线

### 最小角色分离

| 建议角色 | 权限与使用场景 |
|---|---|
| `tsp_owner` | NOLOGIN，拥有表/函数/策略；普通应用不是其成员。必要时通过迁移角色显式切换，不能靠连接默认 owner |
| `tsp_migrate` | 独立部署凭据，可按流程 SET ROLE 到 owner；仅迁移 job 使用，API/worker 环境不携带其凭据 |
| `tsp_app` | 非 owner、NOSUPERUSER、NOBYPASSRLS；仅必要 DML、schema USAGE、序列和限定函数权限，无 DDL/TRUNCATE/owner 角色成员资格 |
| 身份/认证与调度入口角色 | 只给明确的认证函数、最小身份查询、无正文任务调度投影等权限；不能为省事给所有全局表 SELECT 或对租户业务表 BYPASSRLS |
| 运维/备份角色 | 单独受控入口，按备份/恢复/完整性检查需要授权；权限不能继承到普通应用池 |

对需要隔离的业务表启用并 FORCE RLS；没有适用 policy 时默认拒绝。superuser/BYPASSRLS 总会绕过，owner 通常也绕过，故只开 ENABLE 不够。RLS 也不限制 TRUNCATE，所以最小 GRANT 仍必要。见 [PostgreSQL 16 RLS](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)。

每条策略明确写出读取旧行的 USING 与写入新行的 WITH CHECK；多条 permissive policy 会以 OR 扩张权限，restrictive policy 才用于收紧。见 [CREATE POLICY](https://www.postgresql.org/docs/16/sql-createpolicy.html)。

视图、SECURITY DEFINER、触发器、全局唯一约束及 FK 错误都应列入泄漏面检查：避免以 owner 视图暴露受保护数据；如需 definer 函数，固定 search_path、收紧 EXECUTE、限制返回形状，明确其 owner 与 RLS 行为。不要把异常 SQL/完整参数返回给客户来暴露另一客户对象是否存在。

### 每次操作的可信上下文

建议以 `withTenantTransaction(verifiedSession, requestedTenant, work)` 为唯一租户 Db 入口：

1. 身份入口先验证现有 Cookie/Bearer；从认证结果得到 principal，不能从 body 获取演员身份。
2. 按 tenant_members 和资源归属验证活动客户；只把该客户的授权上下文交给业务事务。
3. 同一 `db.transaction` 中，参数化执行 `set_config('app.tenant_id', tenantId, true)` 与 `set_config('app.principal_id', principalId, true)`；true 表示事务局部。业务只获得该 tx，所有后代查询/写入都使用它。
4. 无上下文必须 fail closed；连接异常时 rollback/release，禁止继续处理业务。嵌套 savepoint 回滚也应验证上下文恢复行为。
5. 不把一次 HTTP 请求整个包成长事务等网络响应；先完成认证，短事务加载/修改事实，释放连接后再调用外部系统。

`SET LOCAL` 在当前事务结束后失效；在事务外执行不能提供所需隔离。[PostgreSQL SET](https://www.postgresql.org/docs/16/sql-set.html)；Node-postgres 要求整个事务使用同一 client，不能用分散的 pool.query 组成事务。[node-postgres transactions](https://node-postgres.com/features/transactions)。请求级 AsyncLocalStorage 的 principal 只是日志上下文，不会自动给实际数据库连接设置 RLS 条件。

**威胁边界：自定义 GUC 不是认证机制。** 本次实验中，普通 app 角色能把 `app.tenant_id` 改成另一个值并读到其行。因此“共享 app 登录 + 可任意设置的 tenant/principal GUC”只能防止可信应用漏写 WHERE，不能声称抵御掌握该 SQL 连接或任意 SQL 注入的攻击者。生产方案还需选择并验证可信上下文边界：受限数据库函数验证签名的 principal/tenant 票据，或由受控凭据代理发放每客户数据库角色；普通业务 SQL 不能自行伪造该授权。签名发行方、验证函数、密钥保管、过期与重放处理都属于单独安全设计，本文没有实现。仅在另一 GUC 增加 principal/membership EXISTS，若两者均可被任意 SQL 改写，不能解决这个问题。

### 真实入口需要怎样改

| 当前路径 | 拟议接线要求 |
|---|---|
| `auth.ts` 的 Cookie/Bearer 解析、登录、whoami、设备授权 | 认证可先在全局最小权限入口执行；其后显式选择客户。匿名登录/设备 start 不凭输入 tenant 获得客户数据权限 |
| `task-service`、项目/文档/技能等普通读取 | 当前事务外 root Db 查询也必须迁入受控 tenant tx；并行查询只能复用该事务句柄，不能偷偷回到根 pool |
| `routes/devices.ts` 等直接查询/事务 | 全局设备所有者信息与租户 run/session 视图分开；不能让设备列表顺带读其它客户的执行事实 |
| 系统 Agent worker | 独立调度入口只取 job_id/tenant_id；每个 job 用该 tenant 与 requester 当前权限运行短事务。租约/重试/完成写回重新验证，不拿全局连接执行正文查询 |
| agentd/CLI API 操作 | 保留主动出站和现有 Bearer；工作空间绑定增加经验证客户选择，服务端独立验证资源归属；客户端不能自签 tenant |
| `tsp db:migrate`、admin reset、巡检、备份/恢复 | 迁移使用部署角色；admin reset 使用最小全局身份权限；tenant 巡检逐客户上下文，跨库巡检使用专用运维凭据。`migrate:false` 不是权限隔离 |
| `/ready`、CLI 分发、CSP、静态资源 | 仅必要探活/部署元数据，不授予业务行权限；不要因默认拒绝就给所有未携带 tenant 的请求一个管理员连接 |
| 全局平台治理与审计导出 | 走显式平台控制平面或支持授权；普通客户 endpoint 绝不能使用跨客户 fallback |

池复用需要实测，而不是仅证明变量在 JavaScript 上随请求变化。以后使用 PgBouncer 等事务池时，客户端事务与设置必须在同一服务端事务；不能依赖 session 变量、onConnect 上次客户值或“结束时 RESET 应该会成功”。

## 7. 已运行的隔离 PoC

环境：仅 `127.0.0.1:15432/c_rls_test`，PostgreSQL **16.15**；两个虚构客户、项目、任务；临时 `c_rls_owner_57` 与 `c_rls_app_57`。本地脚本 `tmp/c-rls-poc.mjs` 在执行前确认专用数据库不存在，结束后删除该数据库及两个角色；未使用运行库。脚本不属于生产交付，核心实验可按下述结构重建。

```sql
-- 只适用于一次性测试库；省略角色创建/授权和测试数据，不能作为业务迁移执行。
CREATE TABLE rls_poc.projects (
  tenant_id bigint NOT NULL, id bigint NOT NULL, name text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE rls_poc.tasks (
  tenant_id bigint NOT NULL, id bigint NOT NULL, project_id bigint NOT NULL,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES rls_poc.projects(tenant_id,id)
);
ALTER TABLE rls_poc.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_poc.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY isolate_projects ON rls_poc.projects
  TO c_rls_app_57, c_rls_owner_57
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::bigint);
-- tasks 使用相同条件；本例故意只演示基础 tenant fence，不伪装成完整身份验证。
BEGIN;
SELECT set_config('app.tenant_id','1',true);
SELECT * FROM rls_poc.projects;
COMMIT;
```

实际执行 **12 项行为断言通过**，另记录 server_version。这里只证明基础机制；没有拿它替代项目/成员/共享策略的正式回归。

| 断言 | 实际结果 |
|---|---|
| owner：ENABLE、不 FORCE、无上下文 | 看见两个客户，证明 owner 绕过不能忽略 |
| 同 owner 加 FORCE、无上下文 | 0 行 |
| 非 owner/NOBYPASSRLS app 无上下文 | 0 行 |
| app 的 tenant=1 SELECT | 仅 A 项目 |
| max=1 单连接池，SET LOCAL 后 COMMIT、归还并复用同 backend pid | 下一次无上下文查询 0 行 |
| tenant=1 INSERT tenant=2 | 拒绝，SQLSTATE 42501 |
| tenant=1 将自己的行 UPDATE tenant_id=2 | 拒绝，42501 |
| A task 引用 B project 的复合 FK | 拒绝，23503 |
| 上述错误 ROLLBACK 后再查询 | 0 行，无客户上下文残留 |
| app 关闭 RLS | 拒绝，42501 |
| app TRUNCATE | 拒绝，42501（因为没有 GRANT，不是 RLS 自身过滤） |
| app 自行 SET LOCAL tenant=2 | 可读 B；记录为已证实的上下文信任边界，不把它算成安全能力 |

## 8. 小范围实施与回归矩阵

下一步建议只做隔离 PoC 分支：两个 tenant、一个多客户用户、`teams/projects/features/tasks` 与最小 tenant_members；暂不自动迁移技能、全局身份和全部历史审计。原始 SQL、真实应用 API、应用角色三层都必须测，不能只用 superuser 跑 ORM 用例。

| 维度 | 后续验收要求 |
|---|---|
| 客户切换 | A/B/无上下文交替请求；缺失、空、伪造 tenant 拒绝；同用户多客户不会把 A 的活动客户状态串入 B 标签页 |
| 内部 ACL | 同客户无项目成员、Viewer、成员、Owner、归档、外部协作者矩阵；RLS 通过不改变业务拒绝 |
| SQL 读写 | SELECT/count/join/原生 SQL、INSERT、UPDATE/RETURNING、DELETE、UPSERT、批量操作、迁移回填覆盖；跨客户复合 FK 拒绝 |
| 连接与异常 | 池 max=1/多连接、并发 A/B、提交/回滚、savepoint、超时、断连重试均无上下文残留；普通 app 无 DDL/TRUNCATE/角色提升权限 |
| 分享 | 同客户跨 team、跨客户已发布指定版本、草稿、其它版本、allow_external、撤销、安装、冻结 manifest；不暴露源组织私有信息 |
| 身份与平台 | 客户目录不能枚举全局账号；客户管理员不能读全局认证事件；平台支持授权限客户限时；原生 admin reset 只修改合格平台账号且留审计 |
| worker/CLI | 队列 claim、重试、取消、归属失效、Bearer/Cookie、当前会话、客户选择与幂等键不交叉；代理仍只主动出站 |
| 附件与快照 | 文档图片、原型文件、对象存储 URL、图与 manifest JSON 的嵌套内容不跨客户；不能只测关系行 |
| 可观测与容量 | EXPLAIN 无意外全表扫描；列表 count 与内容在同一授权边界；日志、错误、指标、缓存 key 和搜索索引均包含或限定客户边界，不能泄漏其它客户标识/正文 |

正式切换前应复用现有至少 1108 项基线测试，并以实际本批测试总数为准补齐新增矩阵；本文没有跑完整应用回归，也不把隔离 SQL PoC 计入生产测试完成数。

## 9. 迁移阶段与退出条件

1. **按已确认边界盘点**：采用 ADR-0017 的三项决定，列出现有 team→客户、跨团队项目授权、技能 share、混合审计和 JSON 内容的映射与歧义。客户归属有冲突就保留待处理，不自动搬动数据；此类逐记录归属核实不意味着重新询问产品方向。
2. **角色先分离**：部署/迁移/普通应用/身份控制面分开；运行时验证 current_user、表 owner、rolsuper、rolbypassrls、角色继承和表授权。API 不再使用初始化 PostgreSQL owner。先验证现有业务仍可运行，再进入 RLS。
3. **只扩展数据**：新增 tenant/tenant_members 与可回填客户列，保留旧接口；受控回填、双写比较、复合唯一键/FK 验证与孤儿/越租户巡检。未映射数据不开放给新客户入口。
4. **迁移所有入口**：增加可信客户事务上下文，普通读写、raw routes、后台任务、本机运维和全局目录逐项接线；建立最小授权函数边界。验证共享路径，不以临时 global bypass 解决缺 ctx。
5. **PoC 后逐表启用**：在已完成归属和接线的聚合启用 ENABLE+FORCE，并以实际 app 角色跑完整矩阵；策略变更不是自动具有影子观察模式，观察阶段用双查询/对比记录，不能称已开启 RLS 但不会影响结果。
6. **客户试点与推广**：先少量受控客户验证，再迁移其余聚合。备份/恢复与角色凭据回滚演练完成后，才把“数据库层客户隔离”纳入交付承诺。

任一阶段出现未映射行、查询缺上下文、角色绕过、原共享语义丢失、客户目录泄漏或跨客户可见，即停止推广。不能在生产把 RLS 全关并让多个客户继续共用宽权限池；应暂停受影响客户入口，回到已验证版本/权限配置并修复原因。回滚也要保护已加入的客户数据，不能仅删 tenant 列。

## 10. 已确认的三个产品决定

用户已明确选择三项推荐，已按 [ADR-0017](adr/0017-multi-customer-boundaries.md) 固定。下表是实施约束，不再是待回答的问题。

| 决定 | 已接受的边界 | 对实施的约束 |
|---|---|---|
| 客户与人员边界 | 独立 tenant；一个客户多 team；全局登录用户可作为受邀成员加入多个客户；每请求一个活动客户 | 保留全局账号与多客户邀请，不按 team 重建孤立账号；客户目录、角色、会话客户选择分别收口 |
| 跨客户交付 | 保留显式、逐版本、经接收方确认的跨客户技能授权；其它客户数据不因共享技能自动开放；不默认新建公开市场 | 源发布与目标接收分别记录；切换前完成旧 share/安装的确认或可核实迁移凭证；不静默撤销、补签或删除冻结证据 |
| 平台支持访问 | 平台日常元数据运维；客户正文访问采用限客户、限时、附原因的支持授权；客户管理员不是 is_system_admin | 客户管理员与平台角色拆开；支持授权覆盖正文 API、SQL、附件与导出，默认无全客户正文读取权 |

本次交付仍只有评估、实验与决策记录，没有客户实体、RLS policy、数据库角色配置或租户请求接线。后续实施遵守已确认边界，并持续保护现有应用权限与共享语义。

## 11. 后续可评审子批次

每项单独形成实现范围、迁移/回退说明与行为证据；子批次编号是后续工作清单，不表示本次已开始修改代码。

| 子批次 | 可评审交付物 | 验收门槛与依赖 |
|---|---|---|
| C-04.1 客户事实与映射 | tenant/tenant_members、邀请和客户角色设计；现有 75 表、team、外部项目成员、全局身份与混合审计的逐记录归属计划 | team 属一客户、用户受邀多客户；歧义行有待处理清单且不猜测客户。先通过 schema/API 设计评审，再写展开迁移 |
| C-04.2 数据库权限分离 | owner/migrate/app/身份入口/调度/运维的最小角色与部署凭据配置；现有查询路径清单 | 真实 app 非 owner、非 superuser、非 BYPASSRLS，不继承 owner；API 无迁移凭据；迁移、恢复、探活均通过受控入口 |
| C-04.3 可信上下文 PoC | 客户选择验证、事务入口、签名上下文或受控客户角色凭据代理的技术比较与最小验证 | 不只测试“漏 WHERE”；任意覆盖 tenant/principal GUC 也不能伪造已授客户身份。池复用、回滚/savepoint、并发及过期票据测试通过 |
| C-04.4 核心聚合试点 | teams/projects/features/tasks 及必要成员表的 tenant 双写、复合 FK、受控 API/原生 SQL 访问 | C-04.1～3 完成；旧数据映射可核实、客户端不能改 tenant、同客户 ACL/并发版本不退化，跨客户读写/FK 均拒绝 |
| C-04.5 身份与支持控制面 | 客户目录/邀请搜索、客户管理角色、平台元数据视图、支持授权和审计出口 | 普通客户不能枚举全局人员或登录事件；支持正文访问需客户/到期/原因，且附件、导出、SQL 和缓存都受同一授权边界约束 |
| C-04.6 技能交付桥 | 源客户逐版本发布授权、目标客户接收确认、安装/撤销/冻结副本的类型化状态与迁移凭证 | 草稿和其它版本不可读；源 team/成员不跟随开放；旧跨团队合作先分类为同客户或跨客户，不静默删 share 或虚构接收动作 |
| C-04.7 后代与后台入口 | 第 3 节其余表、JSON 内容、worker/agentd/CLI、本机运维、幂等键与混合审计补齐 | 每个租户业务入口只能使用已验证 tx；跨客户队列调度投影不含正文；任务重试与完成写回重新验证；回执键包含客户 |
| C-04.8 逐表启用与交付 | 对已完备聚合执行 ENABLE+FORCE、客户试点、全套权限/容量/恢复回归与运行观测 | 原始 SQL 与真实 app 角色同时验证；备份/回滚演练和共享矩阵通过后再扩面。只有此门槛通过才声明对应范围 RLS 已上线 |

这些工作可按依赖并行准备设计，但 C-04.3 的可信身份边界、C-04.6 的接收确认和实际数据映射不能用“临时全局可见”跳过。若发现歧义或运行问题，停在对应小范围技术/数据审查，不重问已接受的三项产品决定。
