# Shared findings closure recheck

Verdict: **closed_with_limits** for initial findings 1–4. No new finding in this bounded recheck. This is not business approval or executed acceptance.

Frozen merged pack SHA-256: `c6fa5ca8a3b23ef5dc619bc2fb892cafa113b7fae45e023079e3ad7308639093`.
Initial report SHA-256: `9cccd9a397c4761f40e1fbba59f3c0b2348127fe45056c06fcec9164d7693d02`.

## Closure evidence

### Finding 1: closed_with_limits

Task and Run now have separate rows. The Task row gives its main success path and recovery branches; Run lists its actual independent persisted enum and explicitly says it is not a linear sequence. RunStatusSchema is directly anchored.

Checked representations: `parts/shared.json:tsp-doc-domain`, `pack/intake.json:tsp-doc-domain`, `dossier/domain.md`.

- `packages/domain/src/task-state-machine.ts:17–29` SHA-256 `2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26`
- `packages/contracts/src/schemas.ts:81–83` SHA-256 `7b6e3612dd96c833a0cc802c582c400c81ec7fac6cd8ffc8b6ba0a77c76349f2`

### Finding 2: closed_with_limits

M03 includes an explicit per-requirement module/document override for tsp-req-home-binding. The context table labels its chapter parent as primary and shows the exception; readable M03 navigation renders the actual documents module, feature and document. Existing home requirement and feature remain in tsp-module-documents with tsp-doc-documents; no reparent was applied. All 112 chapter requirement mappings resolve to actual candidate module/document values after applying overrides.

Checked representations: `chapter-map.json:M03.requirement_overrides`, `parts/shared.json:tsp-doc-context`, `pack/intake.json:tsp-doc-context`, `dossier/context.md`, `modules/m03-structure.md:38`, `pack/intake.json:tsp-req-home-binding/tsp-feature-project-home`.

- `packages/application/src/project-home-use-cases.ts:40–68` SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`

The raw source supports the home capability. The generated chapter/feature/requirement objects establish navigation identity equality; source code does not define these platform keys.

### Finding 3: closed_with_limits

The capability, structured requirement and rule/module prose now cover supported suffixes, root/nested links, ignored directories, metadata inference/overrides, parent hierarchy, sequential requests, retained earlier successes, failure output limits, no automatic idempotent resume, and query-before-manual-repair guidance. AC03/AC04 provide independent successful-directory and deterministic later-item pre-send failure plans. Fixture/symlink permissions and failure-hook construction remain explicit pending/not_run prerequisites.

Checked representations: `parts/intelligence.json:REQ-INT-M08-03`, `pack/intake.json:REQ-INT-M08-03`, `pack/intake.json:INT-CAP-M08-03`, `pack/intake.json:tsp-doc-documents`, `modules/m08-intelligence.md`, `acceptance-matrix.md:REQ-INT-M08-03-AC03/AC04`.

- `apps/cli/src/handoff-upload.ts:29–74` SHA-256 `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`
- `apps/cli/src/handoff-upload.ts:84–122` SHA-256 `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`
- `apps/cli/src/index.ts:2089–2113` SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`
- `apps/cli/src/index.ts:2115–2181` SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

### Finding 4: closed_with_limits

The child plan, module body and shared example now explicitly fix active Member A as source document owner with current write permission and a normal session; retain active project/source document and a valid module; record r; send complete nonempty revision fields to obtain r+1; read through the same identity; expect exact project_document_source_read_only and no additional source version/body/history change. The native rule document and acceptance matrix reference the same AC without claiming it executed.

Checked representations: `parts/intelligence.json:REQ-INT-M08-01.verification_plan/REQ-INT-M08-01-AC01`, `pack/intake.json:REQ-INT-M08-01`, `pack/intake.json:tsp-doc-documents`, `modules/m08-intelligence.md`, `parts/shared.json:tsp-doc-requirements`, `pack/intake.json:tsp-doc-requirements`, `dossier/requirements.md:跨模块示例3`, `acceptance-matrix.md:REQ-INT-M08-01-AC01`.

- `packages/application/src/requirement-document-use-cases.ts:121–123` SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:384–404` SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/project-document-use-cases.ts:529–538` SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`

## Mechanical evidence

- All 13 shared items exactly equal their merged-pack items and corresponding dossier Markdown.
- All 112 chapter requirement module/document mappings resolve to actual candidate values using explicit overrides; the home-binding identities remain in the documents module.
- Targeted M08 child requirements and native rule document exactly match merged items; M08 module prose contains the repaired full requirement bodies. Shared sample 3 reproduces its child fixture, steps and expected result. The rule document references the updated ACs rather than duplicating the full plans.
- Targeted source evidence hashes and ranges validate against unchanged captured raw source; the cited code was reread for closure.
- Relevant ACs remain unexecuted in the acceptance matrix.

## Artifact fingerprints

- `parts/shared.json` SHA-256 `636331e02722c5785b3abbb51e12a119f8f229167f8d45cf57d9abd7f262966f`
- `chapter-map.json` SHA-256 `8a543487e6eaacff56a63c4d53c756703356c7310e4177140ccc52db12aa6ff5`
- `acceptance-matrix.md` SHA-256 `bc7e2b135dc41344fe3ba7cc91591df025ab4d99d70ed76f7c4ed3029c9d4476`
- `dossier/domain.md` SHA-256 `ceac4dbc49f440b54b5bcb48974e355cc214cf17ce92d9580f328a6e6fdfb8e4`
- `dossier/context.md` SHA-256 `8fda1ad7128e2b00cfc24603b1ac73368641c7d763431a0a4649f8f946707558`
- `dossier/requirements.md` SHA-256 `17f1bb18fc66dce3195de92f948281f023a327f2fbf200de681b07b53d46fbb7`
- `modules/m03-structure.md` SHA-256 `59048e8dbe769c9c7fee1ee7e323e7bdefc5e1feb926c791ac75d41d8b4c905f`
- `modules/m08-intelligence.md` SHA-256 `60cd1a30e812ed622b92adaac247bf9c770bb06c7bc4471d0c64d4e67a2821b7`

Per-item canonical fingerprints for all shared items and targeted M08/home items are saved in the JSON report.

## Limits

- This is closure of the four shared-initial findings, not a repeated full semantic review, executed acceptance or business approval.
- No business tests, API writes, database operations, browser tests, load tests, deployment, model calls or recovery drill were run. JSON/equality/hash/range checks establish artifact integrity only.
- Upload fixtures and deterministic failure hooks were not built or executed; real OS/symlink/network/recovery behavior remains unmeasured.
- Unrelated INT M14 AC05 terminology and other reviewers findings are outside this recheck. Closing these four findings does not resolve or approve the existing Owner/Admin policy choice.
- Initial reports remain unchanged. This reviewer changed no source/candidate/module/dossier, and wrote only shared-recheck.json/md.
