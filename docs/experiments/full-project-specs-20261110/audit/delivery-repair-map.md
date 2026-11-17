# Delivery 修订映射（待原审阅者定向复核）

本轮只修订规格、计划和本机分析产物；没有改产品实现、固定源码、其他 part 或 pack，没有运行 API、Git 交接、业务测试或实际验收。以下“已修订”是作者修订状态，不代表独立复核通过或业务批准。

初稿 `parts/delivery.first-pass.json` 保持 SHA-256 `89d86276071498472a41eeb474ff201453272fbf2f175f41512a7d20293f4467`，初始 `review/delivery-initial.json` 和 `.md` 未覆盖。修改前的四份模块规则稿已逐一复制到 `modules-first-pass/` 同名文件。固定来源仍为 run `NSG3TKRB16Y9F6Y203WB`、snapshot `06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa`、source manifest `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`。

## 八项修订

| Finding | 修订位置与精确变更 | 计划检查与保留限制 | 原始来源（固定快照相对路径） |
|---|---|---|---|
| F-DEL-01 | `REQ-DEL-M06-03` 标题、trigger、BR-DEL-M06-03-02/-03/-04、AC-M06-03-02、异常、正文及 M06 规则表改为“当前状态”资格；只有基线绑定另要求没有任何历史 Run。不再把曾执行过解释为永久禁止改合同/取消。 | 新增 AC-M06-03-03 / TC-M06-03-03：独立 A/B/C 种子均含 completed 历史 Run、失败后已重新分派 assigned、快照8、管理者且无 pending 交接，分别验证编辑成功、取消成功、基线拒绝。历史 Run/证据保留；夹具未来建设、not_run。 | `packages/application/src/task-service.ts:366-379,966-1096`；`packages/application/src/task-baseline-use-cases.ts:28-33` |
| F-DEL-02 | `REQ-DEL-M07-02` 前置、主流程、BR-DEL-M07-02-02、异常及 AC-M07-02-02 均限定为 path.resolve/path.relative **词法**边界和目标存在性检查。后置 attach 失败不等于撤销之前的 clone 写入。 | AC-M07-02-02 的正常目录种子明确无 symlink/junction；新增 AC-M07-02-03 / TC-M07-02-03 为未来受控临时链接祖先检查，记录 Git 物理落点和后置失败，不许诺物理隔离。OS/Git 链接夹具尚待建设，不声称已利用或已复现。 | `apps/cli/src/project-workspace.ts:166-173,196-216` |
| F-DEL-03 | `REQ-DEL-M07-09` 前置、BR-DEL-M07-09-01/-04、异常、AC-M07-09-02 及矩阵拆分 prepare 前的预检失败与 prepare/stop-ack 后的 Git binary 判断失败。后者保留 preparing 交接和 suspended 源 Run，该次不执行 ref 发布，取消后仍需显式 resume。 | 新增 AC-M07-09-03 / TC-M07-09-03：未来隔离集成种子有 NUL-free blob.dat、HEAD 内 `blob.dat -diff`、未有交接 ref、源有效租约；按阶段观察错误、保留状态和取消/恢复。夹具未建设/未运行；无“二进制永不暂停源”结论。 | `packages/integrations/src/handover-workspace.ts:69-78,88-107`；`apps/cli/src/handover.ts:124-153`；`packages/application/src/handover-use-cases.ts:325-335` |
| F-DEL-04 | `REQ-DEL-M06-09` 前置、主流程、异常和状态区分本人有效设备的 context/sessions **读**与 mint/renew/start/state **写**。读不要求 Run active 或 task/Run epoch 相等；写继续检查当前权限、状态、代数及适用租约，保留 epoch0 兼容例外。 | 新增 AC-M06-09-03 / TC-M06-09-03：未来 suspended R epoch1/task epoch2、有历史 Session 的种子；读取成功，mint/执行写拒绝，计数和状态不变。没有让读取成功隐含执行权。 | `packages/application/src/execution-use-cases.ts:16-28,32-36,73-90`；`apps/agentd/src/index.ts:91-103` |
| F-DEL-05 | `REQ-DEL-M07-10` data_contracts 与正文、M07 契约改为 `documents[].document_code`；明确 check 使用 entry.document_code，未保留错误 code 别名。 | AC-M07-10-01 / TC-M07-10-01 的动作与结果明确核对 documents[0].document_code=A、revision=1，并以同字段进行 revision 过期匹配；仅计划，未运行。 | `apps/cli/src/guidance.ts:236-242,252-260,288-309` |
| F-DEL-06 | `REQ-DEL-M10-04` AC-M10-04-02 的计划及矩阵补足显式 enabled 安装、alias、generation、active 请求者读权和无额外 external grant，不再从“技能可交付”推断有安装。 | 种子为 S r1、alias review、enabled=true、generation3；先观测 manifest 含 S r1，再添加无来源团队角色的 active 外部成员，然后整份清单拒绝；安装元数据不改。未来隔离夹具待建设、not_run。 | `packages/application/src/skills-run.ts:18-35`；`packages/application/src/skills-access.ts:92-101` |
| F-DEL-07 | `REQ-DEL-M10-02` 前置、主流程、BR-DEL-M10-02-02/-04、AC-M10-02-01/-02 说明详情优先 source.read；无来源读取权才走目标-only 安装版限制。非自有项目 catalog/search 的二次过滤、安装列表 available_revisions 与详情区分。 | 原 C/O 明确无 source.read；新增 AC-M10-02-03 / TC-M10-02-03 比较 S（来源普通成员兼目标普通成员）、来源作者 A、target-only C 的详情版本；S 详情保留来源发布版，catalog/安装列表仍限安装版；A 可见获准草稿。未来种子待建设、not_run。 | `packages/application/src/skills-access.ts:103-115`；`packages/application/src/skills-use-cases.ts:55-73,87-101,215-236` |
| F-DEL-08 | `REQ-DEL-M09-04` 主流程、BR-DEL-M09-04-01/-03、状态、AC-M09-04-01 及矩阵改为分支审计：新建并关联两类各一次；首次关联已有缺陷仅 defect_linked；同缺陷重放零新增。 | 原 AC-M09-04-01 增加精确审计增量；新增 AC-M09-04-03 / TC-M09-04-03 独立验证已有 triaged 缺陷首关联和重放，缺陷数/状态及 Task 均保持。未来夹具待建设、not_run。 | `packages/application/src/testing-use-cases.ts:271-284,299-306` |

每个变更由同一生成输入同步到 `parts/delivery.json` 中的 `specification`、`acceptance_criteria`、`verification_plan`、`content_markdown` 和所属 `requirement_document.content_markdown`，并同步四份模块 Markdown 的 BR 表、场景、数据契约、AC 与计划矩阵。新增 AC 使用原需求内的下一稳定编号，没有重新编号原 AC 或新增业务能力。

## 公共 HTTP 边界补查

额外实际读取 `apps/core-api/src/routes/testing.ts`、`defects.ts`、`skills.ts` 全文，以及 `server.ts` 的预算/错误处理、`auth.ts` 的身份与全局 preHandler、`error-status.ts` 的回落映射。已加入对应需求证据和 coverage.reviewed_files。没有把用例层存在等同于 HTTP 合同相同。

- 测试和技能写路由的 body helper 为 10 MiB；缺陷无此特例，继承 server 的 1 MiB。超预算的全局错误是 HTTP 413 `request_body_too_large`。
- testing 提供 step 时 JSON Schema 要求 `action` 与 `expected`；用例 normalizer 的缺 expected 默认空不能替代 HTTP 资格。HTTP report_urls 数组最多100，但用例层最多30；文件解码6MiB和请求body10MiB为不同预算。
- skills 声明顶层/文件 `additionalProperties:false`；testing 没有相同的统一声明。不根据静态 schema 杜撰 Fastify/AJV 对额外属性在本部署下实际是删除还是拒绝，保留未运行限制。
- 三路由的 actor 来自认证中间件 principal；没有独立预先 `getProject` 调用，项目存在性及权限检查留在用例 scope/findProject/assertProjectAccess。legacy 通道由环境配置控制，未把这些通用路由谎称为仅接受 bearer 设备；execution 的 bearer-only 规则仍单独保留。
- defects 显式校验 status/severity/to，其他部分字段经 String 转换交用例；不补造 strict body 或 title 非空守卫。业务错误 envelope 与 Fastify schema 错误形状分开描述，未映射业务码回落400。

这次补查增加3条边界 BR（M09-01-05、M09-05-05、M10-01-05），没有新增功能或修改实现。HTTP 请求/错误/额外字段实际处理均未执行。

## 机械检查与交接

第一轮修订后（R1 前）的 `parts/delivery.json` SHA-256：`6e8dfe2c12c4d4ece8be222a09aaf17ef45f414c7e5398b6558f285d0e34747f`。

当前72 items：4 module、32 feature、32结构化 requirement、4规则文档；35能力：32 included、2 excluded、1 unknown；126 BR、73 AC及73链接计划。引用/测试定义定位55个文件，入口线索仍95，不转化为产品覆盖率。

实际运行 `query-delivery-build.py` 与 `query-delivery-verify.mjs`：IntakeItem/Production/Bundle schema、证据 SHA-256/行范围、父链/AC计划引用及正文绝对路径检查0 issues。production 的 partial-discovery needs_review 与预算 chain-policy unknown warning 保留。此为本 part 机械检查，不能代替整包 CLI、独立语义复核或业务验收。

已交回原审阅者对 F-DEL-01 至 F-DEL-08 做定向复核；作者不自行把 finding 标记为独立通过。保留的物理隔离、后 prepare 失败现场、缺陷旧事务一致性及其他运行期风险没有被文档修订“修复”。

## F-DEL-07-R1 定向补正

已读取并保留 `delivery-recheck.json/.md`：初核八项中七项在规格层关闭，F-DEL-07 留下显式项目请求资格限定。R1 前 part 已另存 `query-delivery-r1-before.json`，SHA-256 仍为 `6e8dfe2c12c4d4ece8be222a09aaf17ef45f414c7e5398b6558f285d0e34747f`；初稿及前两轮审阅报告未覆盖。

本次仅改 `REQ-DEL-M10-02` 的项目请求资格及同步副本：前置、主流程、BR-DEL-M10-02-02/-04 和异常说明，明确公共 getSkill 先调用 lockSkillReadScopes；只要传 project_code，项目必须存在且当前 actor 有该项目 read，无论其 source.read 是否成立。这个 scope 守卫通过后，来源权限才优先决定可见修订。catalog/安装列表的既有二次过滤规则保持。

保留 AC-M10-02-03 编号并扩展其未来 not_run 计划/矩阵：N 是 active 来源团队普通成员，但没有 P 的当前读取权；不传 project 时仍读取来源发布版，显式 project=P 时返回 project_forbidden 且不下发字节。既有 S/A/C 均具有其已声明的 P 读权，继续比较来源优先与 target-only 版本集合。夹具仍须未来建设，未执行请求或写入业务状态。

原始证据：`packages/application/src/skills-use-cases.ts:65-73`、`packages/application/src/skills-access.ts:55-61,103-115`、`apps/core-api/src/routes/skills.ts:20-22`；文件哈希仍取原固定 snapshot。相应 structured specification、AC、verification_plan、需求正文、`DEL-M10-RULES` 文档及 `m10-delivery-rules.md` 已同步。

R1 后 part SHA-256：`5d6590b37f5c400c15205842202e9d50fe9216bd0ce7c84b192d70993d86820b`。数量保持72 items、32需求、126 BR、73 AC/计划及35能力。重新执行本地 schema/hash/range/关联与模块同步检查0 issues；partial-discovery/chain-policy unknown提示保留。稳定需求键正文元数据由 root 在合并格式层统一添加，本次未重复修改32条正文或变更任何 key。R1 仍交原审阅者核闭合，不代替独立复核结论。
