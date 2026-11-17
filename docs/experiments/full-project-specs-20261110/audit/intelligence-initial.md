# Intelligence initial semantic review

Verdict: **needs_revision**. Ten concrete warnings need reconciliation. This is a bounded independent static review, not business approval, a security proof or an accuracy percentage.

The reviewed first-pass part remains unchanged. No source/candidate edits, business API operations or application tests were performed. Only the two review files were written.

## Frozen identity

- Run: `NSG3TKRB16Y9F6Y203WB`.
- Snapshot: `06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa` (explicit draft, base commit `92728fbec04cfa34fee4421cb0a9319d1b755164`).
- Raw code snapshot manifest: `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`.
- Pack source manifest (includes knowledge material): `c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e`.
- Candidate part SHA-256: `0da4754ca520d77d34599151d4330df3df105a26bb6ffb6c874b4459c4b4666e`.
- Raw source root: `F:\workspace\team-synergy-runtime\team-synergy-user-space\.agent\code-understanding\runs\NSG3TKRB16Y9F6Y203WB\source` (from pack/intake.sources.local.json).

## Scope and evidence strength

Read all 43 structured requirements/BR claims and their 86 ACs plus 86 linked verification plans for consistency, with module rule/traceability representations and discovery limits. Source-deep review sampled 30 requirements at the boundaries below. This counts reviewed artifacts, not correctness or test coverage.

| Chapter | Source-deep sampled keys | Main boundaries inspected |
|---|---|---|
| M08 | 01, 03, 05, 06, 07, 08 | Aggregation/read vs edit; optional CAS; architecture create/revise permission, mandatory CAS and preview invalidation; prototype omitted associations, no equivalent CAS; decoded attachment restrictions and historical download. |
| M11 | 02, 04, 05, 06, 07, 08 | Fixed-run knowledge/source matching and drift gates; submit/replace completed-source protection; review skip/bind gates; kind/ID selection; savepoints and partial failure; legacy running attempts, retry and stop boundaries. |
| M12 | 01, 02, 03, 04, 05, 06 | All application job methods; bounded eligibility and created_at ordering; requester-only views/dispositions; token/lease checks; separate completion/adoption; runtime profile, prompt, strict proposal and shutdown. |
| M13 | 08, 09, 10, 11, 12 | Metrics role/formula; actual READ ONLY transaction/deadline; schema/RLS/5000-row tenant inventory guards and pending flags; exact distribution whitelist; installer hash/archive checks and actual payload/activation boundaries. |
| M14 | 01, 03, 04, 05, 06, 07, 08 | Plugin locks/version/digest checks; real lifecycle enums/creator checks; per-excerpt and cumulative budgets; metadata/provenance screen limits; compose/select kinds and CAS; native-copy query and remote ACL; native reader build/load/message/CSP; document-only export vs raw-source bridge. |

At least two high-risk requirements per chapter were checked in raw source. A sampled key means its named boundaries were checked, not exhaustive verification of the entire requirement. No finding turns an unknown business choice into an approved policy.

## Findings

### INT-INITIAL-001 — warning — REQ-INT-M08-05

INT-INITIAL-001; BR=BR-INT-M08-05; AC=AC01/AC02 only cover revisions; field=specification.actor/preconditions[0]; content_markdown; module BR row. The combined create/revise contract requires architecture owner/manager status for writing. createDocument actually permits any current writable member; only reviseDocument adds the owner/manager predicate. This hides a valid Member creation path.

Evidence:

- `packages/application/src/architecture-document-use-cases.ts` L103–L118 @ `07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592`.
- `packages/application/src/architecture-document-use-cases.ts` L122–L129 @ `07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592`.

Suggested reconciliation: Separate create eligibility (current project write access) from revise eligibility (write plus owner/manager). Reconcile the structured fields and module rules, and add a Member-create acceptance case if creation eligibility is meant to be verified.

### INT-INITIAL-002 — warning — REQ-INT-M08-05

INT-INITIAL-002; BR=BR-INT-M08-05; AC=AC01/AC02 do not test XML screening; field=specification.exceptions[1]; content_markdown; module BR row. The exception states invalid XML is rejected. hasXmlRoot only screens DOCTYPE/ENTITY, root name, and an ending root tag; it does not parse XML well-formedness. The malformed text <mxfile><foo></mxfile> satisfies these inspected conditions. This is a static counterexample, not an executed business test.

Evidence:

- `packages/application/src/architecture-document-content.ts` L25–L33 @ `4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7`.
- `packages/application/src/architecture-document-content.ts` L58–L69 @ `4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7`.

Suggested reconciliation: Describe the implemented root/tag/DOCTYPE screen precisely. Preserve full XML parsing, rendering correctness and security assurance as unverified rather than promising rejection of every invalid XML document.

### INT-INITIAL-003 — warning — REQ-INT-M08-08

INT-INITIAL-003; BR=BR-INT-M08-08; AC=AC01/AC02; field=evidence[1]; content_markdown source list; module BR source column. The cited application range L217-L252 covers the end of createPrototype and start of listPrototypes, not file download authorization or historical revision selection. The route evidence supports response headers, but the decisive application rules are in getPrototypeFile L408-L435.

Evidence:

- `packages/application/src/design-prototype-use-cases.ts` L217–L252 @ `8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c`.
- `packages/application/src/design-prototype-use-cases.ts` L408–L435 @ `8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c`.
- `apps/core-api/src/routes/design-prototypes.ts` L67–L82 @ `26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f`.

Suggested reconciliation: Replace the application evidence anchor with L408-L435 at the same fixed file hash in every affected representation. Keep the route L67-L82 anchor for download headers. The correctly located implementation otherwise agrees with the described revision/file behavior.

### INT-INITIAL-004 — warning — REQ-INT-M11-06

INT-INITIAL-004; BR=BR-INT-M11-06; AC=AC01 covers writer failure, not mapping drift; field=specification.exceptions[0]; content_markdown; module BR row. The exception groups permission/plan/mapping changes as stopping all later processing. Changed source bindings or bind-target fingerprints discovered inside applyNext occur inside the item savepoint. Non-retryable DomainError becomes this item failed, after which applyNext returns true; independent later items can continue. Preflight mapping checks and per-item checks have different failure scopes.

Evidence:

- `packages/application/src/intake-use-cases.ts` L325–L336 @ `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`.
- `packages/application/src/intake-use-cases.ts` L376–L388 @ `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`.
- `packages/application/src/intake-use-cases.ts` L405–L419 @ `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`.
- `packages/application/src/intake-use-cases.ts` L453–L463 @ `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`.

Suggested reconciliation: Separate global authorization/plan failure, new-attempt preflight rejection, and per-item mapping/target drift. State failed/blocked/continued behavior at each boundary. Add a deterministic post-preflight mapping-drift case with an independent later item rather than treating it as a batch-stop assertion.

### INT-INITIAL-005 — warning — REQ-INT-M13-09

INT-INITIAL-005; BR=BR-INT-M13-09; AC=AC01; field=verification_plan[0].preconditions/steps/expected; content_markdown AC01 plan. The plan uses a SELECT-only role and treats a rejected INSERT in withReadOnlySnapshot as proof of the database READ ONLY transaction guard. It can pass solely from lack of INSERT privilege even if that guard regresses. Source inspection does show BEGIN ... READ ONLY; the proposed check does not isolate that mechanism.

Evidence:

- `packages/persistence/src/read-only-snapshot.ts` L17–L34 @ `119e24194766f4055441ee4fddc9964b53b9eb245515db773c9ba4afa2cca6b6`.

Suggested reconciliation: Use a disposable role/table with demonstrated INSERT permission in a control transaction outside the wrapper, then assert rejection specifically inside READ ONLY (and/or assert transaction_read_only). Keep timeout/client-release assertions as a separate case with an explicit blocking stub or query.

### INT-INITIAL-006 — warning — REQ-INT-M13-12

INT-INITIAL-006; BR=BR-INT-M13-12; AC=AC01/AC02 do not test incomplete payload activation; field=specification.main_flow[2]/data_contracts[0]; content_markdown; module BR row. The claim says the complete runtime payload is checked. Both installers only check runtime/node(.exe) and apps/cli/dist/index.js before activating tsp and agentd shims. They do not check agentd entrypoints, launchers or dependency completeness. The shared marker listing also names .tsp-install.json for both platforms, while POSIX uses .tsp-install.

Evidence:

- `scripts/cli-install/install.ps1` L57–L72 @ `9cab5570cf3f5e30139422f0033324c95925f57ced690dad7a6744b4bc279298`.
- `scripts/cli-install/install.sh` L33–L40 @ `edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f`.
- `scripts/cli-install/install.sh` L68–L80 @ `edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f`.

Suggested reconciliation: Narrow the observed payload checks to the two actual file-existence checks and distinguish the Windows/ POSIX marker names. Keep complete executable-payload validation as a proposed follow-up, with a future missing-agentd/launcher fixture that can expose the current behavior.

### INT-INITIAL-007 — warning — REQ-INT-M14-03

INT-INITIAL-007; BR=BR-INT-M14-03; AC=AC01/AC02; field=specification.state_changes[0]; content_markdown. The lifecycle uses registered and scanning as if they were persisted statuses. The fixed schema has preparing, indexing, awaiting_agent, validating, uploading, succeeded, failed and cancelled; registration persists preparing. The progress check prevents backwards transitions but does not require every intermediate state.

Evidence:

- `packages/contracts/src/code-understanding.ts` L41–L44 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`.
- `packages/application/src/code-understanding-use-cases.ts` L119–L136 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`.

Suggested reconciliation: Use the actual status enum and distinguish conceptual registration/scanning actions from stored status values. Do not imply a mandatory transition through every intermediate state.

### INT-INITIAL-008 — warning — REQ-INT-M14-04

INT-INITIAL-008; BR=BR-INT-M14-04; AC=AC01 checks cumulative budget only; field=specification.business_rules[0]; content_markdown; module BR row. The BR calls 2400 characters/60 lines a per-excerpt limit. CodeEvidenceSchema limits one snippet to 1200 characters, and validateCodeArtifact limits one line range to at most 30 lines. 2400 characters/60 distinct lines is the cumulative budget, including server aggregation by project plus source-byte hash.

Evidence:

- `packages/contracts/src/code-understanding.ts` L16–L16 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`.
- `packages/contracts/src/code-understanding.ts` L137–L150 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`.
- `packages/application/src/code-understanding-use-cases.ts` L80–L98 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`.

Suggested reconciliation: State separate per-excerpt (1200 characters, at most 30 lines, not a full file) and cumulative limits (2400 characters, at most 60 distinct lines, less than the full file). Add future boundary cases for 1200/1201 and 30/31 separately from repeated-run aggregate limits.

### INT-INITIAL-009 — warning — REQ-INT-M14-04

INT-INITIAL-009; BR=BR-INT-M14-04; AC=AC01 does not prove universal privacy/full-source exclusion; field=specification.exceptions[0]/data_contracts[0]; module/feature summaries and repeated prose. The prose universally says full source/private content is rejected or cannot reach the service. The inspected implementation provides strict fields, excerpt limits and known sensitive-text checks. The additional full-source screen exact-hashes strings only inside optional ua_graph and only against known files of at least 16 bytes. This does not establish that arbitrary source/private text embedded in free-text metadata is impossible; the statement exceeds the mechanism. No exploit or runtime security result is claimed here.

Evidence:

- `packages/contracts/src/code-understanding.ts` L16–L18 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`.
- `packages/contracts/src/code-understanding.ts` L79–L83 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`.
- `packages/contracts/src/code-understanding.ts` L131–L150 @ `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`.
- `packages/application/src/code-understanding-use-cases.ts` L69–L77 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`.
- `packages/application/src/code-understanding-use-cases.ts` L139–L150 @ `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`.

Suggested reconciliation: Describe the specific schema, path/known-pattern, excerpt and exact-string UA metadata screens. Retain arbitrary free-text/private-content exclusion and semantic correctness as unproven. Reconcile broad service-privacy wording in M14 module/features/document and REQ fields; no source implementation change is requested by this review.

### INT-INITIAL-010 — warning — REQ-INT-M14-07

INT-INITIAL-010; BR=BR-INT-M14-07; AC=AC01/AC02 do not verify asset digest enforcement; field=specification.exceptions[0]; content_markdown; module BR row. The exception promises an error on reader resource digest mismatch. The React loader fetches reader.js and reader.css, checks only HTTP response.ok, and embeds the returned text. The build checks UA version and writes asset digests into a manifest, but no inspected runtime code reads/compares those digests. Build provenance is not runtime asset-integrity enforcement.

Evidence:

- `apps/web/src/UaNativeReader.tsx` L19–L29 @ `9d51872ebca91cdf7b90a04693e46f041a8671b0b257249995f56c524c2fc0a1`.
- `scripts/build-ua-reader.mjs` L16–L18 @ `9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3`.
- `scripts/build-ua-reader.mjs` L70–L78 @ `9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3`.
- `scripts/build-ua-reader.mjs` L111–L117 @ `9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3`.

Suggested reconciliation: Separate build-time version/self-contained bundle checks and recorded digest provenance from runtime HTTP/load errors. Remove the unsupported digest-mismatch error guarantee or explicitly mark runtime digest verification as proposed, and keep sandbox/CSP assertions bounded to the inspected controls.

## Reviewed keys

REQ-INT-M08-01, REQ-INT-M08-02, REQ-INT-M08-03, REQ-INT-M08-04, REQ-INT-M08-05, REQ-INT-M08-06, REQ-INT-M08-07, REQ-INT-M08-08, REQ-INT-M11-01, REQ-INT-M11-02, REQ-INT-M11-03, REQ-INT-M11-04, REQ-INT-M11-05, REQ-INT-M11-06, REQ-INT-M11-07, REQ-INT-M11-08, REQ-INT-M12-01, REQ-INT-M12-02, REQ-INT-M12-03, REQ-INT-M12-04, REQ-INT-M12-05, REQ-INT-M12-06, REQ-INT-M13-01, REQ-INT-M13-02, REQ-INT-M13-03, REQ-INT-M13-04, REQ-INT-M13-05, REQ-INT-M13-06, REQ-INT-M13-07, REQ-INT-M13-08, REQ-INT-M13-09, REQ-INT-M13-10, REQ-INT-M13-11, REQ-INT-M13-12, REQ-INT-M13-13, REQ-INT-M14-01, REQ-INT-M14-02, REQ-INT-M14-03, REQ-INT-M14-04, REQ-INT-M14-05, REQ-INT-M14-06, REQ-INT-M14-07, REQ-INT-M14-08

## Not checked and remaining limits

- All 43 requirement specifications, 86 ACs and 86 plans were read for consistency; source-deep work is a targeted static boundary sample, not every assertion or every branch. Keys without a complete source-deep sample: REQ-INT-M08-02, REQ-INT-M08-04, REQ-INT-M11-01, REQ-INT-M11-03, REQ-INT-M13-01, REQ-INT-M13-02, REQ-INT-M13-03, REQ-INT-M13-04, REQ-INT-M13-05, REQ-INT-M13-06, REQ-INT-M13-07, REQ-INT-M13-13, REQ-INT-M14-02.
- No business tests, API writes, model calls, database diagnostics, installer execution, deployment/proxy checks or security exploit tests were run. All verification plans remain future checks and existing test references remain defined, not passed.
- No exhaustive review of all dynamic SQL, nested JSON, historical manifests, complete audit semantic redaction, production tenancy/RLS, cross-customer policy or arbitrary private-content leakage was performed.
- The current-vs-future customer/RLS and owner-approval boundaries remain unknown/business-review matters; a static implementation observation is not a business decision or security proof.
- The root global dossier, other lanes and 13 global artifacts were outside this review. Intentional collaboration/home/document cross-part references were not treated as missing local candidates. Older experiment answer documents were not read.
- Navigation/query result files were not rerun or treated as semantic authority. This review uses the fixed raw source through the pack mapping, not the active checkout. Some declared evidence ranges were sampled; a valid hash/range alone does not prove support.
- Future plugin versions, real three-platform installation, external DSH/provider behavior, network/storage enforcement in a live browser and real HTTP boundary payloads remain untested.

## Review inputs

| Path | SHA-256 |
|---|---|
| `parts/intelligence.first-pass.json` | `0da4754ca520d77d34599151d4330df3df105a26bb6ffb6c874b4459c4b4666e` |
| `modules/m08-intelligence.md` | `6d366d85d46f008467cc16b0dc8f4d7ef279ab55d232ec872239553b0638a93d` |
| `modules/m11-intelligence.md` | `79a412144c7e6a9e40640721d845cac040adebbc703c79f6dd609b81e090a8c9` |
| `modules/m12-intelligence.md` | `a605c1a0b03c4b278c187890b7f99bf431ab5c30006bb3d56cbdb750ccfeb9b4` |
| `modules/m13-intelligence.md` | `1f998ccb56b29d0aee7ba20637e19a001b01ca93facc62cb0e41c8f532ca678c` |
| `modules/m14-intelligence.md` | `d52d421984c229c25a668e5984a29835ddea8d6d39bd02f2a0eb740cddb6067c` |
| `discovery-intelligence.md` | `530d5938053d476fee28fc530fad15e0174ce0fd36c024ae3e9f4e85f31a1740` |
| `pack/SKILL.md` | `e45f2e323d9d9cc22292c061ba5f5d10bf3ac230629abe3b8a8ddf4693125bf9` |
| `pack/AGENT.md` | `189045668e2e21dedfe4eea3733eaba13e14b0d5acd994ec5488a7a76de318d2` |
| `pack/references/business-rules.md` | `126a50169e025996f8cc8009cfbfa0bb3f0ef33b02af39e64207ff6efd239a63` |
| `pack/references/evaluation.md` | `514a4b0abf5f56d0eec9b8a9a5b958107186da0ef19d4c88843ca98900281a9e` |
| `pack/references/evaluation.schema.json` | `6f634c3dbdd2be2923aa36191c1e28f9a446c37b69c766206bf38f1ba3bb5b0a` |

The JSON follows the supplied evaluation schema; finding IDs, BR/AC identifiers and affected fields are recorded within `claim` because that schema does not define separate ID/BR/AC/field properties. Initial findings are preserved; any correction recheck must be written to separate files.
