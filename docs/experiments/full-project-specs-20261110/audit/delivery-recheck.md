# Delivery targeted recheck

**Verdict: needs_revision — 7 original findings closed at specification level; F-DEL-07 partially closed with one remaining request-scope qualification.**

Rechecked `parts/delivery.json` SHA-256 `6e8dfe2c12c4d4ece8be222a09aaf17ef45f414c7e5398b6558f285d0e34747f`. Initial first-pass JSON remains SHA-256 `89d86276071498472a41eeb474ff201453272fbf2f175f41512a7d20293f4467`. The fixed source run/snapshot and manifest are unchanged. This report does not replace `delivery-initial.json/.md`.

Inputs: current part, repair map, four current module rule documents, synchronized discovery record, initial finding evidence, and the requested public-route supplement. No older experiment/reference findings were read.

## Per-finding closure

### 1. F-DEL-01 — closed

`REQ-DEL-M06-03` — BR-DEL-M06-03-02/-03/-04; AC-M06-03-02/-03.

Current draft/ready/assigned edit/cancel guards are separated from no-historical-Run baseline binding. Independent rework A/B/C seeds specify current snapshot, manager, no active/pending execution, preserved historical Runs/evidence and future/not_run status.

Source task-service.ts L366–379,L982–1005,L1055–1079; task-baseline-use-cases.ts L28–33.

### 2. F-DEL-02 — closed

`REQ-DEL-M07-02` — BR-DEL-M07-02-02; AC-M07-02-02/-03.

Prose, AC and ordinary-directory plan now qualify lexical containment and existsSync. Link-ancestor exploration records real Git outcome and post-attach partial writes without a physical-containment or rollback guarantee. OS support/fixture availability remains explicit.

Source apps/cli/src/project-workspace.ts L166–173,L196–216; public CLI index.ts L2654–2659.

### 3. F-DEL-03 — closed

`REQ-DEL-M07-09` — BR-DEL-M07-09-01/-04; AC-M07-09-02/-03.

Early NUL/private/LFS/submodule preflight is separated from later Git-numstat binary rejection after prepare/stop-ack. No-pause applies only to the early branch. New -diff/NUL-free future scenario preserves preparing/suspended state and verifies explicit cancel/resume sequence; no executed Git receipt is asserted.

Source handover-workspace.ts L69–78,L88–107; CLI handover.ts L141–153; handover-use-cases.ts L325–335.

### 4. F-DEL-04 — closed

`REQ-DEL-M06-09` — BR-DEL-M06-09-01..04; AC-M06-09-03.

Preconditions/flow/exceptions/state now separate valid owned-device context/session reads from active/epoch/lease write guards. The suspended epoch-mismatch future seed includes historical Session/workspace and records unchanged counts; successful reading does not imply execution rights.

Source execution-use-cases.ts L16–28,L32–36,L73–90; agentd index.ts L91–103.

### 5. F-DEL-05 — closed

`REQ-DEL-M07-10` — BR-DEL-M07-10-03; AC-M07-10-01.

Contract and plan use documents[].document_code, explicitly observe document_code=A/revision=1 and use that field for the current-set revision check. No code alias remains in the asserted manifest shape.

Source guidance.ts L236–242,L252–260,L288–309.

### 6. F-DEL-06 — closed

`REQ-DEL-M10-04` — BR-DEL-M10-04-02; AC-M10-04-02.

Future seed explicitly contains enabled S r1 installation, alias review/generation3, active current reader and no external grant. It observes a successful nonempty baseline manifest before adding an active external member; rejection and unchanged installation state now follow from the stated seed.

Source skills-run.ts L18–35; skills-access.ts L92–101.

### 7. F-DEL-07 — partially_closed

`REQ-DEL-M10-02` — BR-DEL-M10-02-02/-04; AC-M10-02-01/-02/-03.

Source-versus-target revision precedence, catalog re-filtering and installation list rules are corrected. Positive source/target actors and future fixture status are explicit. One residual precondition improperly places supplied-project access only in the target-only branch; see F-DEL-07-R1 below.

Source skills-access.ts L55–61,L103–115; skills-use-cases.ts L65–73,L87–101,L215–236; route skills.ts L20–22.

### 8. F-DEL-08 — closed

`REQ-DEL-M09-04` — BR-DEL-M09-04-01/-03; AC-M09-04-01/-03.

All branches now state exact audit effects: create-and-link adds two kinds once, fresh existing-defect link adds only defect_linked, replay adds neither. New independent triaged-existing-defect plan records initial counts and preserved defect/task state.

Source testing-use-cases.ts L271–284,L299–306.

Every closure above covers the linked structured BR/specification, AC, verification plan, requirement content and the module BR/AC/test-matrix copies. The four module files are byte-equivalent as text to their requirement_document.content_markdown. This confirms propagation; the semantic conclusions come from the fixed-source checks, not from duplicate prose.

## Remaining actionable qualification

F-DEL-07-R1 [P2], original F-DEL-07 partially closed. BR-DEL-M10-02-02/-04 and AC-M10-02-03 now distinguish source-priority detail visibility from target-only delivery/catalog/installation filtering correctly, but specification.preconditions[1] says current project access is required only after source.read is absent. The public getSkill chain first calls lockSkillReadScopes; whenever projectCode is supplied it requires that project to exist and assertProjectAccess succeeds, before detail/skillVisibleRevisions chooses the source.read branch. Therefore independent source.read does not bypass access to an explicitly supplied project context. The same precondition is repeated in requirement content_markdown, tsp-doc/DEL rule document content and the M10 module narrative. Existing positive S/A fixtures already have target access, so they do not expose this residual qualification.

Correction: Before describing source visibility precedence, add the independent request-scope precondition: if project_code is supplied, the project must exist and the actor must have current project read access, regardless of source.read. Source.read then governs which revisions detail can expose after that scope check. Reconcile the structured precondition, narrative and module copy; retain the corrected catalog/detail distinction. Extend the AC-M10-02-03 planned comparison with an independent source-readable actor lacking P access: detail without project context remains source-readable, whereas detail with project=P is rejected without byte delivery. Keep it a future not_run fixture; no new product change or acceptance execution is needed for this editorial qualification.

| Fixed-source path | SHA-256 | Lines |
| --- | --- | --- |
| `packages/application/src/skills-use-cases.ts` | `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6` | 65–73 |
| `packages/application/src/skills-access.ts` | `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d` | 55–61 |
| `packages/application/src/skills-access.ts` | `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d` | 103–115 |
| `apps/core-api/src/routes/skills.ts` | `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea` | 20–22 |

## Public HTTP supplement

The added boundary prose is supported within the inspected static scope:

- Testing write routes declare 10 MiB bodies; provided steps require both action and expected. Schema array max100 and domain tags/report_urls max30 are distinguished. Missing expected defaults in the normalizer are not promised through HTTP.
- Skills write schemas declare additionalProperties:false at body/file levels, files1–200, positive revisions and nonnegative base_generation. Decoded 6 MiB and request 10 MiB are separate limits. The prose does not claim actual AJV removal/rejection behavior was tested.
- Defects has no custom body budget/full body schema; it inherits server1 MiB. status/severity/to enum checks and String conversion of other fields are described without invented nonempty/strict guards.
- Middleware supplies principal, with cookie/bearer and environment-controlled legacy handling; these generic routes are not incorrectly described as execution bearer-only. Project checks remain inside use cases. Server body overflow maps to 413 request_body_too_large, other schema errors retain Fastify handling, and unmapped business codes fall back to400.

| Fixed-source path | SHA-256 | Inspected lines |
| --- | --- | --- |
| `apps/core-api/src/routes/testing.ts` | `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240` | 7–92 |
| `apps/core-api/src/routes/defects.ts` | `5a764edd4920b410f19d97fc80c4ff79137a2d07a7f3cf69eb054902d50103f0` | 27–77 |
| `apps/core-api/src/routes/skills.ts` | `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea` | 7–66 |
| `apps/core-api/src/server.ts` | `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada` | 68–75 |
| `apps/core-api/src/server.ts` | `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada` | 155–168 |
| `apps/core-api/src/auth.ts` | `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8` | 37–128 |
| `apps/core-api/src/error-status.ts` | `07b66849ff69f858795b40ff28f0a6fada2401106b5360fdb40afae96ce18933` | 261–264 |
| `packages/application/src/testing-content.ts` | `7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7` | 14–16 |
| `packages/application/src/testing-use-cases.ts` | `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858` | 245–250 |

## Evidence and limits

Current counts: 32 requirements,126 BRs,73 ACs and73 linked plans. All124 unique cited anchors across46 paths match source SHA-256 and valid ranges. Current BR text,AC text and plan preconditions/expected observations are present in module copies. None of these mechanical checks is business execution or broad semantic proof.

- This is a targeted recheck of F-DEL-01..08 against delivery.json SHA-256 6e8dfe2c12c4d4ece8be222a09aaf17ef45f414c7e5398b6558f285d0e34747f, plus the requested public HTTP/strict-schema/domain-boundary supplement. The per-finding closure ledger is in delivery-recheck.md; findings lists only the remaining F-DEL-07 qualification.
- No API, actual business state, Git, clone/junction/binary experiment, business tests, acceptance scenario or agent process was executed. New fixture statements are future/not_run designs, not reproducibility receipts.
- Original F-DEL-01..06 and F-DEL-08 are closed at specification level; F-DEL-07 is partially closed with one request-scope qualification remaining. Closure does not fix product limitations or approve current behavior.
- All four module files exactly match their requirement_document.content_markdown; all current structured BR text, AC text, plan preconditions and expected outcomes were found in their module copies. 32 requirements/126 BR/73 AC/73 plans were counted; 124 unique source evidence anchors across 46 files passed hash/range checks. These are consistency and provenance checks, not semantic proof.
- The public HTTP supplement was source-read in routes/testing.ts, routes/defects.ts, routes/skills.ts, relevant server.ts/auth.ts and error-status.ts. Actual AJV additional-property behavior, schema error rendering, deployment auth configuration, request byte budgets and status responses were not executed.
- No renewed full review of unmodified requirements, all schema constraints, database interleavings, OS/Git behavior, external recovery or complete product coverage is claimed. Initial independent-pass limits, including briefly surfaced pre-existing context target prose, continue to apply; no old experiment PRD/reference answer artifacts were newly opened.
- The initial JSON/Markdown and delivery.first-pass.json were not overwritten. Root merge, whole-pack CLI validation and any human/business approval remain outside this recheck.

Preserved initial report hashes: JSON `c80d2608c202f563b3fb42f15fb7d9bb20726e960461c11c2837d435ed3b67fd`; Markdown `11eae5e37ede4d2044549112083e131c036fa0ddc168f31aa2f5a69b55e46a54`.
