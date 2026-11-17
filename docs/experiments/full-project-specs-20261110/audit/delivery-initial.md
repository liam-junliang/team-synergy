# Delivery first-pass semantic review

**Verdict: needs_revision.** Three blocking specification mismatches and five bounded corrections are recorded below. This is an independent source review recommendation, not approval or an executed acceptance result.

Reviewed candidate: `parts/delivery.first-pass.json` SHA-256 `89d86276071498472a41eeb474ff201453272fbf2f175f41512a7d20293f4467`.

Fixed source root: `F:/workspace/team-synergy-runtime/team-synergy-user-space/.agent/code-understanding/runs/NSG3TKRB16Y9F6Y203WB/source`.

Run `NSG3TKRB16Y9F6Y203WB`; snapshot `06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa`; draft commit `92728fbec04cfa34fee4421cb0a9319d1b755164`; source manifest `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`; actual pack skill 2.2.0. Read pack AGENT/SKILL/business-rules/evaluation and context identity/bindings, discovery-delivery.md, and the four module-rule artifacts.

Scope: all 32 structured requirements, 123 BRs, 67 ACs and 67 linked plans were checked for internal consistency. At least two high-risk requirement chains in each of M06/M07/M09/M10 were opened in raw source. Mechanical evidence checks are separated from semantic findings.

## 1. REQ-DEL-M06-03 — blocker

F-DEL-01 [P1] BR-DEL-M06-03-04 / AC-M06-03-02; fields specification.business_rules[3], acceptance_criteria[1], content_markdown and m06-delivery-rules.md L31/L102 claim that once execution has ever started, contract editing and cancellation are permanently forbidden. The implementation checks only CURRENT draft/ready/assigned for those two operations. A previously executed task can fail verification and be reassigned to assigned; a manager with the new snapshot can then edit or cancel. Only baseline binding separately rejects ANY historical Run. This also conflicts with the rework path accurately described by REQ-DEL-M06-04.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `packages/application/src/task-service.ts` | `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f` | 366–379 |
| `packages/application/src/task-service.ts` | `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f` | 982–1005 |
| `packages/application/src/task-service.ts` | `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f` | 1055–1079 |
| `packages/application/src/task-baseline-use-cases.ts` | `cb7014fb111f34118d49d0393e0bec1c9031f6a4c99f91b6c2ca4b76b8a405ec` | 28–33 |

Correction: Describe edit/cancel as current-state guards and baseline binding as an additional no-historical-Run guard. Revise AC-M06-03-02 to distinguish currently running rejection from previously executed, failed-then-reassigned behavior. Add an independent rework fixture with completed historical Runs, assigned current state, current snapshot, manager, and no pending handover; verify edit/cancel branches separately and preserve the stricter baseline rejection. Reconcile the structured requirement and module rule table; do not change product code as part of this correction.

## 2. REQ-DEL-M07-02 — blocker

F-DEL-02 [P1] BR-DEL-M07-02-02 / AC-M07-02-02; specification.business_rules[1], acceptance_criteria[1], exceptions and plan currently present clone as being able to write ONLY below the workspace code directory. cloneRepository checks path.resolve/path.relative strings, then mkdir/git clone, without resolving or rejecting symlink/junction ancestors. A lexical code/link/new target can therefore address another physical tree. attach validation happens AFTER cloning and cannot undo a write already made. This is a source-derived boundary limitation, not an executed exploit.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `apps/cli/src/project-workspace.ts` | `aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143` | 196–216 |
| `apps/cli/src/project-workspace.ts` | `aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143` | 166–173 |
| `apps/cli/src/index.ts` | `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b` | 2654–2659 |

Correction: Limit the observed guarantee to lexical containment and an absent target; explicitly state that realpath/ancestor-link containment is not established by this implementation. Qualify AC-M07-02-02 and its normal-directory fixture. Add a future controlled symlink/junction ancestor scenario and preserve any post-clone partial-write risk; do not claim physical confinement or automatic cleanup.

## 3. REQ-DEL-M07-09 — blocker

F-DEL-03 [P1] BR-DEL-M07-09-01/-04 / AC-M07-09-02; specification.exceptions[0], verification_plan[1].expected and m07 rule exception cells universally say binary rejection happens in preflight and leaves the service unpaused. Preflight only rejects selected existing bytes containing NUL (plus LFS/submodule checks). A later git diff --numstat binary check runs in publishHandoverWorkspace after the CLI has already performed service prepare and source-stop-ack. For example, Git attributes can classify a NUL-free changed file as binary. That branch rejects publication while retaining a preparing handover and suspended source Run.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `packages/integrations/src/handover-workspace.ts` | `fd65dac16eafd549cc0e8e3e4561cd6cd6b054a09223f519bb28c42ccf17ea23` | 69–78 |
| `packages/integrations/src/handover-workspace.ts` | `fd65dac16eafd549cc0e8e3e4561cd6cd6b054a09223f519bb28c42ccf17ea23` | 88–107 |
| `apps/cli/src/handover.ts` | `621c4247a3108de12c95ceb7324cb18265962792a0b4c15a5365ad88080b2c7d` | 141–153 |
| `packages/application/src/handover-use-cases.ts` | `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e` | 325–335 |

Correction: Split early preflight errors from post-prepare binary classification errors. Keep the no-pause assertion only for failures actually found before prepare. For the later branch specify preserved preparing/suspended state, no published handover ref, and cancel plus explicit source resume recovery. Add a planned independent temporary-repository scenario using a NUL-free changed file marked -diff by .gitattributes; label this proposed check not_run.

## 4. REQ-DEL-M06-09 — warning

F-DEL-04 [P2] BR-DEL-M06-09-01/-03/-04 / AC-M06-09-01/-02; specification.preconditions[1] and module M06 L178 impose active Run plus equal task/Run epoch on every trigger, including execution context and session-list reads. requireOwnedRun checks owner, active user, valid owned device and project READ access, but not active Run or epoch equality. context and sessions return historical/suspended Runs. agentd resume depends on reading a suspended Run before explicitly restoring it. Lease mint and execution writes enforce additional active/epoch rules separately.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `packages/application/src/execution-use-cases.ts` | `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6` | 16–28 |
| `packages/application/src/execution-use-cases.ts` | `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6` | 32–36 |
| `packages/application/src/execution-use-cases.ts` | `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6` | 73–90 |
| `apps/agentd/src/index.ts` | `3a13c99cadace468ca30cd740340bb0930a9eb06eb53c358bce451a565936fc3` | 91–103 |

Correction: Scope active/equal-epoch preconditions to lease mint/renew/start/state writes. State that owned valid-device read context/sessions remains available for suspended/completed or mismatched-epoch Runs subject to current read access. Add a read-versus-write negative scenario so future implementation does not break resume/history by enforcing the current broad prose.

## 5. REQ-DEL-M07-10 — warning

F-DEL-05 [P3] BR-DEL-M07-10-03 / AC-M07-10-01; specification.data_contracts[0], content_markdown and m07-delivery-rules.md L199 name manifest documents[].code. The generated manifest entries use document_code, and checkWorkspaceGuidance keys on entry.document_code. The specified field would not reconstruct a compatible manifest.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `apps/cli/src/guidance.ts` | `6833e29cbb1ef35482f7d2b60deda922edef985e30a09d30ed42469677d7c1c7` | 236–242 |
| `apps/cli/src/guidance.ts` | `6833e29cbb1ef35482f7d2b60deda922edef985e30a09d30ed42469677d7c1c7` | 252–260 |
| `apps/cli/src/guidance.ts` | `6833e29cbb1ef35482f7d2b60deda922edef985e30a09d30ed42469677d7c1c7` | 288–309 |

Correction: Replace documents[].code with documents[].document_code in all repeated contracts. Include the exact field in the planned manifest observation for AC-M07-10-01.

## 6. REQ-DEL-M10-04 — warning

F-DEL-06 [P2] BR-DEL-M10-04-02 / AC-M10-04-02; verification_plan[1].preconditions and TC-M10-04-02 only seed a published team skill that is eligible for delivery, with no explicit enabled ProjectSkillInstallation. After an external member is added, projectSkillManifest iterates enabled installations only; a perfectly valid interpretation of this fixture has no installation and returns an empty manifest, rather than the required skill_delivery_blocked. The plan currently needs an unstated seed to reproduce its expected result.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `packages/application/src/skills-run.ts` | `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9` | 18–35 |
| `packages/application/src/skills-access.ts` | `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d` | 92–101 |

Correction: Seed an explicit enabled installation of r1 with alias and known generation before adding the external member, plus an active actor with current project read access. Observe a successful baseline manifest containing r1 first. Then add an active external project member with no source-team role and request the same manifest; ensure no other explicit grant authorizes external delivery. Keep this as a future plan, not an executed fixture.

## 7. REQ-DEL-M10-02 — warning

F-DEL-07 [P2] BR-DEL-M10-02-02 / AC-M10-02-01/-02; specification.main_flow[2] and business_rules[1] state that ordinary project members can read only the installed delivery revision. That is true of the target-only branch and non-owned project catalog filtering, but not universal for show/download: skillVisibleRevisions returns the SOURCE-access branch first, even with a project context. A project member who also has source.read can read all source-visible published revisions; source authors/managers can also see permitted drafts. The candidate does mention retained source maintenance rights, but does not state this branch precedence or the catalog/detail distinction.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `packages/application/src/skills-access.ts` | `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d` | 103–115 |
| `packages/application/src/skills-use-cases.ts` | `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6` | 55–73 |
| `packages/application/src/skills-use-cases.ts` | `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6` | 87–101 |

Correction: Qualify the installed-only detail rule with no independent source.read permission; state source-access precedence separately and distinguish detail from non-owned project catalog filtering and installation list. Explicitly seed target-only C/O with no source scope access in the existing plans, and add a source-member-plus-target-member detail case to avoid a false privacy expectation.

## 8. REQ-DEL-M09-04 — warning

F-DEL-08 [P3] BR-DEL-M09-04-01/-03 / AC-M09-04-01; specification.main_flow[3] and m09-delivery-rules.md L91 say the transaction supplements defect_code and two kinds of audit for either existing-link or new-defect flow. The source inserts defect.reported only when it creates a new defect, inserts test_execution.defect_linked for a fresh existing link, and returns before any audit on same-defect replay. The broad two-audit statement overstates those latter branches.

Evidence (all paths relative to the fixed source root):

| Path | SHA-256 | Lines |
| --- | --- | --- |
| `packages/application/src/testing-use-cases.ts` | `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858` | 271–284 |
| `packages/application/src/testing-use-cases.ts` | `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858` | 299–306 |

Correction: Describe audit effects by branch: create-and-link produces defect.reported plus test_execution.defect_linked; fresh existing-defect link produces the latter only; same-defect replay produces neither. Add these audit-count observations to the corresponding planned scenario without asserting that the test already ran.

## Checked evidence and retained limits

The exact first-pass candidate hash matched the assignment. All 111 unique candidate evidence anchors across 40 paths had matching file hashes and valid ranges. The four module documents repeated every structured BR and AC consistently; that consistency propagates the semantic errors above rather than curing them. Every declared existing-test name was located, and no passed/failed execution status was asserted.

Source-deep coverage included claim and verifier transactions; current-state versus historical baseline guards; owner/device, epoch, lease and session identity; handover prepare/restore/ready/activate/cancel/drift/resume receipts and preserved state; cleanup movement and Git boundaries; guidance current-set/revision behavior; testing immutable snapshots and defect audit boundaries; source/target grant visibility; generation-locked installations; fixed and legacy Run manifests; and staged local skill sync.

- No API, mutation, business test, acceptance scenario, actual clone, junction/symlink experiment, binary-Git experiment, database transaction failure injection, agent process or external-service interaction was executed. Findings are static source review; proposed counterexamples are not runtime receipts.
- All 32 requirement specifications, 123 BRs, 67 ACs and 67 plans were read for internal consistency; source-deep checks were bounded. REQ-DEL-M06-02, REQ-DEL-M06-06 and REQ-DEL-M06-08 were not reconstructed end-to-end in raw source in this independent pass.
- Deep inspected examples include M06 claim/verification/baseline and assignment/history/lease/agentd; M07 workspace/repository/cleanup/handover request receipts, epochs, recovery and guidance; M09 versioned definitions/execution snapshots/failed-result defects and legacy transitions; M10 content validation/source visibility/grants/install generations/fixed Run manifests/local staged sync. This is not exhaustive raw-source coverage of every cited range or all runtime interleavings.
- 111 unique candidate evidence anchors across 40 paths had matching SHA-256 and valid 1-based ranges; all declared test names were found and statuses remained defined/not_run. These mechanical checks do not prove semantic truth or executed acceptance.
- Excluded/unknown capability reasons were compared with fixed docs18/43/44 and the inspected contracts/agentd paths. No repository-wide absence proof or complete discovery claim is made; UA/codegraph navigation results were not independently rerun.
- Root merge must verify cross-part parent references and whole-pack schema/CLI validation. Shared tsp-module-collaboration identity was intentionally accepted and is not reported as a duplicate.
- Independence limit: context.json enumeration briefly surfaced pre-existing target summaries/document prose. Those statements were not used as evidence or expected findings. No older experiment PRD files or reference-answer artifacts were opened.
- No business-owner approval, accuracy percentage, full-runtime guarantee, performance SLO or complete-product coverage is established.

## Reviewed keys

- `REQ-DEL-M06-01`
- `REQ-DEL-M06-02`
- `REQ-DEL-M06-03`
- `REQ-DEL-M06-04`
- `REQ-DEL-M06-05`
- `REQ-DEL-M06-06`
- `tsp-req-task-verification`
- `REQ-DEL-M06-08`
- `REQ-DEL-M06-09`
- `REQ-DEL-M06-10`
- `REQ-DEL-M07-01`
- `REQ-DEL-M07-02`
- `REQ-DEL-M07-03`
- `REQ-DEL-M07-04`
- `REQ-DEL-M07-05`
- `REQ-DEL-M07-06`
- `REQ-DEL-M07-07`
- `REQ-DEL-M07-08`
- `REQ-DEL-M07-09`
- `REQ-DEL-M07-10`
- `REQ-DEL-M09-01`
- `REQ-DEL-M09-02`
- `REQ-DEL-M09-03`
- `REQ-DEL-M09-04`
- `REQ-DEL-M09-05`
- `REQ-DEL-M10-01`
- `REQ-DEL-M10-02`
- `REQ-DEL-M10-03`
- `REQ-DEL-M10-04`
- `REQ-DEL-M10-05`
- `REQ-DEL-M10-06`
- `REQ-DEL-M10-07`
- `tsp-doc-collaboration`
- `tsp-doc-workspace`
- `DEL-M09-RULES`
- `DEL-M10-RULES`
- `DEL-CAP-M09-PLAN`
- `DEL-CAP-M06-CHAIN-POLICY`
- `DEL-CAP-M10-FUTURE`

The first-pass candidate and module files were not edited. A subsequent repair/recheck must be a separate report and must retain this initial record.
