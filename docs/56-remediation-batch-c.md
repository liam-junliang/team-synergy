# 批次 C：数据完整性

## 施工计划

### C-04 共库多客户隔离评估

用户已确认多个客户共用数据库。本项只评估，不创建 RLS policy、客户实体或迁移：核查真实用户/团队/项目/技能共享边界与数据库访问路径，分类全部现有表；设计独立客户实体、成员映射、应用/迁移角色、事务内租户上下文、后台任务与本机运维隔离方案。结合 PostgreSQL 官方规则给出最小 PoC、迁移阶段、回归矩阵；用户已确认独立客户/多客户身份、显式版本交付和受控支持访问三项推荐，记录于 ADR-0017 与 `57-multi-tenant-rls-assessment.md`，产品边界已定而 RLS 尚未上线。应用权限与既有共享语义保持不变，未完成租户归属盘点前不启用策略。

源码只在 team-synergy 调整；验证后备份并同步 runtime/service，不修改 user-space。延续批次 B 的 1108 项测试基线与所有 S-01～S-10 守恒项，不改历史迁移或引入依赖。

1. C-02：先梳理真实关系并建立只读孤儿巡检，覆盖可空弱引用和跨项目不一致，提供服务器本地 JSON 命令与 CI 门禁。运行库先只读盘点，不自动删除或伪造父记录。
2. C-01：核心五项外键用 NOT VALID 加约束、确认/处理存量一致性后 VALIDATE，ON DELETE RESTRICT；更新软引用 ADR 的适用边界，覆盖孤儿插入及被引用父记录删除拒绝。
3. C-03：audit_events、tasks、projects 先扩展类型化时间影子列和双写，回填并验证 ISO 8601 及镜像一致性；保留回退能力，满足双写验证后再切换读取/收缩。任何删除旧列都须有真实双写验证记录，不能在一次迁移中假装经过观察。
4. C-04：用户已确认共库多客户及三个推荐产品边界，本批完成 75 表评估、隔离 PoC 和 ADR-0017。实际 tenant/角色/事务上下文与 RLS 按 57 文档的 C-04.1～8 子批次推进；评估通过不等于数据库隔离已上线。

为避免并发改写迁移，先分配迁移序号与文件所有权。按项独立提交，最终 build/typecheck/lint/migration:check 和完整串行回归通过后再部署。

## C-02：只读关系巡检施工计划

先用真实 PostgreSQL 回归锁定只读、可空引用、孤儿及跨项目/团队不一致语义，再实现固定关系目录和单次一致快照计数。覆盖每个 bigint 实体引用，多态 audit/entity、ownership/skill scope 等用显式 discriminator 规则；允许空引用，不猜测实体类型或自动修复数据。

本机命令必须显式 TSP_DATABASE_URL，关闭自动迁移，仅输出固定关系名与计数，孤儿或连接/超时错误非零退出且错误脱敏。巡检事务 REPEATABLE READ READ ONLY，设置 statement/lock deadline，总目标 10 秒内。CI 创建独立临时数据库并播种正常跨域关系，真实运行命令；另造孤儿验证失败门禁，不在全套测试 TRUNCATE 后对空库宣称通过。

## C-01 外键施工小计划

1. 用真实 PostgreSQL 回归先固定五条核心父子链：旧版本完整 fixture 升级后数据不变；孤儿插入和被引用父删除拒绝（23503）；存量孤儿使迁移中止且不删行、不补假父。
2. `0048_core_foreign_keys_expand` 先逐关系只读计数并确认约束形状，幂等安装五条 `NOT VALID` 外键；`0049_core_foreign_keys_validate` 再盘点并验证。两文件均可手动重跑。
3. 外键使用 `ON DELETE RESTRICT`、`ON UPDATE NO ACTION` 和 `DEFERRABLE INITIALLY IMMEDIATE`。允许事务内显式延期插入检查；RESTRICT 删除仍即时拒绝，业务必须先处理子项。
4. Schema 仅补五个具名外键；延迟属性由显式 SQL 迁移维护（当前 Drizzle builder 无该属性）。ADR-0015 限定软引用边界，保留应用权限、审计和跨项目语义检查。
5. 独立数据库 `15432/c_fk_test` 跑幂等、catalog、升级与失败路径，执行 build/typecheck/lint/migration:check。父代理只读盘点运行库、处理 fixture 和部署，子代理不自动修复真实数据。

## C-03 核心时间测试夹具修正小计划

只检查 application、core-api、cli 测试实际写入 `projects.created_at`、`tasks.created_at`、`audit_events.timestamp` 的夹具和对应 helper 默认值。把非法 `t0`、`t1` 等占位改为稳定 ISO 时刻，保持先后顺序；对应精确返回值断言同步保留，其他表及非时间占位不改。使用专用数据库串行运行受影响测试，不修改产品代码或共享测试库。

## C-02 验证记录

已实现固定目录 380 条检查，覆盖 Drizzle schema 的全部 bigint 实体引用，并对可空引用、多态 audit/entity、技能/所有权作用域和跨项目结构建立显式规则。运行事务为 REPEATABLE READ READ ONLY；总 9 秒 watchdog、服务端 statement_timeout 和 1 秒 lock_timeout；命令只输出固定关系名、计数和耗时，错误脱敏且不自动迁移。`total_orphans` 是规则违反次数，一行违反多规则会多次计数。

独立新建并回收临时 PostgreSQL 数据库：正常 fixture 0 违反；5,001 条任务的 380 条检查耗时 173 ms；真实 DDL 锁阻塞在 lock_timeout 内失败；跨项目且跨团队引用、可空引用、已知孤儿、多态未知类型和真实 CLI 正/反门禁均通过。CI fresh populated fixture 246 ms，正常通过、注入孤儿拒绝。专项 persistence 5/5、CLI 1/1（含 transport 总 deadline 销毁回归）；ESLint、两个包 build/typecheck、逐文件 diagnostics 通过。

例外：不强加项目成员/owner 的团队成员关系；技能保留已有跨项目/团队共享语义；不可变 JSON 快照、manifest 和文本 code 不是 bigint 实体引用，不猜测、不重写；audit null 历史 entity_id 允许，非空未知 entity_type 单独计数。生产盘点由父代理只读执行，任何历史硬删除审计记录只报告、不补造父记录。


父代理运行库只读复测：380 项检查耗时 369 ms，total_orphans=0；首次发现的 47 条 intake_batch 是目录漏映射，已通过显式映射及真实/源码回归修正，未改动生产数据。

## C-01 与 C-03 交付范围

核心五条外键分别由 0048 展开、0049 验证，运行库 convalidated=true，删除规则 RESTRICT。专项覆盖旧库升级、幂等重跑、错误形状、孤儿插入/更新和父删除拒绝，以及显式延迟插入；不自动删除孤儿、不补假父。

0050 的时间展开版已先行发布，保留三列原始文本及应用读写，持续触发器镜像为 timestamptz。后续 0051 独立切换同名字段：projects.created_at、tasks.created_at、audit_events.timestamp。这是三张核心表的全部事实时间列；其它表继续按批次推进，新表使用 timestamptz。字符串 API 保持，输出改为规范 UTC，至少三位小数并保留六位微秒；原偏移文本格式不再保持，原始文本由切换前备份保留。

0051 在同一事务中锁表、重查镜像和范围、切换列、设置 now()/NOT NULL/有限范围检查、移除双写触发器并保留时间索引；锁超时或异常全量回滚。非空旧库必须有前一已提交事务的 0050 记录，不能同事务展开/收缩。旧部署不能直接跳到 0051，应按 runbook 先发布包含 0050 的版本。空库可直接初始化全量迁移。

## 时间双写与恢复证据

展开版源提交 a8ce425，运行库于 2026-10-23 17:04:01 与 17:14:34（Asia/Singapore）两次核对：projects=3、tasks=64、audit_events=859；三列空镜像和时刻差异均为 0。该区间未观察到这些表新增记录，不声称存在真实用户写流量。原始记录见 [展开回执](evidence/c-time-expand-20261023.json)。

展开前备份 team-synergy-20261023-170104-705.dump，1,719,500 字节且 pg_restore 目录校验通过。备份实际迁移头为 0047（47 条记录），包含 C-01/0050 之前的数据。在隔离 PostgreSQL 16 私库恢复后，真实执行 0048/0049/0050 并提交关闭，再独立执行 0051：恢复 1747 ms、展开迁移 75 ms、切换迁移 30 ms。全部 926 行非目标时间业务字段和精确 epoch 前后相等，三表 ORM 微秒插入/更新及回滚通过，私库已删除。隔离写入不是生产流量；见 [恢复回执](evidence/c-time-restore-20261023.json)。

时间专项测试覆盖微秒/偏移/纯日期、无效日历/相对/无限/无时区值、直接篡改影子列、异常镜像阻断、同事务跳过展开期拒绝；12,000 条历史记录/表加近期记录，三表时间区间查询在未禁用 seqscan 时自然选中索引。历史升级用例通过真实两阶段 migrator 验证，保留正文、公开编码、关系、修订和原时刻的精确断言。

独立审查在真实 PostgreSQL 复现非 ISO DateStyle 的读取失败；已在连接启动选项同时固定 UTC 与 ISO,MDY，并以数据库默认 SQL,DMY / Pacific/Auckland 验证新库初始化及微秒读取。时间专项最终 7/7。审查另用旧视图依赖制造 DROP 失败：迁移回滚后原文本、影子列和双写触发器完整恢复，随后继续双写成功；未用 CASCADE 绕过依赖。无剩余阻断项。

## 验证记录与边界

展开版 build/typecheck/lint/migration:check 通过；完整串行重跑 1121 项，1119 通过、0 失败、2 项既有本机跳过。第一次完整运行遇到 agentd 输出快照用例状态等待超时；原超时和断言未改，隔离连续三次及 agentd 全套均通过，之后完整重跑通过。未复现根因，不把潜在并发窗口写成已确认缺陷。

切换版代码提交 74c3094。最终 build/typecheck/lint/migration:check 全部通过；lint 0 错误、70 个既有告警，迁移策略 51 文件及 3 项政策测试通过。最终完整串行回归 **1126 项：1124 通过、0 失败、2 跳过**（Windows symlink 权限和可选真实 DSH）。CI populated fixture 的 380 项检查 184 ms，正常零违反通过，主动注入孤儿后按预期非零退出。没有引入新依赖；复用既有 openDb/migrator、CLI 接线和数据库触发器边界，切换后删除过渡列、解析函数与双写触发器，不保留并行时间源。

复现入口为 `pnpm -r build`、`pnpm -r typecheck`、`pnpm lint`、`pnpm migration:check`、设置专用 TSP_TEST_DATABASE_URL 后 `pnpm -r --workspace-concurrency=1 test`、`node scripts/check-orphans-ci.mjs`。本机 NODE_USE_ENV_PROXY=0；测试日志在忽略的 tmp/c-contract-final-*，安全回执在 evidence 目录入库。所有破坏性 fixture 使用隔离测试数据库，运行库只做部署迁移与只读核对。

## 运行环境验收

2026-10-23 17:31 停服后，先记录切换前事实摘要并生成 team-synergy-20261023-173119-461.dump，1,731,186 字节，pg_restore --list 再次校验通过。随后通过既有 deploy-runtime 脚本同步、冻结安装、构建、显式迁移并启动；服务关闭自动迁移。源码目录为 `F:\workspace\team-synergy`，运行目录为 `F:\workspace\team-synergy-runtime\team-synergy-service`。

17:31:58 的切换回执确认三列物理类型为 timestamptz，均 NOT NULL/default now()；影子列已删除，四项时间索引存在，迁移头 0051（共 51 条）。全部 926 行的非时间业务字段与精确 epoch 组合摘要与停服前逐表完全相同，见 [切换回执](evidence/c-time-cutover-20261023.json)。75 张业务表、5 条 VALIDATED RESTRICT 外键；只读巡检 380 项、440 ms、0 违反。

运行目录与源码的 539 个受控源码/配置文件逐字节一致。API 8080 与 Web 5173 监听进程均来自运行目录；/health、/ready、Web、/api/ready 均 200；匿名会话/安全接口 401，既有 CLI Bearer 200，普通成员访问 metrics/audit/security 管理接口 403。安全响应头、CSP 报告模式及超大认证体 413 envelope 保持通过。

`team-synergy-user-space` 未修改。专用 C 测试容器及其测试数据卷已删除；真实数据库、运行服务和收缩前备份保留。剩余限制：其它聚合时间列尚未迁移、大表容量/持续写入压力未验收、RLS 尚未实施、完整 CSP 观察期未结束；不将这些范围算作已完成。

本批提交：2046a89（核心 FK）、33a2881（RLS 评估）、9f8a790（合法时间夹具）、e39747e（时间展开）、76df234（客户边界决定）、a8ce425（关系巡检）、74c3094（时间切换）。文档与回执后续独立提交，工作区收敛后进入 C-04.1 客户事实与映射。

C-04 完成评估、12 项隔离数据库机制实验和已接受 ADR-0017；独立客户、多团队、多客户邀请、逐版本接收确认及限时支持授权均是后续实施约束。当前没有 tenant schema、业务 RLS policy、运行角色分离或客户事务接线，不能声明数据库多客户隔离已上线。下一项按 57 文档 C-04.1～8 推进；B-01 完整 CSP 继续报告观察，最早 2026-10-30 复核，不因本批结束自动强制。

