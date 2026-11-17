# 整改执行记录

## 执行边界与顺序（2026-10-23）

先完成 E-02 的文档版本控制前置项，再执行 A-01 至 A-06；不扩展至 B–F。
已有未提交功能先从开工时捕获的补丁与文件清单重建为独立基线提交 `bb80f91`（129 文件），不包含本轮整改。随后 A-01 至 A-06 分项提交，保留可回溯的施工前状态，不重写历史。

## 施工计划

1. E-02：取消 docs 忽略，保留现有文档与 ADR，补 superseded_by 字段和收敛策略。
2. A-01：先锁定任务权限/设备可见性回归，再消除 N+1，增加有界分页、稳定排序和查询索引，前端按项目读取。
3. A-02：先锁定并发行为，再将全局常量锁改为聚合级锁，保留冲突/审计语义。
4. A-03：认证节流、哑哈希、口令上限、持久失败计数与锁定审计；保护 CLI 设备登录。
5. A-04：独立 liveness/readiness、迁移版本校验、信号关闭和安全启动错误。
6. A-05：共享迁移路径与显式迁移命令、禁自动迁移的部署配置、多阶段容器和 compose。
7. A-06：备份/保留脚本、恢复演练、运维 runbook；同步运行副本前备份。

## 验证规则

不删除测试或放宽断言；不新增路由 SQL 或全局锁键。独立测试数据库串行跑数据库用例，避免相互清表。构建、类型检查、lint、全套测试后同步 service 并验证 /health、/ready 与 Web；user-space 不镜像。Docker、性能或演练未完成的验收必须保留为部分完成。

## 已取得的验收证据

- E-02：文档基线提交 `21c33f6`，所有历史文档可追踪；旧架构声明仍待 E-01 校正，不静默改写。
- A-01：真实 Bearer HTTP，40 项目/5000 任务，`/tasks?limit=50` 共 8 次 DB 查询、16,283 字节；EXPLAIN 使用 `idx_tasks_created_id`。设备 1 台和 31 台均 7 次查询。新增非法/越界页、权限、完整 graph、CLI/Web 翻页回归。
- A-02：100 项目并发事务全部成功且无单一锁等待链；基线/文档同版本并发冲突保留 409。应用及 13 张材料表触发器共同迁移；ADR-0011 记录聚合与有序预锁规则。评审发现 ownership/管理员修改的锁序倒置，新增真实数据库屏障复现后修复；成员与团队治理统一参与栅栏。
- A-03：12 次错口令前 5 次 401，第 6 次起 429，包含 Retry-After；跨 API 实例共享 IP/账号限额。20 次中位数已知 56.5 ms、未知 52.8 ms，差 3.7 ms。登录失败/锁定计数持久化，已知账号失败写 user.login_failed；未知账号只保留哈希配额，未伪造审计 principal。无新依赖。
- A-04：readiness 校验 DB 与迁移 head/hash；停隔离容器 DB 后 health=200、ready=503。pg 空闲连接断开曾导致进程退出，故障注入发现后补连接池 error 处理与连接超时，再测通过。容器 SIGTERM 正常退出码 0；真实 Fastify 在途请求完成；缺库启动退出 1 且仅一行安全原因。
- A-05：多阶段构建，API 256,044,503 字节（<400 MB），Web 67,112,337 字节，API uid=1000；检查镜像无 .git/docs/tests。隔离 compose 的 migrate 退出 0，API/Web readiness 200；删除本次专用数据库卷后重新启动仍成功。生产 API 明确关闭自动迁移。容器不含 Codex，系统 Agent 需单独安装配置。
- A-06：2026-10-23 从运行库备份后恢复到全新隔离库 `team_synergy_restore_drill_20261023`，73 张表共 2000 行和 43 条迁移记录逐项一致；备份+恢复耗时 4.45 秒。备份位于 runtime/backups，未覆盖原库。保留策略实测 3 次备份保留 2 份，失败归档用 .partial 不计入有效备份。

## 边界与限制

- 只完成文档前置项及本轮 A；B–F 的其它任务未纳入。RLS 保持待决策。
- 原始 tracked 补丁和 untracked 清单保存于忽略的 tmp/pre-remediation*，据此重建独立基线 bb80f91；本轮整改与既有功能分开提交。E-10 的 PR、tag、发布流程尚未纳入本轮。
- 项目材料直接 SQL 多行写入须先按 ID 排序取得项目 fence；逆序原始 SQL 可能被 PostgreSQL 死锁检测中止，不能宣称任意 SQL 永不死锁。
- 恢复耗时仅为本地小库演练，生产容量应独立演练；RPO≤24h/RTO≤30min 是目标。
- lint 保持既有 70 warnings（0 errors），不在 A 批次擅改 E-09 的后续治理范围。

## 最终门禁与部署

- `pnpm -r build`：9 workspace 全部通过。
- `pnpm -r typecheck`：全部通过；`pnpm lint`：0 errors、70 既有 warnings；`git diff --check`：通过。
- `pnpm -r --workspace-concurrency=1 test`：1063 个测试，1061 通过、0 失败、2 个既有条件跳过（Windows 无符号链接权限、未配置真实 DSH）。使用专用 Docker PostgreSQL 15432，库名保持既有安全断言要求的 team_synergy_test；未修改这些断言。
- 施工前基线 `bb80f91`；A-01 `7bae5f2`；A-03 `4ce3490`；A-02 `67e0a7d`；A-04 `2c70cf0`；A-05 `98bbf01`；A-06 `e227444`。迁移相关提交依照 0044→0045→0046 顺序登记，避免中间版本漏迁移。
- 新增源码/测试及修复详见各分项提交；最终 apps/packages TS/TSX 共 246 个文件、74 张表、46 个 SQL 迁移。新增时间字段使用 timestamptz。
- 已在部署前强制备份，再同步到 runtime/team-synergy-service，完成独立迁移并启动。runtime/start-service.ps1 显式关闭自动迁移并探测 /ready；README 更新为备份部署入口。
- 实测 8080/health、8080/ready、5173/ 和 5173/api/ready 全为 200；8080 与 5173 监听进程路径均指向 team-synergy-runtime/team-synergy-service。user-space 未修改。
- 部署后再次从当前运行库备份并恢复到全新隔离库 team_synergy_restore_drill_post_a：74 张表、2000 行、46 条迁移记录逐项一致，迁移 hash readiness=true，备份+恢复 2.80 秒。
- 隔离 compose 验收容器及专用数据库卷已清理；生成的镜像保留，可用于后续部署评审。

下一批按原清单顺序进入 D（优先 D-03），然后 B、C、E 的其余项；C-04 仍需产品决策，本轮没有提前实现。


续批：批次 D 已完成，记录见 [54-remediation-batch-d.md](54-remediation-batch-d.md)，下一批进入 B。
