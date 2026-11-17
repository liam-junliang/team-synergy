# M13 平台治理与运维：当前代码逆向需求与业务规则

系统管理员管理全局元数据、账号与公开地址，读取脱敏审计和汇总指标；本机维护入口执行受限诊断。客户实体、成员邀请、正文支持授权和数据库RLS仍待实施，元数据盘点不能替代客户授权。普通登录/设备认证归M01。

## 来源与事实级别

run NSG3TKRB16Y9F6Y203WB；snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；显式工作区草稿，基底提交 92728fbec04cfa34fee4421cb0a9319d1b755164。原始源码 manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；图 artifact SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8。UA 2.9.8 与 codegraph 1.6.2 为导航，Skill 2.2.0 提供逆向方法；事实证据均回查同一 snapshot 的原始文件。图谱解释仍为 inferred。

源码证据为 observed_in_code，只证明当前实现；未获业务批准。docs/experiments 只作全局比较材料，不作为本章新增业务能力的语义权威。

## 能力目录

- REQ-INT-M13-01：分页检索全局团队与项目元数据
- REQ-INT-M13-02：附原因修改治理元数据并阻止活动项目被归档
- REQ-INT-M13-03：创建账号并签发受限初始凭据
- REQ-INT-M13-04：禁用与恢复普通账号但不复活旧设备
- REQ-INT-M13-05：以服务器本机命令恢复管理员初始口令
- REQ-INT-M13-06：以CAS管理安全公开地址并向客户端投影
- REQ-INT-M13-07：分页导出固定上界的脱敏全局审计
- REQ-INT-M13-08：提供有权限的汇总指标和最小健康信息
- REQ-INT-M13-09：在服务器本机运行有界只读完整性检查
- REQ-INT-M13-10：输出待确认客户映射盘点而不回填归属
- REQ-INT-M13-11：以精确公共路径分发CLI清单、脚本和包
- REQ-INT-M13-12：在本机校验CLI包并按托管版本安装
- REQ-INT-M13-13：按隐私哈希有界聚合登录安全事件

## 业务规则表

|规则|触发与资格条件|结果/排序/执行约束|例外和保留事项|原始证据|测试断言|
|---|---|---|---|---|---|
|BR-INT-M13-01|active、未注销且非待注销的系统管理员；GET /admin/teams /admin/projects；真实bearer/cookie会话；系统管理员标记有效。|BR-INT-M13-01：全局元数据访问不意味着获得项目正文、代码知识或成员身份。；BR-INT-M13-01：项目成员数按active用户与owner/显式/非private继承关系计数；页总数和游标语义不同。；状态：只读，不改变团队/项目/成员。|业务Owner但非系统管理员或无效管理员→拒绝。；limit非1–200、cursor非法、搜索超200字符→拒绝而不无界扫描。|packages/application/src/admin-governance-use-cases.ts:12–102 @ 5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a；apps/core-api/src/routes/admin-governance.ts:8–23 @ 81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3|REQ-INT-M13-01-AC01：分页保持过滤、稳定游标与正确总数。；REQ-INT-M13-01-AC02：管理员读取索引不自动得到业务正文。|
|BR-INT-M13-02|当前有效系统管理员；PATCH /admin/teams/:code /admin/projects/:code；团队仅改名；项目仅改名称、说明、active/archived及有效base_snapshot；reason非空≤1000。|BR-INT-M13-02：治理接口不更换Owner或添加成员；权限来自实际管理员谓词，不能从错误文字推导。；BR-INT-M13-02：团队更名和项目元数据变更均带原因；只有项目具有此base_snapshot CAS。；状态：项目有变化snapshot+1，状态可active↔archived；无变化不新增版本。|项目旧base_snapshot或活动运行→拒绝归档/覆盖，不中止运行代替。；修改owner/member_policy或其他未允许字段→route拒绝。|packages/application/src/admin-governance-use-cases.ts:105–159 @ 5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a；apps/core-api/src/routes/admin-governance.ts:24–48 @ 81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3|REQ-INT-M13-02-AC01：活动/交接运行阻止归档且不改变任务。；REQ-INT-M13-02-AC02：CAS过期不能覆盖较新管理修改。|
|BR-INT-M13-03|有效系统管理员；users list/create/bind-token/initial-password及user create/list CLI；管理员有效；目标账号存在或新账号规范合法。|BR-INT-M13-03：凭据不是普通用户目录字段，敏感返回不能从全局list读取。；BR-INT-M13-03：create和部分签发路径的业务写入与随后审计并非都同一事务，不能笼统承诺所有账号操作原子审计。；状态：create active+must_change_password；issueInitialPassword更新hash/到期并撤销设备；bind覆盖当前token哈希。|账号重复/格式非法或目标disabled→拒绝对应创建/签发。；对其他系统管理员重置初始口令→拒绝，服务器本机恢复另走受控命令。|packages/application/src/user-use-cases.ts:80–143 @ 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45；packages/application/src/user-use-cases.ts:156–227 @ 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45；apps/core-api/src/routes/users.ts:9–56 @ ee3d01aceaefcbc20e1e57ccd5c00fb178ba25b88e1a613e374456a4386c8e01|REQ-INT-M13-03-AC01：新账号规范化并只在签发响应暴露初始口令。；REQ-INT-M13-03-AC02：管理员不能为另一个管理员重置初始密码。|
|BR-INT-M13-04|当前有效系统管理员；users disable/enable及user disable CLI；目标为普通账号；禁用不能针对自身或任何系统管理员。|BR-INT-M13-04：enable恢复账号资格，不恢复被停用前设备、会话或任务租约。；BR-INT-M13-04：disable路径与enable事务结构不同，不能以一条错误消息当作所有副作用的证明。；状态：active→disabled或disabled→active；enable撤销所有旧设备并清空绑定token。|注销/待注销目标或系统管理员→恢复拒绝；管理员恢复需本机维护。；已active恢复→返回当前状态，不重新激活凭据。|packages/application/src/user-use-cases.ts:231–288 @ 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45；apps/core-api/src/routes/users.ts:29–40 @ ee3d01aceaefcbc20e1e57ccd5c00fb178ba25b88e1a613e374456a4386c8e01|REQ-INT-M13-04-AC01：恢复账号不复活旧设备凭据。；REQ-INT-M13-04-AC02：不能禁用管理员或恢复注销账号。|
|BR-INT-M13-05|有数据库与服务器操作权限的本机维护者；tsp admin:reset-password；显式TSP_ALLOW_LOCAL_ADMIN_RESET=1及本机数据库连接；目标是active且未注销/待注销管理员；本机操作员及主机名非空。|BR-INT-M13-05：本机维护授权不是已认证管理员会话：审计明确auth_method=local_database_operator和actor_authenticated=false。；BR-INT-M13-05：恢复必须撤销并发已批准设备授权，避免旧凭据重新产生会话。；状态：密码更换、must_change_password=true、到期、设备/授权撤销、登录失败状态清理在事务内完成。|普通账号或无效管理员、口令长度不8–128→拒绝，不执行恢复。；数据库错误→返回安全通用失败，不输出连接凭据。|packages/application/src/admin-recovery.ts:15–60 @ dc5d2060d1ebd5e7c6dde92946ce866ef5c327c6edb95108c62b942a0ac19473；packages/application/src/bootstrap-config.ts:3–11 @ 09f3cc7e77292befbf97be3431e37e123c9dc61b7c190f3e890525d365008aa1；apps/cli/src/admin-recovery.ts:1–74 @ 089825b208b9ff52978554256575622bdfb61bd0ef605a60c3faca8151228805|REQ-INT-M13-05-AC01：本机恢复撤销设备及待兑换授权。；REQ-INT-M13-05-AC02：普通用户不能经该维护函数被升为管理员。|
|BR-INT-M13-06|系统管理员编辑；active用户读取客户端地址；GET/PUT admin/settings；GET platform/client-config；真实会话；更新携带两个地址字段与非负base_revision，无未知字段。|BR-INT-M13-06：公开地址配置不是凭据仓库，client-config不泄露管理员修改元数据。；BR-INT-M13-06：相同值更新不增加revision。；状态：单例配置revision+1或no-op；客户端读取无状态变化。|旧版本、非本机HTTP或恶意路径编码→拒绝。；地址null/空→归一为null；不生成危险命令片段。|packages/application/src/system-settings-use-cases.ts:18–112 @ 756216e09750126b02e8af2d917535f45029c83e016ac646b45333434e1d1f47；apps/core-api/src/routes/system-settings.ts:6–20 @ b7b14fe9412a0baf33613e9a3907a5753e0428520506062da853b63534a086ec|REQ-INT-M13-06-AC01：恶意地址无法进入客户端安装命令。；REQ-INT-M13-06-AC02：同值写入不增加版本，旧CAS冲突。|
|BR-INT-M13-07|有效系统管理员；audit:export --since / GET audit/export；真实会话；since格式和真实日期有效，limit1–500，cursor/snapshot为合法大整数ID。|BR-INT-M13-07：快照上界避免新写审计混入同一次翻页；ID排序不等于按timestamp排序。；BR-INT-M13-07：脱敏规则不是客户正文访问授权，也不保证所有任意自然语言正文被语义脱敏；支持授权仍未实现。；状态：只读；不修改或删除原审计。|普通项目Owner或失效管理员→拒绝全局导出。；非法日期/游标/分页→拒绝，不能转无界导出。|packages/application/src/audit-export.ts:1–33 @ 5b1b19f315794fce7a43cc101fa2241113c67b6cc61dee29861ea11f4a3ad7c1；packages/application/src/audit-redaction.ts:1–17 @ e15f66dff49b9263571527f1adada334347663e7cf729f31993873019af6f152；apps/core-api/src/routes/audit.ts:1–19 @ 1cdbfd345d048939290be2017f1bb6f657f0c2b9d964880578b357b5331c4644；apps/cli/src/audit-export.ts:1–29 @ a45f577d9123668f6a5ccf2a417fc5b03495f6bfc74b6d2baee355b947bfc10a|REQ-INT-M13-07-AC01：首屏后的新事件不进入同一snapshot后续页。；REQ-INT-M13-07-AC02：历史嵌套凭据和坏JSON不原样输出。|
|BR-INT-M13-08|系统管理员读metrics；匿名探针读health/ready；GET metrics/health/ready 与CSP报告；metrics需有效会话及系统管理员；匿名接口仅准确白名单方法/路径。|BR-INT-M13-08：指标不含用户、项目标题、指令或正文；成功率衡量生成完成，不等同采用率或业务正确率。；BR-INT-M13-08：API CSP默认report-only，仅TSP_CSP_MODE=enforce强制；HSTS只在实际HTTPS请求设置，不信任转发头。；状态：只变运行指标和有限安全遥测；无业务数据更改。|metrics数据库/采集异常→503；权限不足403，不泄露连接错误。；ready依赖不就绪→503 not_ready，health不据此宣称数据库ready。|apps/core-api/src/metrics.ts:9–66 @ 71530541540cb0c55d057450e4a38c0999ec4ad294c3be04ef29b5c859c3a5be；packages/application/src/operational-metrics.ts:4–15 @ b013f7397b7619494f478578e3b7e4e9d3624816edd80525193d5a910ea6265e；apps/core-api/src/server.ts:166–188 @ 3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada；apps/core-api/src/security-headers.ts:4–33 @ e813b19fa0ef575830b8a47afccb830087f9942d4a8e0e8ad2bd3228f84542d4；apps/core-api/src/auth.ts:25–34 @ 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8|REQ-INT-M13-08-AC01：普通用户看不到全局指标，匿名健康不泄露依赖错误。；REQ-INT-M13-08-AC02：生成率按固定状态口径且不按采用率计算。|
|BR-INT-M13-09|有服务器数据库SELECT权限的运维人员；db:check-orphans；显式TSP_DATABASE_URL；migrate:false，不经HTTP，代码内审阅过的静态关系目录。|BR-INT-M13-09：SQL只读事务是数据库执行约束，不能以CLI描述中的“只读”替代实际事务证据。；BR-INT-M13-09：检查通过只覆盖已审阅规则，不能证明所有嵌套JSON/历史manifest语义或RLS正确。；状态：只读诊断，无业务状态更改。|无显式数据库连接或超时/权限不足→安全失败，不自动迁移或写修复。；检查返回问题→作为诊断事实报告，不推断客户归属。|apps/cli/src/db-check-orphans.ts:1–27 @ bb0f4039d506e49fed236e29e515880982dcc665768dabd306089360d9a869ab；packages/persistence/src/read-only-snapshot.ts:5–35 @ 119e24194766f4055441ee4fddc9964b53b9eb245515db773c9ba4afa2cca6b6；packages/persistence/src/integrity-check.ts:1–100 @ a191fd59036dd1f9ac1891a720fdfd60a8fa3fca1d6c113e34286459142dc1b7|REQ-INT-M13-09-AC01：即使调用角色有INSERT权限，READ ONLY包装事务仍拒绝对普通持久表写入。；REQ-INT-M13-09-AC02：存在已知孤儿时只报告不自动修复。；REQ-INT-M13-09-AC03：连接/查询总期限到达时中止等待并释放或销毁连接。|
|BR-INT-M13-10|有完整读取权限的服务器本机运维人员；db:plan-tenants；显式数据库连接；实际表/列与审阅目录及迁移头完全一致，无启用RLS过滤。|BR-INT-M13-10：read_complete=true仅指所列元数据读取；ownership_complete=false、ready_for_backfill=false、tenant_id=null。；BR-INT-M13-10：当前代码没有由盘点自动创建客户、邀请或限时正文支持授权；RLS是后续设计目标而不是现有能力。；状态：纯只读，所有customer_mapping=pending，不修改team/project/skill归属。|schema漂移、RLS、权限不足、结果超上限或分区不完整→拒绝把局部读包装成完整盘点。；跨团队共享/安装→标customer_unknown和legacy acceptance未记录，不推断跨客户许可。|packages/persistence/src/tenant-inventory.ts:12–53 @ 2f8799e5565966496cc08ef6b737807b0f4b577a9a709e886542427560c3eba4；packages/persistence/src/tenant-inventory.ts:74–157 @ 2f8799e5565966496cc08ef6b737807b0f4b577a9a709e886542427560c3eba4；apps/cli/src/db-plan-tenants.ts:1–26 @ eddd756cfbbb85b73a3e686e5adfac09a10f478dab717b550995154d09dea6bb|REQ-INT-M13-10-AC01：完整元数据读仍保持pending且不声称可回填。；REQ-INT-M13-10-AC02：启用RLS或超过5000行关系时拒绝不完整盘点。|
|BR-INT-M13-11|匿名安装者与平台发布运维人员；GET /cli/manifest.json、install.ps1/install.sh、releases/:file；运维已部署受控distribution目录，manifest schema/version/target/filename/hash元数据合法。|BR-INT-M13-11：匿名分发不开放其他配置/业务API；release route仍严格校验文件名。；BR-INT-M13-11：服务端清单下载检查文件尺寸而非每次重新计算文件SHA，客户端安装负责校验下载字节。；状态：只读分发；不创建用户、项目绑定或运行工作空间。|清单/脚本不可用→503，不暴露本机路径或运行配置。；文件不在清单、尺寸不一致、目录逃逸/链接目标不在目录→404或不可用，不传包。|apps/core-api/src/routes/cli-distribution.ts:7–74 @ dfdd2173753e952b026c73c01780bf2c17879e03a7100743bc078b6e83dcdb41；apps/core-api/src/auth.ts:29–34 @ 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8|REQ-INT-M13-11-AC01：清单过滤缺失包且不泄露任意JSON字段。；REQ-INT-M13-11-AC02：未列入清单或目录外链接不可下载。|
|BR-INT-M13-12|Windows或POSIX本机用户；install.ps1 / install.sh；HTTPS API地址，loopback可HTTP；托管安装目录或新目录，禁止根目录、危险路径与链接。|BR-INT-M13-12：摘要验证先于执行/激活；更新保留版本目录，不改用户项目源码和平台绑定。；BR-INT-M13-12：--no-modify-path/NoModifyPath明确避免持久PATH修改；安装脚本是本机执行代码，平台仅分发。；BR-INT-M13-12：两文件存在检查不证明agentd入口、launcher或依赖齐全；POSIX后续chmod引用launcher可能暴露部分缺失，但不是完整载荷验证。；状态：本机versions/shim/托管标记及可选PATH变化；服务端业务不变。|摘要/长度错误、非托管旧目录、并行安装锁或危险归档→失败，不替换现有可执行版本。；不支持平台/架构→明确失败，不随意使用另一目标包。|scripts/cli-install/install.ps1:1–87 @ 9cab5570cf3f5e30139422f0033324c95925f57ced690dad7a6744b4bc279298；scripts/cli-install/install.sh:1–92 @ edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f；scripts/cli-install/install.ps1:57–72 @ 9cab5570cf3f5e30139422f0033324c95925f57ced690dad7a6744b4bc279298；scripts/cli-install/install.sh:33–40 @ edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f；scripts/cli-install/install.sh:68–80 @ edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f；scripts/build-cli-distribution.mjs:119–122 @ 991f78a2a3371742660b4ea133bc3b812d2564c6802a6c81a4905ba7233fd14e|REQ-INT-M13-12-AC01：摘要不符不替换原CLI。；REQ-INT-M13-12-AC02：穿越或链接归档在解压前拒绝。；REQ-INT-M13-12-AC03：两文件检查通过不能证明已激活agentd可运行。|
|BR-INT-M13-13|有效系统管理员；GET /admin/security/login-events；真实会话；先判管理员再校验查询参数，非管理员不获查询细节。|BR-INT-M13-13：只返回哈希分组与汇总次数，不还原账号/IP；未知IP可为null组。；BR-INT-M13-13：时间过滤使用含起止边界；未传until依据数据库时钟，不能假设与API主机时钟完全一致。；状态：只读安全遥测；不修改用户锁定状态或清理事件。|未知参数、非法时间/哈希或超窗口→400 validation_failed；无效管理员403。；数据库查询错误→503安全通用失败，不暴露原始账号/IP或SQL。|packages/application/src/login-security.ts:12–20 @ ca972cfb9324d1417f4d8dd35e3d6e8ad2df3e471507f5be932f5db9e0761379；packages/application/src/login-security.ts:54–92 @ ca972cfb9324d1417f4d8dd35e3d6e8ad2df3e471507f5be932f5db9e0761379；apps/core-api/src/routes/login-security.ts:6–20 @ 1e39acdcf081953609b64f2916aafb4d1c224bd533ed4bdfa4726bb0496b296c|REQ-INT-M13-13-AC01：默认24小时窗口与确定排序基于数据库时间。；REQ-INT-M13-13-AC02：非管理员的非法查询先返回权限错误。|

## BR → REQ / AC / 验证矩阵

|BR|REQ|Feature|AC|计划状态|
|---|---|---|---|---|
|BR-INT-M13-01|REQ-INT-M13-01|INT-FEAT-M13-governance|REQ-INT-M13-01-AC01|not_run，未来计划|
|BR-INT-M13-01|REQ-INT-M13-01|INT-FEAT-M13-governance|REQ-INT-M13-01-AC02|not_run，未来计划|
|BR-INT-M13-02|REQ-INT-M13-02|INT-FEAT-M13-governance|REQ-INT-M13-02-AC01|not_run，未来计划|
|BR-INT-M13-02|REQ-INT-M13-02|INT-FEAT-M13-governance|REQ-INT-M13-02-AC02|not_run，未来计划|
|BR-INT-M13-03|REQ-INT-M13-03|INT-FEAT-M13-governance|REQ-INT-M13-03-AC01|not_run，未来计划|
|BR-INT-M13-03|REQ-INT-M13-03|INT-FEAT-M13-governance|REQ-INT-M13-03-AC02|not_run，未来计划|
|BR-INT-M13-04|REQ-INT-M13-04|INT-FEAT-M13-governance|REQ-INT-M13-04-AC01|not_run，未来计划|
|BR-INT-M13-04|REQ-INT-M13-04|INT-FEAT-M13-governance|REQ-INT-M13-04-AC02|not_run，未来计划|
|BR-INT-M13-05|REQ-INT-M13-05|INT-FEAT-M13-operations|REQ-INT-M13-05-AC01|not_run，未来计划|
|BR-INT-M13-05|REQ-INT-M13-05|INT-FEAT-M13-operations|REQ-INT-M13-05-AC02|not_run，未来计划|
|BR-INT-M13-06|REQ-INT-M13-06|INT-FEAT-M13-governance|REQ-INT-M13-06-AC01|not_run，未来计划|
|BR-INT-M13-06|REQ-INT-M13-06|INT-FEAT-M13-governance|REQ-INT-M13-06-AC02|not_run，未来计划|
|BR-INT-M13-07|REQ-INT-M13-07|INT-FEAT-M13-operations|REQ-INT-M13-07-AC01|not_run，未来计划|
|BR-INT-M13-07|REQ-INT-M13-07|INT-FEAT-M13-operations|REQ-INT-M13-07-AC02|not_run，未来计划|
|BR-INT-M13-08|REQ-INT-M13-08|INT-FEAT-M13-operations|REQ-INT-M13-08-AC01|not_run，未来计划|
|BR-INT-M13-08|REQ-INT-M13-08|INT-FEAT-M13-operations|REQ-INT-M13-08-AC02|not_run，未来计划|
|BR-INT-M13-09|REQ-INT-M13-09|INT-FEAT-M13-operations|REQ-INT-M13-09-AC01|not_run，未来计划|
|BR-INT-M13-09|REQ-INT-M13-09|INT-FEAT-M13-operations|REQ-INT-M13-09-AC02|not_run，未来计划|
|BR-INT-M13-09|REQ-INT-M13-09|INT-FEAT-M13-operations|REQ-INT-M13-09-AC03|not_run，未来计划|
|BR-INT-M13-10|REQ-INT-M13-10|INT-FEAT-M13-operations|REQ-INT-M13-10-AC01|not_run，未来计划|
|BR-INT-M13-10|REQ-INT-M13-10|INT-FEAT-M13-operations|REQ-INT-M13-10-AC02|not_run，未来计划|
|BR-INT-M13-11|REQ-INT-M13-11|INT-FEAT-M13-operations|REQ-INT-M13-11-AC01|not_run，未来计划|
|BR-INT-M13-11|REQ-INT-M13-11|INT-FEAT-M13-operations|REQ-INT-M13-11-AC02|not_run，未来计划|
|BR-INT-M13-12|REQ-INT-M13-12|INT-FEAT-M13-operations|REQ-INT-M13-12-AC01|not_run，未来计划|
|BR-INT-M13-12|REQ-INT-M13-12|INT-FEAT-M13-operations|REQ-INT-M13-12-AC02|not_run，未来计划|
|BR-INT-M13-12|REQ-INT-M13-12|INT-FEAT-M13-operations|REQ-INT-M13-12-AC03|not_run，未来计划|
|BR-INT-M13-13|REQ-INT-M13-13|INT-FEAT-M13-governance|REQ-INT-M13-13-AC01|not_run，未来计划|
|BR-INT-M13-13|REQ-INT-M13-13|INT-FEAT-M13-governance|REQ-INT-M13-13-AC02|not_run，未来计划|

详细结构化REQ/AC/计划在同模块需求条目与本地章节；均未执行，不构成批准或安全证明。
