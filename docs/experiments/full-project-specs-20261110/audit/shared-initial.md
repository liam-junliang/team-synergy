# Shared dossier and full-scope initial review

Verdict: **needs_revision**, scoped to shared claims, navigation/coverage reconciliation and three embedded acceptance examples. This is a static review recommendation, not business approval.

## Inputs and boundaries

- Fixed source run: `NSG3TKRB16Y9F6Y203WB`; snapshot `06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa`; Skill 2.2.0.
- Raw code manifest: `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`; candidate combined input manifest: `c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e`.
- Read all 13 shared bodies and corresponding dossier Markdown, with repeated source-index/hash lists inspected structurally rather than reread as prose. Read scope-plan, chapter-map, surface-inventory and combined coverage declarations. Read current raw operational/auth/Task-state/Run-contract code and targeted CLI upload/source-revision code.
- Only the two assigned review reports were written. No source/candidate was modified.

Input fingerprints at review:

- `parts/shared.json` SHA-256 `82c045b9ae6d0c2663df67d7a7d7c61845647768c6f4bff3d995a5ef44570b66`
- `chapter-map.json` SHA-256 `47fed906adc96c78cb63da7f743742ed910282f9e20d4e883beb44c8a19c268d`
- `scope-plan.json` SHA-256 `35a21198066edc219cda54fc5ee8803514734cb7ff9c1f27798cf0d805a79076`
- `surface-inventory.json` SHA-256 `fba37ea8e4ddc6acfa79c9e02a2bcda19a41ddfad27a3682424f937448231c3a`
- `pack/intake.json` SHA-256 `812d8cc2a40aec7b0133818fa26657454917d2bf2eb24feede6b72191eac2928`

## Reconciliation evidence

- All 13 readable dossier bodies exactly equal their shared candidate content_markdown. All 13 artifact types occur once; 112 structured requirements map to 14 business chapters and 10 platform module identities.
- All 112 candidate requirements have an existing feature and module with a consistent candidate module→feature→REQ chain. One chapter-level navigation mapping disagrees with the preserved requirement parent/document (finding 2).
- All 32 files in surface-inventory.application_files are represented in the union of the three current parts reviewed_files lists; task-service.ts is present additionally. These lists mean the writers inspected relevant ranges, not that this reviewer proved every branch.
- All 28 API route-file paths and every path represented by the static 213 API / 193 CLI leads are in the combined reviewed-file lists. Looped registrations exist in cli-distribution, code-understanding, handovers, ownership and system-agent; the lead count is explicitly not a complete OpenAPI/command or runtime count.
- Four CLI helpers are not in the writers reviewed-file lists: handoff-upload.ts, intake-enterprise.ts, pack.ts and skill-context.ts. Only the observed public directory-upload behavior yields a coverage finding here; no per-helper REQ requirement was imposed.
- Every shared evidence entry checked against the raw file had the declared SHA-256 and an in-range line interval. This verifies locators, not semantic support of every sentence. Most shared artifacts carry broad repeated evidence lists; tighter local anchors for readiness (`db.ts:79–92`) and audit export (`audit-export.ts:19–31`, `audit-redaction.ts:2–16`) would improve reviewability.

## Findings

### 1. [Medium]

Item: `tsp-doc-domain`. content_markdown / 状态机 / Task / Run (dossier/domain.md:22): the combined row assigns Task states draft→ready→assigned→running→self_tested→submitted→verified→closed to Task / Run. Run has a distinct persisted enum; the current row obscures the execution lifecycle despite the detailed modules distinguishing it.

Evidence:
- `packages/domain/src/task-state-machine.ts:17–29` SHA-256 `2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26`
- `packages/contracts/src/schemas.ts:80–82` SHA-256 `7b6e3612dd96c833a0cc802c582c400c81ec7fac6cd8ffc8b6ba0a77c76349f2`

Suggestion: Separate the Task and Run rows. Keep Task transitions with the task state machine; list Run active/suspended/preparing/transferred/completed/failed/cancelled as its own contract and link M06/M07 for transition guards. Do not invent one linear Run sequence from its enum.

### 2. [Medium]

Item: `tsp-doc-context`. content_markdown / 关键场景 / M03 platform-parent and rule-document columns, and chapter-map.json M03.module_key/document_key: M03 lists tsp-req-home-binding while declaring tsp-module-collaboration / GOV-M03-RULES for the chapter. The actual candidate preserves tsp-req-home-binding → tsp-feature-project-home → tsp-module-documents and document_key=tsp-doc-documents. All 112 candidate module→feature→REQ chains are valid; this is a cross-document navigation/mapping mismatch, not a reason to reparent the existing requirement. The source anchor below supports the home capability only; candidate identity disagreement is established by the generated objects named above, not by a source-code platform key.

Evidence:
- `packages/application/src/project-home-use-cases.ts:40–68` SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`

Suggestion: Allow per-requirement module/document overrides in chapter-map.json, or make the chapter-level fields explicitly the primary/default parent and list the home-binding exception. Update the shared context table and any generated navigation consistently while retaining the existing documents-module identity.

### 3. [Medium]

Item: `REQ-INT-M08-03`. specification.trigger/main_flow/exceptions, source.production included capability INT-CAP-M08-03, and shared full-scope claims: docs upload is named as covered, but its material public behavior is not specified. It recursively plans a local directory, filters supported text and links, creates remote folders before documents through separate requests, and on later failure returns an error without rolling back already-created folders/documents. The current requirement describes individual document creation/revision and its ACs cover only revision conflicts. This is a genuine discovered CLI behavior gap; the mere fact handoff-upload.ts is absent from reviewed_files is not the finding.

Evidence:
- `apps/cli/src/handoff-upload.ts:29–30` SHA-256 `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`
- `apps/cli/src/handoff-upload.ts:53–60` SHA-256 `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`
- `apps/cli/src/handoff-upload.ts:84–114` SHA-256 `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`
- `apps/cli/src/index.ts:2089–2113` SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`
- `apps/cli/src/index.ts:2115–2181` SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

Suggestion: Extend the existing M08 creation/upload requirement or add a bounded capability for single-file/directory upload: supported suffixes, root-link rejection/nested-link skipping and ignored directories, inferred/overridden kind/title/summary, hierarchy order, sequential partial-success behavior and safe retry/recovery guidance. Add at least a successful directory and a deterministic later-request-failure planned acceptance check; do not describe the whole upload as one atomic server transaction.

### 4. [Medium]

Item: `tsp-doc-requirements`. content_markdown / 跨模块示例3 preconditions and the cloned REQ-INT-M08-01 verification_plan[ac_id=REQ-INT-M08-01-AC01].preconditions: the only actor is Member, but step 1 requires that actor to revise the original requirement document. A generic Member who does not own that document is rejected; the fixture does not say who owns the source document or who performs the source revision. Therefore the showcased reusable plan cannot be reconstructed to its expected successful update without guessing an authorization-critical initial fact.

Evidence:
- `packages/application/src/requirement-document-use-cases.ts:121–123` SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:384–404` SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/project-document-use-cases.ts:529–538` SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`

Suggestion: State explicitly that Member A is the original requirement-document owner and has current project write access (or use an explicit manager for the source update); give the same actor a valid normal session, keep the project/source document active, record r and revise to r+1. Then use the read identity for the library query and assert the exact project_document_source_read_only rejection for generic revision. Repair the child plan, module prose, acceptance matrix and copied shared example together.

## Reviewed conclusions without a new defect

- Shared documents distinguish observed behavior, documented goals, inference and unmeasured results. The runbook supports RPO ≤24 hours / RTO ≤30 minutes as goals; current production attainment is not claimed. Backup custom archives, list verification, independent migration and restore-to-new-database/DDL rollback limits agree with the inspected script and runbook ranges.
- Shared identity/security language retains Cookie/Bearer/legacy distinctions and configuration dependence; project authorization is not represented as database RLS. Owner/Admin copy-versus-predicate conflict is left unresolved instead of being converted to approval.
- Privacy language correctly limits the source-local promise to the normal code-knowledge flow, notes free-text/snippet leakage limits, and separately acknowledges historical Task/Run workspace_path storage. No comprehensive DLP, universal atomicity, distinct-natural-person verification or universal tool-upgrade compatibility guarantee was found in the shared prose.
- Metrics/auth/readiness descriptions agree with inspected code: health is liveness; readiness checks database and exact migration head/hash; metrics needs a real current session plus current admin authorization; generation ratio is not business quality.
- Examples 1 and 2 can be reconstructed at a planned-check level with isolated account/task fixtures. They remain unexecuted. Example 3 needs the explicit source-owner fact in finding 4.

## Not checked

- No business acceptance tests, API writes, database operations, build/lint/typecheck, browser interaction, load testing, deployment, model execution or recovery drill was run by this reviewer.
- The other 110 structured requirements were not independently deep-reviewed. Module semantic reviews belong to separate reviewers; this pass checks their coverage metadata and shared consistency, with focused M08 plan/upload checks.
- The 675 captured files were not each semantically read. Complete means the declared static inventory, not universal runtime coverage. Helper absence from reviewed_files alone was not treated as an omitted capability.
- No earlier experimental comparison PRD or other reviewer intended findings were used as an answer key. Existing Owner/Admin policy conflict remains a legitimate unresolved review item; this review does not decide or auto-approve it.
- Current production configuration, backups, RPO/RTO achievement, P95/error-rate capacity, real cookies/TLS/proxy behavior, external Git/plugin/model behavior and all failure interleavings remain unverified.

## Scoped disposition

Revise the four issues above across each affected representation, then perform a focused independent source recheck. Static coverage metadata is substantially reconciled; universal semantic/runtime completion and human approval remain outside this verdict.
