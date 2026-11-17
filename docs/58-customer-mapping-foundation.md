# C-04.1：客户事实与映射基础

- 日期：2026-10-23；依据 ADR-0017、57 评估第 11 节。
- 本批交付：75 表归属目录、服务器本地只读盘点命令、历史映射模板、tenant/member/invitation 的 schema/API 设计及独立审查。
- 本批不执行客户归属回填、授成员资格、技能接收确认、数据库角色变更或 RLS。没有可核实的客户事实时保留 pending，不创建默认客户。

## 实施与验证计划

1. 先检查真实 team/project/member、技能交付、回执和审计写入路径；复用 57 的 75 表分类，不重新把团队解释成客户。
2. 新增 `db:plan-tenants`，显式连接串、migrate:false、单连接 REPEATABLE READ READ ONLY。只输出固定表名/计数、公开编码和允许的角色/版本；不输出账号、姓名、正文、manifest、回执 JSON 或凭据。
3. 先运行既有巡检测试，保护事务/9 秒 deadline/连接销毁语义，再把相同边界抽成内部只读 snapshot helper 供两命令复用。保持既有 CLI 错误契约与全部断言。
4. 核对精确迁移头、75 表/列目录、SELECT 权限和 RLS 状态；未来 schema/RLS 未适配时停止，不用被策略隐藏的 0 行证明完整。分页上限溢出失败，不静默截断桥接关系。
5. 用独立 PostgreSQL 建立同团队/跨团队技能、外部成员、失效引用、非法版本、混合审计和不可猜测回执 fixture；未知表/新列、RLS、锁超时、权限不足均拒绝完整报告。所有归属/接收决定默认 pending，`ready_for_backfill=false`。
6. 独立设计审查通过后再写任何展开迁移；本批先交付可核实的事实和设计。完成 build/typecheck/lint/migration policy、完整串行回归，备份后同步运行目录并只读盘点；user-space 不改。

## 已知历史映射事实

运行库只读观察到两个团队和三个项目。用户已确认 TS Team 与“测试团队”同属一个客户，并授权代理自行命名；客户意向名称为“协同示范客户”。见 [映射意向](evidence/c041-customer-mapping-intent.json)，本批未创建 tenant 或执行回填。该人工确认不同于从共享账号、owner、团队名称、相似正文或引用图推断归属。外部项目成员仍须独立确认受限客户成员资格，现存协作授权不能被静默扩大或撤销。

## Schema/API 设计

本节为后续展开的候选设计，本批不创建表或开放 API。客户实体独立于 team；账号保留全局身份；所有新事实时间列采用 timestamptz。客户管理员不复用 is_system_admin，tenant 角色不自动授予私有 team/project 权限。

| 对象 | 候选字段与约束 |
|---|---|
| tenants | bigint identity id、20 位公开 code、name、status(active/suspended)、owner_principal_id、revision、created_at/updated_at。Owner 以此列为唯一事实，必须关联本客户 active 成员；不能仅凭全局管理员标记取得客户 Owner。客户创建由独立平台控制面受控执行，支持人员不是默认客户正文成员 |
| tenant_members | (tenant_id,principal_id) 主键；role(admin/member/guest)、status(active/suspended/left)、revision、joined_at/updated_at/ended_at/ended_by。引用全局账号，历史成员不硬删；Owner 从 tenants 读取，不重复存 owner 位。客户资格只是外层边界，guest 仅保留明确授予的协作权限，admin 只管理资格/治理，不直接读取所有私有项目 |
| tenant_invitations | id/code、tenant_id、target_account_normalized、proposed_role、invited_by、created_at/expires_at、status(pending/accepted/declined/revoked/expired)、resolved_at/resolved_by、request_key/request_hash。pending 唯一范围(tenant_id,target_account_normalized)；请求键唯一范围(tenant_id,invited_by,request_key)。目标账号是秘密控制面字段，客户目录和诊断不得原样导出 |
| teams.tenant_id | 展开期 nullable、无默认客户；只允许经过核实的 team→tenant 映射回填。后续收紧并建 UNIQUE(tenant_id,id)、复合 FK；现有项目从 team 推导，拒绝客户端自报归属，不允许普通 UPDATE 搬迁客户 |

guest 不创建 team、不管理客户资格、不浏览完整客户目录；既有明确 team/project ACL 可以授予读写，guest 不自动降成项目 Viewer。当前 `users` 只有全局唯一 account，没有 verified email、自助注册或邀请系统；现有入口直接按 user_code 加 team/project 成员。最小邀请采用本人登录后的私有收件箱：按认证账号 trim/lowercase 匹配目标并显式接受，不发送邮件、不自动建账号，不把 account 当成邮箱或把公开 code 当 bearer 秘密。未知账号、已禁用账号、已存在账号的发起响应均同形 202；发起方不会获知是否存在或是否投递。

| 候选 API | 契约 |
|---|---|
| GET /me/tenants | 本人有效客户和成员 revision；不返回全平台客户/账号目录 |
| GET /me/tenant-invitations | 仅按真实登录账号匹配本人的 pending 邀请；必要客户名称与角色，不返回其它目标账号 |
| POST /tenants/:tenant_code/invitations | account/role/request_key；先验证活动客户及治理权限，普通 admin 可邀请 member/guest，只有 Owner 可任免 admin。存在性无差别 202；同请求键不同 payload 409，不返回全局 user_code 或投递状态 |
| POST /tenant-invitations/:code/accept 或 decline | 仅真实目标账号；客户端不得覆盖 principal/role/tenant。行锁与到期/撤销竞争，重试返回同一终态；成功只建立客户资格，不自动加 team/project 或切换其它标签页 |
| POST /tenants/:tenant_code/invitations/:code/revoke | 本客户授权操作者；接受、撤销和过期在同一行锁边界串行，写一次审计 |
| GET /tenants/:tenant_code/members/:user_code/removal-impact | 仅客户治理权限，范围严格限定本客户。返回 Owner、未完任务/运行、待转移等阻断计数，不曝光其它客户活动 |
| PATCH /tenants/:tenant_code/members/:user_code | role/expected_revision；仅 Owner 可任免 admin，不直接修改 Owner。重新验证资格及并发 revision，写审计，不通过接受旧邀请提升已有成员角色 |
| POST /tenants/:tenant_code/ownership-transfers；POST .../:code/accept 或 cancel | 当前 Owner 发起、active 且非待注销的接收者本人接受，或原发起人取消；限时、单 pending、两阶段行锁与当前 Owner/成员重查，审计及幂等收据。现有 ownership API 只支持 team/project，本项须在 C-04.5 独立实现 |

邀请接受事务重新核实客户状态、账号状态、期限、邀请发起者当下治理权限和成员状态；不能用旧邀请覆盖现有 active 成员角色或恢复 left 成员的旧项目权限。到期 pending 在创建事务里转 expired 再插入，不使用依赖 now() 的部分唯一索引。客户 Owner、成员资格与邀请变动按统一锁序串行；后续须确定具体锁序并跑接受/撤销/角色变更/退出并发回归，不能只靠邀请行锁证明授权竞争安全。全局账号锁后按客户 id 升序、客户/成员锁后邀请锁，是候选顺序，须与现有 team/project/用户锁逐路径核查后才实施。

仅 pending 可以转 accepted/declined/revoked/expired；同动作重试返回原终态收据，不重复审计、不重建成员，已接受邀请即使成员后来 left 也不能重新激活。接受和撤销并发仅一方成功，另一方冲突；撤销 accepted 邀请不能隐式移除成员。

退出/移除先核实本客户 Owner、team/project Owner、未完任务、active/preparing/suspended Run 与待接收所有权，阻断返回 409，先交接再最终化。最终化将成员置 left、撤销该客户的有效权限及邀请，保留历史主体/证据。不能复用会撤销所有全局设备的账号注销来退出一个客户；重新加入不恢复旧授权。后台租约/执行写回必须接入客户撤销边界后才开放最终退出功能。

每个标签页 URL 明确 tenant_code，每次请求验证该客户；不新增会被标签页共享覆盖的单一 activeTenant Cookie。缓存键包含 principal/tenant/权限 revision，revision 用于授权重查或乐观并发前置条件；幂等收据仍使用稳定(tenant,actor,operation,request_key)作用域，邀请对象内部 operation 固定可省略，不能把权限 revision 加入唯一键使网络重试变新操作。客户资格失效为 403，不能触发现有 401 的全局退出。并发标签页允许同一账号处于不同客户，旧响应不能覆盖已切换客户视图。

设计依据：`user-use-cases.ts:24,82,145`（全局账号/目录）、`routes/teams.ts:50`、`member-use-cases.ts:28,43`、`project-access.ts:41`、`team-use-cases.ts:193`、`ownership-use-cases.ts:226`、`web-session.ts:74`。当前全局目录仍存在，不因本批提供设计就声称已修复；C-04.5 需收口所有目录/直接加人/UI 路径及支持授权，C-04.3 接可信上下文，C-04.4 接复合归属约束，C-04.7 接 worker/租约撤销。

## 盘点命令与映射口径

服务器本机显式配置 TSP_DATABASE_URL 后执行 `tsp db:plan-tenants`。无自动迁移、无 HTTP、无 apply/assign/invite/accept 分支。stdout 为 JSON envelope；`ok=true/read_complete=true` 仅表示固定目录和元数据读取完成，**不代表客户已确认、内容已审查、可执行迁移或数据库隔离已经生效**。状态始终 pending，tenant_id=null、ownership_complete=false、ready_for_backfill=false。

目录覆盖 75 表且每表只列一次，按全局控制面、团队治理、直接项目、项目后代、技能桥、命令回执、混合审计分组。表/列集合、精确迁移头、SELECT 权限、RLS 状态不符就失败；每类实体/桥最多 5,000 条，超限拒绝，不用分页遗漏来生成完整报告。读取使用单连接 REPEATABLE READ READ ONLY，总 9 秒截止时间、1 秒锁时限。未知表、缺列、权限/RLS、连接、锁、传输截止时间均不输出成功报告；错误不含原始 SQL/连接串。

输出仅包含表名和计数、team/project/skill/share 公开编码、修订号、开关和固定原因桶。缺失作用域、非法/未发布版本、缺失安装修订、未知审计/回执分别计入 issues，并持续保留 pending。未知动作/类型不能原样回显。外部项目成员只给计数，不导出用户 code/账号/姓名。团队代码不是客户代码；不同团队不能标为跨客户。

技能 share 列出源与目标团队、指定版本、撤销状态和 allow_external/allow_projects；后两者不是跨客户授权。安装保留停用状态，不能证明接收确认。冻结 manifest、回执 result、审计 payload 和其它 JSON 正文不读取/不输出，统一 deferred，须后续按资源端点、指定修订、内容摘要、客户身份和接收凭证专项审查。`skill.installation_updated` 的源技能实体和目标项目正文分属不同端点，单独列为 bridge_review，不简单归源客户。

fact_digest 绑定本次输出的最小元数据，供复核“看到的是哪次盘点”；它不绑定所有正文、全部成员行或权限变化，不能作为自动 backfill 授权或并发令牌。真正回填必须基于受控映射、记录级稳定事实版本、全父链复核和同事务重查，另行设计，不接受本命令输出直接写库。

历史映射模板由 teams[].team_code/tenant_key/mapping_status/evidence_reference 表达，命令原始输出的 tenant_key/evidence_reference 均空。业务确认另记映射意向，不自动写回数据库或替命令升级 ready 状态；客户归属确认不等于批准历史成员邀请、技能接收或平台正文访问。

## 独立审查与回归

设计审查已通过。修正了把权限 revision 混入幂等作用域的矛盾，补齐客户成员角色修改、Owner 两阶段移交、guest 能力与邀请终态；仅批准本批设计/只读规划，不批准 DDL、回填、成员资格或 RLS。现有全局用户目录、直接加人、平台管理员与客户正文边界仍按 C-04.5 收口，不因设计已定而改变交付状态。

代码审查在隔离 PostgreSQL 复现并修复两项问题：验证 public 却可能读取 search_path 中的同名视图；不同缺失技能通过 null 修订键误匹配。当前规划 SQL 全部显式 public，共享只读边界固定 pg_catalog,public,pg_temp，普通与临时视图均不能遮蔽真实数据；缺失技能不参与版本集合匹配，孤儿修订单独计数。新增回归独立复核 2/2，通过。版本 JSON 超过 64 KiB 不读取/解析，转无效版本 pending。

既有 snapshot 两项回归在抽取前后均通过，错误文本与 9 秒包含连接获取的总预算保持；新旧诊断专项 11/11，通过。shadow 回归还向真实 public.features 注入孤儿，确认旧 C-02 巡检在被遮蔽的 search_path 下仍检出，防止复用边界引入假零计数。CLI 缺显式 URL、格式错误及带凭据不可达 URL 均以固定码失败且不泄密；真实 fixture 的成功路径仍明确 ready_for_backfill=false。

所有真实数据库 fixture 使用专用新库并回收，不修改运行数据。覆盖全表目录/未知表和列/迁移摘要/RLS/SELECT 权限/DDL 锁、5,000 关系上限、同/不同团队、已撤销 share、停用安装、非法/未发布/缺失修订、外部成员、混合审计和历史 JSON deferred；测试中的敏感哨兵、账号、用户 code、正文与原 JSON 均不进入报告。

## 最终验证与部署记录

代码提交 2086de7；主要变更为 persistence 的 tenant-inventory/catalog、共享 read-only-snapshot、原 integrity-check 复用，以及 CLI 的 db-plan-tenants 注册和回归。没有新依赖、HTTP 路由、客户迁移或 schema 修改。删除原巡检中重复的连接/事务/总截止时间实现，复用同一边界，同时修复两种诊断的搜索顺序。

build/typecheck/lint/migration:check 均通过，迁移仍 51 个，政策测试 3/3；lint 0 错误、70 个既有告警。完整串行回归 **1134 项：1132 通过、0 失败、2 项既有跳过**（Windows symlink 权限、可选真实 DSH）。最后边界修复后重跑新旧诊断专项 11/11；CLI 专项 3/3。CI 的真实 populated fixture 380 项检查 314 ms、正常零违反通过、注入孤儿拒绝。测试日志在忽略的 tmp/c041-*；不降低或删除原有断言。

2026-10-23 17:58 部署前备份 team-synergy-20261023-175853-929.dump，1,723,329 字节，pg_restore --list 校验通过。沿用 deploy-runtime 的备份、同步、冻结安装、构建、显式迁移和关闭自动迁移启动流程。运行目录为 `F:\workspace\team-synergy-runtime\team-synergy-service`，源码仍只在 `F:\workspace\team-synergy` 修改；本批无新 SQL，迁移头维持 0051。

17:59:40 的运行目录 CLI 验收：[安全元数据回执](evidence/c041-runtime-metadata.json)。75 表、2 团队、3 项目；0 外部项目成员、0 外部项目 Owner、0 技能/share/安装/冻结 manifest/命令回执；859 条审计分为 6 条身份/平台待审、853 条资源/交付待审，未知桶与已检测结构异常均为 0。盘点 234 ms，read_complete=true，但 ownership_complete/ready_for_backfill=false；两支已确认团队均存在，没有额外未核实团队。当前没有技能历史不能替代未来的版本接收测试，fixture 中单独覆盖了非空交付语义。

545 个受控源码/配置文件与运行目录逐字节一致。8080/5173 两个监听进程均来自运行目录；API/Web/ready/proxy ready 均 200；匿名会话/安全接口 401，既有 CLI Bearer 200，普通成员 metrics/audit/security 管理接口 403；原安全头、CSP 报告模式、认证大体积 413 envelope 保持通过。运行目录旧巡检 380 项、392 ms、0 违反。user-space 未修改，专用 C041 测试容器及数据卷已回收，真实运行服务和备份保留。

## 完成范围与下一步

C-04.1 的设计、人工客户意向映射和只读工具交付完成；结构/成员/正文归属回填没有完成，也没有声称能够同时安全承载互不信任客户。当前仍有全局用户目录、宽权限应用数据库身份、无可信客户事务等已登记缺口。

下一批按 C-04.2 分离 owner/migrate/app/身份/调度/受控运维角色与部署凭据，先验证原功能和迁移/恢复，再进入 C-04.3 的可信上下文。客户 Owner/历史成员资格、全部后代父链、JSON/审计证据与未来技能接收须在对应小批次核实；不能将本批意向文件或 fact_digest 直接作为回填 SQL 输入。B-01 的完整 CSP 继续观察，最早 2026-10-30 复核，未因本批部署自动强制。
