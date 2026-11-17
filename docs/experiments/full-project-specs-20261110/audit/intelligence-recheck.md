# Intelligence 定向复核

**结论：needs_revision。** 原10项中9项可关闭；原009的主体隐私措辞已修正，但新增AC05计划还存在一个机制隔离问题，见INT-RECHECK-001。此结论只针对下列修复，不是全产品批准或安全证明。

复核part SHA-256：`0c9290779e9022d50b8110a31de6ea908dda78376271ad4d5464ddb228653aef`。原part、初审JSON/MD与五份模块初稿均保留；本轮只新增两份recheck报告，没有修改候选或源码。

## 逐项closure

| 初审ID | REQ | 状态 | 定向结论及计划边界 |
|---|---|---|---|
| INT-INITIAL-001 | REQ-INT-M08-05 | closed | Create and revise eligibility are now separated. AC03 covers writable Member creation, other-owner revision denial and manager revision; this matches create L103-L118 and revise L122-L129. Fixtures remain future work. |
| INT-INITIAL-002 | REQ-INT-M08-05 | closed | The XML rule now states the actual shallow root/end-tag and DOCTYPE/ENTITY screen. AC04 preserves the malformed counterexample without calling it well-formed or safe; full parser/render assurance is a gap. |
| INT-INITIAL-003 | REQ-INT-M08-08 | closed | Application download evidence is now L408-L435; the route L67-L82 remains for headers. The candidate, requirement prose and chapter/source columns use the corrected supporting range. |
| INT-INITIAL-004 | REQ-INT-M11-06 | closed | New-attempt preflight, global failure outside the item savepoint, non-retryable per-item mapping/fingerprint failure and retryable infrastructure paths are separated. AC03 pauses after committed preflight to observe failed/continued/blocked results; AC04 checks preflight rejection. The not-yet-built hook must be placed where the independent target update can commit. |
| INT-INITIAL-005 | REQ-INT-M13-09 | closed | AC01 now proves INSERT authority with an external READ WRITE control on a non-TEMP ordinary table, then checks transaction_read_only and SQLSTATE 25006 inside the wrapper. AC03 separately addresses the total deadline and late/released client. Neither check has run. |
| INT-INITIAL-006 | REQ-INT-M13-12 | closed | The description now names the two existence checks, the distinct Windows/POSIX markers and the absence of complete agentd/launcher/dependency verification. AC03 preserves launchers and removes the agentd entrypoint, keeping a potential activation failure as a future gap rather than an existing rejection promise. |
| INT-INITIAL-007 | REQ-INT-M14-03 | closed | The eight actual enum values and initial preparing state are used. AC03 correctly exercises preparing -> uploading with snapshot and a rejected backwards move; no mandatory passage through each intermediate stage is claimed. |
| INT-INITIAL-008 | REQ-INT-M14-04 | closed | Single-snippet 1200/30 limits are separated from cumulative 2400/60 budgets and full-file exclusion. AC03 and AC04 isolate 1200/1201 and 30/31 with the other constraints held legal. |
| INT-INITIAL-009 | REQ-INT-M14-04 | partially_closed | The module/Feature/REQ/rule text now limits the privacy statement to schema, known patterns, excerpts and optional UA exact-string hashing. No universal DLP/full-source exclusion is claimed. The newly added AC05 plan still needs the projection-consistency control in INT-RECHECK-001 to isolate that hash guard. |
| INT-INITIAL-010 | REQ-INT-M14-07 | closed | Build-time version/self-contained checks and recorded digests are separated from the React runtime HTTP/text loader. AC03 appropriately contrasts 404 and harmless modified HTTP200 text without claiming SRI, normal rendering of arbitrary scripts or browser security proof. |

## 剩余问题 INT-RECHECK-001

INT-RECHECK-001; relates_to=INT-INITIAL-009; BR=BR-INT-M14-04; AC=REQ-INT-M14-04-AC05; field=verification_plan[4].preconditions/steps/expected and corresponding module/durable rule document prose. The revised privacy claims now accurately describe bounded checks. The new exact-file-hash test, however, only says to replace a ua_graph node summary with the full test-source string. validateUaGraph first requires that summary to equal the matching artifact.nodes UA projection summary. If only the stated field is changed, publish rejects a projection mismatch before reaching the exact-file hash guard, so a generic rejection can falsely appear to prove that guard.

建议：In the planned second variant, update the matching native UA and projected UA node summaries together; retain all other required identity/evidence/layer/edge/tour correspondence. Establish that CodeArtifactSchema and validateCodeArtifact pass before publication and assert the specific full-source guard reason, not any rejection. Use a short safe >=16-byte test file whose full text fits the summary limit and matches the snapshot bytes/hash. Keep the test not_run; no implementation change is required.

原始证据：

- `packages/contracts/src/code-understanding.ts` L94–L105 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`。
- `packages/application/src/code-understanding-use-cases.ts` L139–L146 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`。
- `packages/application/src/code-understanding-use-cases.ts` L69–L77 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`。

## 一致性与保留证据

- 43个REQ与43个capability身份保持；原86个AC全部保留，新增11个边界AC形成97 AC/97计划，未把计划标成已执行。现有测试引用状态均为defined。
- 五份模块均精确包含当前REQ正文；当前BR文本、AC ID在模块及持久规则文档均有对应。该静态同步检查不是语义正确性证明。
- 初审29处原始source锚点的实际SHA与行界仍匹配；本轮重新阅读了资格、XML筛查、下载、savepoint/预检、只读包装及UA投影/hash检查等有关范围。
- JSON中的`evaluation`对象遵守所供evaluation.schema.json；外层补充候选摘要和逐项closure记录，避免把已关闭项伪装成待处理finding。

## 不覆盖范围

- This is a targeted recheck of the ten initial findings and their new boundary plans, plus repeated shared wording. It is not a new full semantic review of all 43 requirements or unrelated product domains.
- All five module files were checked for exact current requirement-body inclusion, BR text and AC IDs; these synchronization checks do not prove business truth. The chapter M12 has no original finding and was not source-deep re-reviewed.
- 43 requirement/capability identities and original AC IDs are preserved; there are now 97 ACs and 97 plans. Plans are classified not_run from the document statements and absence of execution receipts; the protocol does not define a status property on verification_plan. Existing test references remain defined.
- No application tests, business/API calls, database writes/diagnostics, installer execution, external model calls or live browser security checks were performed. New fixture/hook designs have not been built.
- Full XML parsing/render safety, runtime resource integrity/SRI, universal free-text DLP and complete executable payload validation remain unimplemented/unproven boundaries, not closure deliverables.
- The original initial report, first-pass part and five first-pass module backups were preserved. Root global documents, other lanes, older experiment answers, untested deployment/runtime and unresolved business policy are outside this recheck.

## 输入摘要

| 输入 | SHA-256 |
|---|---|
| `parts/intelligence.json` | `0c9290779e9022d50b8110a31de6ea908dda78376271ad4d5464ddb228653aef` |
| `review/intelligence-repair-map.md` | `d589b7849998c031c0ca3f1f8f5b0806c08bc93d22b21be2acfea44f955979b4` |
| `review/intelligence-initial.json` | `ab9da796a4999f979bef884c9ad650d1b138a88ff66ad2be9c4e6ec735848515` |
| `review/intelligence-initial.md` | `79af232833b4edb980d310152a3a9b8f27c7a6b365d98810972d03e67b608be9` |
| `modules/m08-intelligence.md` | `297b466be5bc3a7d6a2cbe1f3fae477034fe7f48fc28c8825685f3c9f3a1a368` |
| `modules/m11-intelligence.md` | `6d7d1880b65842aa121fa3f4bdf9b2309733890b11ba083ebaa2fd67de4601dd` |
| `modules/m12-intelligence.md` | `9224d3703c34a96dd16785b571be65ac831e3e89c957118cae83eb909c879dd0` |
| `modules/m13-intelligence.md` | `4df7c43faf5f269cdbef72d8419862cf443e0d9bae491a51302bd910cbada8ca` |
| `modules/m14-intelligence.md` | `852c20460d5f278b561f2a1df7292556d445b33d251e2e40e8afdd061f5e38dd` |

本报告保留这一候选版本的复核结果。后续若修订INT-RECHECK-001，应另附定向复核记录或新版本报告，不覆盖initial事实。
