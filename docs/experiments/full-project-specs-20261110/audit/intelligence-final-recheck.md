# Intelligence 最终定向复核补充

**结论：reviewed_with_limits。** 本轮三个限定修复范围均可关闭，未发现新的范围内残留问题。原初审与第一次recheck保持原样；第一次recheck绑定旧候选，本文记录后续修复。

最终part SHA-256：`4218e764f2834cc571e536c30bdf559163a80dd2e0129336958e75159e50479f`，609028 bytes。其前一provider文字修复基线为`6a970871bbfeb325a6bf4798800b99e139f0bd61068eaf221a7c125849376ee2`；固定source run为`NSG3TKRB16Y9F6Y203WB`。

## Scoped closure

| Finding | 已复核范围 | 结论 |
|---|---|---|
| INT-RECHECK-001 | REQ-INT-M14-04 / REQ-INT-M14-04-AC05 | closed_in_reviewed_scope |
| shared-initial#3 | REQ-INT-M08-03 / REQ-INT-M08-03-AC03, REQ-INT-M08-03-AC04, REQ-INT-M08-03-AC05 | closed_in_intelligence_part |
| shared-initial#4 | REQ-INT-M08-01 / REQ-INT-M08-01-AC01 | closed_in_intelligence_part |

### INT-RECHECK-001

The plan now updates both the native UA node summary and matching artifact.nodes provider=ua projection summary by native_id. It keeps identity/evidence/layer/edge/tour/snapshot correspondence, uses a safe short exact-byte >=16-byte source file, requires CodeArtifactSchema success and empty validateCodeArtifact issues before publish, and asserts the specific UA metadata contains complete source bytes reason. A projection/budget/identity failure makes the fixture invalid or the test fail, so it cannot falsely prove the later hash screen. The final provider field wording matches CodeNodeSchema. This closes the documentary/test-design defect; no fixture or security test was executed.

原始证据：

- `packages/contracts/src/code-understanding.ts` L16–L18 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`。
- `packages/contracts/src/code-understanding.ts` L86–L106 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`。
- `packages/application/src/code-understanding-use-cases.ts` L69–L77 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`。
- `packages/application/src/code-understanding-use-cases.ts` L139–L150 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`。

### shared-initial#3

The current specification, included capability, requirement body, M08 rule document and module now cover the material CLI upload behavior: case-insensitive supported suffixes; root symlink rejection; nested symlink, hidden and named-directory filtering; zh-CN recursive planning; inferred/overridden kind/title/summary; directory hierarchy created before documents; sequential independent requests and second content reads. The later-failure plan uses a pre-send deterministic fault after a confirmed earlier success, then queries actual remote state and uploads only the missing file under the existing parent. It does not claim rollback, idempotent directory rerun, automatic resume or safe unknown-response replay. The three added plans remain unbuilt/not_run.

原始证据：

- `apps/cli/src/handoff-upload.ts` L29–L50 @ `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`。
- `apps/cli/src/handoff-upload.ts` L53–L79 @ `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`。
- `apps/cli/src/handoff-upload.ts` L84–L122 @ `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`。
- `apps/cli/src/index.ts` L2089–L2113 @ `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`。
- `apps/cli/src/index.ts` L2115–L2181 @ `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`。

### shared-initial#4

The reusable child fixture now names Member A as the original requirement-document owner, a current non-Viewer writable member with a normal valid session, and keeps the project/document/module active. It records r and required content fields, revises the source to r+1, reads the linked original code/current content, and checks exact project_document_source_read_only on generic revision without changing the source/history further. These authorization-critical preconditions agree with canAuthor, current write checks, source revision append and the generic-document fallback. This closes the child-plan ambiguity; regenerated root shared examples and the global matrix are outside this addendum.

原始证据：

- `packages/application/src/requirement-document-use-cases.ts` L121–L123 @ `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`。
- `packages/application/src/requirement-document-use-cases.ts` L384–L430 @ `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`。
- `packages/application/src/project-document-use-cases.ts` L529–L538 @ `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`。
- `packages/application/src/project-document-use-cases.ts` L193–L245 @ `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`。

## 静态核对结果

- 当前part为43 REQ/43 capability/100 AC/100计划；原97 AC ID全部保留，只追加3个upload边界AC。
- 五模块均精确包含当前REQ正文，BR文本与AC ID在对应持久规则文档和模块中同步。该核对不等于重新深审43项语义。
- 原initial JSON/MD及第一次recheck JSON/MD摘要与已保存值一致；未覆盖历史报告。所有本轮source锚点的实际hash/行界复验。
- JSON的evaluation子对象采用所供evaluation.schema.json；closure另列，避免把已关闭事项记为新finding。

## 精确剩余边界

- This final addendum rechecks only INT-RECHECK-001/REQ-INT-M14-04-AC05 and the intelligence-part changes for shared-initial findings 3 and 4 (REQ-INT-M08-03 upload; REQ-INT-M08-01 source-owner fixture). Other initial closures are inherited from the preserved earlier review, not newly re-audited.
- Root is regenerating the shared dossier/example and global acceptance matrix. Those regenerated artifacts were not reviewed here; closed_in_intelligence_part does not assert their final consistency or close all shared findings globally.
- 43 requirement/capability identities and all 97 pre-final AC IDs are retained; three upload ACs produce 100 ACs/100 plans. Counts, unchanged IDs and synchronized copies are mechanical evidence, not a semantic coverage percentage.
- The plans remain not_run and new link/fault/hash fixtures are unbuilt. No business/API operations, application tests, installer/browser/model execution, database writes or source/candidate edits were performed.
- Filesystem links are checked at scan time; concurrent replacement, all operating-system edge cases and real CLI/API failures remain untested. Later request/response failures may have unknown server effects; the recovery advice is manual query-and-reconcile, not an automatic retry guarantee.
- Full XML parsing/render safety, runtime asset integrity/SRI, generic free-text DLP, complete runtime-payload validation, unresolved business policy and production security/runtime behavior remain outside the claims and this review.
- No claim of product approval, security proof, executable test pass or universal semantic completeness follows from this addendum.

## 输入摘要

| 输入 | SHA-256 |
|---|---|
| `parts/intelligence.json` | `4218e764f2834cc571e536c30bdf559163a80dd2e0129336958e75159e50479f` |
| `parts/intelligence.pre-provider-fix.json` | `6a970871bbfeb325a6bf4798800b99e139f0bd61068eaf221a7c125849376ee2` |
| `review/intelligence-final-repair-map.md` | `f0566d3e1b1f88cd783079993f5f7d94d318ca97240c2c51386e2feddb5b26a6` |
| `review/shared-initial.md` | `f3ee1a96db4b8607a8305a7cd7299f3ff50a57f2fbb895818c3a5eacde6692b3` |
| `modules/m08-intelligence.md` | `60cd1a30e812ed622b92adaac247bf9c770bb06c7bc4471d0c64d4e67a2821b7` |
| `modules/m14-intelligence.md` | `309875e70ef215b0a6be17a0a3dbdc1b292b9bff2acfa3ca9542c298692ef085` |
| `review/intelligence-initial.json` | `ab9da796a4999f979bef884c9ad650d1b138a88ff66ad2be9c4e6ec735848515` |
| `review/intelligence-initial.md` | `79af232833b4edb980d310152a3a9b8f27c7a6b365d98810972d03e67b608be9` |
| `review/intelligence-recheck.json` | `530f2e9c77a392998e86ccabad4a1a9209a08b0f6d6866a67309b600ff61115f` |
| `review/intelligence-recheck.md` | `553492ece9090d2f2afe07a0d55482810d0be890acac306c91b939f3761cb92b` |

本次只新增intelligence-final-recheck.json/.md；没有修改候选、源码或root共享产物。
