# Governance first-pass semantic review

Verdict: **needs_revision** — 1 blocker, 4 warnings. This is an independent static semantic review, not business approval or an execution result.

## Frozen inputs

- Candidate: `F:/workspace/team-synergy-runtime/team-synergy-user-space/work/full-spec-20261110/parts/governance.first-pass.json`
- Candidate SHA-256: `eeab65e53ba1e73d98a0c6371a1d225f532c27dfc96105d77717481382a1ed4a`
- Captured run: `NSG3TKRB16Y9F6Y203WB`
- Raw source manifest: `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`
- Enterprise mixed-input manifest: `c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e`
- Canonical Skill: `pack/SKILL.md`, version `2.2.0`; review shape follows `pack/references/evaluation.schema.json`.

- `discovery-governance.md` SHA-256 `55de1e7280ade6d13dfb9d76ca1eff7467b9f0eca415b14e7c9cd324d2e5d65f`
- `modules/m01-identity.md` SHA-256 `a11efb23f70a3a8f6d93c9cdff3e9762da03531fd24387c57e30d231eeb52ed0`
- `modules/m02-governance.md` SHA-256 `3fbf7149082391aaceb5f4e7d00f6bfe3ca62f462ec2442b4c69eeed71532459`
- `modules/m03-structure.md` SHA-256 `af0ec19f9efe8ad8832aae5d5af5fd7602320039bbd921c4661b5f3ecf55226b`
- `modules/m04-discovery.md` SHA-256 `c6bef89f5b5db23c80c6a60943aca612229aca6d0e0e45a5f24577aae7175998`
- `modules/m05-requirements.md` SHA-256 `0a1aa58f7e5309c7436e5b6c2dc4a9606486064c56d4ce7346d6d1cdb3a8256f`

## Review extent

Read all 37 requirement summaries/specifications and the five chapter artifacts. The repeated main-flow, state-change and data-contract strings were reconciled against the chapter text with no missing strings (this is a consistency check, not semantic proof). Read all chapter acceptance-plan sections. Deep source checks covered at least two consequential requirements per chapter:

| Chapter | Deep source sample |
| --- | --- |
| M01 | Password login/change; stable installation/session; device authorization/management; Web auth boundary |
| M02 | Team removal; effective membership; ownership transfer/recovery |
| M03 | Feature scheduling; milestone lookup/window/completion |
| M04 | Topic entry/image/withdrawal; fixed-revision review/vote/conclusion |
| M05 | REQ revision/binding/lifecycle; baseline snapshot/freeze/immutability/read/compare |

Every finding below cites an opened captured-source range and the actual file hash. Exact source hashes were checked against the enterprise pack manifest. No sources or candidates were edited.

## Findings

### GOV-INITIAL-001 — blocker — `REQ-GOV-TOPIC-DECISIONS`

[GOV-INITIAL-001] specification.business_rules BR-GOV-TOPIC-DECISIONS-IMAGES、specification.data_contracts、AC-GOV-TOPIC-DECISIONS-IMAGES 及其 verification_plan.expected（同步 M04 规则/计划）把应用层每张 2 MiB、合计 5 MiB 内的数据描述为可成功提交，却未保留公开 HTTP 入口更早的 1 MiB 整体请求限制。server.ts 配置 1 MiB bodyLimit，并将超限映射为 413/request_body_too_large；topic entries 路由没有覆盖该限制。例如一张解码大小 1 MiB 的 PNG 的 base64 JSON 已超过 1 MiB，虽然低于应用层 2 MiB 门槛，仍在路由处理前被拒绝。这是源码配置推导，未实际发送请求。

Source proof:

- `apps/core-api/src/server.ts` L67–74; SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/routes/requirement-collaboration.ts` L50–53; SHA-256 `cbd63cdecc412dc8121925a1df0dc70f7054d8ccbfa4bd3c1fc598d8601cf406`
- `packages/application/src/requirement-collaboration-use-cases.ts` L27–50; SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`

Suggested correction: 将应用用例的图片格式/字节门槛与当前 HTTP request_body_too_large 边界分别写清，在 BR、AC、M04 和计划同步记录。计划分别指定直接应用用例的 2 MiB/5 MiB 边界及真实 HTTP 1 MiB JSON 边界，给出可计算的 base64 fixture 和预期 413；若希望扩大 HTTP 限制，作为 proposed 决策，不能写成现状。保持所有计划 not_run。

### GOV-INITIAL-002 — warning — `REQ-GOV-PROJECT-EFFECTIVE-MEMBERS`

[GOV-INITIAL-002] BR/AC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROSTER 与 verification_plan.expected 声称“无访问者列表为空”，但该计划明确使用 /projects/P/members。内部 listMembers 确实对无访问者返回 []，公开 GET 路由却先执行 getProject；无访问者在这一步返回 ok=false/project_forbidden，根本不会调用 listMembers。因此该 HTTP 计划的拒绝结果与当前公开入口不一致。

Source proof:

- `apps/core-api/src/routes/projects.ts` L167–171; SHA-256 `4f016bc1bf57e3a429142799654121e533907397263aae7cf82bf47c857c75eb`
- `packages/application/src/project-use-cases-project.ts` L310–315; SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`
- `packages/application/src/member-use-cases.ts` L103–108; SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`

Suggested correction: 把 HTTP 名册场景的无访问结果改为 project_forbidden 且不返回名册正文；如保留内部辅助函数空列表行为，明确标注其层级并单列直接调用计划。同步结构化 BR/AC、content_markdown 与 M02 文档。

### GOV-INITIAL-003 — warning — `REQ-GOV-PASSWORD-LOGIN`

[GOV-INITIAL-003] BR/AC-GOV-PASSWORD-LOGIN-EXPIRED 及 verification_plan.expected 的“管理员重新签发后方可恢复登录”是不受代码支持的唯一恢复结论。初始密码到期只在新口令登录中检查；到期前取得且仍有效的会话可访问 password-change，changePassword 校验当前密码但不检查 password_expires_at，并会清除 must_change_password/password_expires_at。因此持有有效旧会话的用户可以自行改密后以新密码登录，无需管理员重签。

Source proof:

- `packages/application/src/auth-use-cases.ts` L79–85; SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `packages/application/src/auth-use-cases.ts` L90–110; SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `apps/core-api/src/auth.ts` L76–95; SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`

Suggested correction: 保留到期新登录被拒绝及管理员重签可恢复这一受支持分支，删除唯一性措辞或明确其适用前提。增加“到期前已有会话→推进超过初始密码 TTL→旧初始密码新登录失败→原会话改密→新密码登录”的独立 not_run 计划；同步 M01、BR、AC 和 expected。

### GOV-INITIAL-004 — warning — `REQ-GOV-BASELINE-FREEZE`

[GOV-INITIAL-004] verification_plan[ac_id=AC-GOV-BASELINE-FREEZE-INVALID].preconditions（同步 M05 TC）使用“R approved”作为有效对照 fixture，但当前 REQ 状态只有 draft/clarifying/confirmed/implementing/delivered/change_proposed/deprecated，基线准入也只接受 confirmed/implementing/delivered。approved 不是可由当前正常生命周期建立的状态；按该 fixture 执行会提前产生状态拒绝，可能掩盖未知 revision、跨项目等分支。该计划的步骤还未逐项给出错误请求，无法避免多重错误先后顺序混淆。

Source proof:

- `packages/application/src/requirement-use-cases.ts` L18–37; SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/baseline-use-cases.ts` L171–185; SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`

Suggested correction: 使用 confirmed 且具有合法 AC/无开放问题、存在所选 revision 的 R 作为基准，并为 selection/revision/project/state/member/archived/unknown-field/size 分支分别给出只改变一个因素的输入、预期错误与 header/items 数量断言。保留 not_run，不将 fixture 修订标成执行成功。

### GOV-INITIAL-005 — warning — `REQ-GOV-PASSWORD-LOGIN`

[GOV-INITIAL-005] verification_plan[ac_id=AC-GOV-PASSWORD-LOGIN-QUOTA] 只安排同 scope 的 6 次一分钟请求与一次窗口后重试，却在 expected 同时断言每小时 20、不同 scope 隔离及过期小时行清理。现有步骤达不到第 21 次小时配额，没有第二 scope，也没有建立/读取过期行，因而无法观测这些已纳入 AC 的结果。源码确有 scope 键和小时删除/阈值分支，缺的是对应可复现验证设计。

Source proof:

- `packages/application/src/auth-rate-limit.ts` L7–24; SHA-256 `5cb59034dd5df29f8e37fdc2de4ebfb960e82cdfdad67aa195cca9d36aebb634`

Suggested correction: 拆分独立分钟、小时、scope 隔离和过期行用例。明确受控时钟、每分钟不超阈值的小时请求序列、第 20/21 次预期、第二 scope，以及 hour_started_at 严格早于一小时前的隔离旧行及清理后的读取断言；同时记录拒绝请求也会增加计数。保持 not_run。

## Not checked / retained limits

- 未运行任何业务测试、验收计划、HTTP/CLI 操作或数据库 fixture；本报告不证明运行成功或部署行为。110 份计划仍为 not_run，已有测试仅保持 defined。
- 全部 37 条 requirement 的 summary/specification 已逐条阅读，BR/AC 与计划按章节阅读；深查样本不是所有源码行或全部 675 文件的业务复核。
- M01 深查 password login/change、installation sessions、device authorization/management、Web auth；M02 深查 team removal、effective membership、ownership transfer/recovery；M03 深查 feature scheduling 与 milestone creation/update/completion；M04 深查 topic entry/images/withdrawal、document review；M05 深查 REQ revision/binding/lifecycle 与 baseline freeze/read/compare。其他 requirement 主要做一致性及关键来源抽查。
- 未逐一运行 UI 控件、真实浏览器 cookie/TLS、代理/IP 信任、Windows ACL/链接处理、CLI 本机恢复和并发竞争；未验证迁移 fixture 或错误注入方案实际可执行。
- 跨分工的协作/文档父模块引用按既定身份保留，不视作缺失设计；未复核其他分工候选、旧实验 PRD 或其他 writer 答案。
- 对当前实现、proposed/unknown 业务目标及人工批准保持区分；本报告不替代 Owner 决策，也不宣称全项目能力覆盖。

## Review records

The companion JSON retains every reviewed requirement key. The five finding identifiers are embedded in `claim` so the report remains compatible with the canonical evaluation schema, which has no separate `id` or `field` properties. Fields and AC/BR identifiers are named in each claim. Any repair should preserve this initial report and use a separate recheck filename.
