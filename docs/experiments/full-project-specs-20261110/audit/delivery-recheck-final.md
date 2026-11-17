# Delivery R1 closure recheck

**Verdict: reviewed_with_limits. F-DEL-07-R1 is closed at specification level.** No remaining finding from the original eight is open in this bounded review chain; the seven prior closures are carried forward because this patch leaves their requirements unchanged.

Reviewed part SHA-256: `5d6590b37f5c400c15205842202e9d50fe9216bd0ce7c84b192d70993d86820b`. Fixed source manifest: `0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9`; run `NSG3TKRB16Y9F6Y203WB`.

## Closure evidence

The repaired REQ-DEL-M10-02 precondition, main flow, BR-DEL-M10-02-02/-04, exception and AC-M10-02-03 now state the actual order: an explicitly supplied project context must exist and pass current project read access, independently of source.read; only afterwards does source access take precedence when selecting visible revisions. Without a project context, the independent source-visible branch remains available. This matches the public route → getSkill → lockSkillReadScopes → detail/visible-revisions chain.

AC-M10-02-03 and its plan/matrix now include N, an active source-team member explicitly lacking P access, and compare no-project source read with explicit project=P rejection without file-byte delivery. The original S/A/C positive visibility comparisons remain. The fixture is labeled future/not_run and carries no claim of deployed data or runtime success.

Both the requirement narrative and DEL-M10-RULES/module copy contain the same qualification. A structured comparison against query-delivery-r1-before.json shows only REQ-DEL-M10-02 and DEL-M10-RULES changed; other candidate items and top-level structures remain unchanged.

| Fixed-source path | SHA-256 | Lines |
| --- | --- | --- |
| `apps/core-api/src/routes/skills.ts` | `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea` | 20–22 |
| `packages/application/src/skills-use-cases.ts` | `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6` | 65–73 |
| `packages/application/src/skills-access.ts` | `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d` | 55–61 |
| `packages/application/src/skills-access.ts` | `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d` | 103–115 |
| `packages/application/src/project-access.ts` | `4501fc66a37efa3cf06a22428ca1ec3cfbcd54a1a0e269bdaffdaa170ffdc43c` | 65–71 |

## Limits and preservation

- Only residual F-DEL-07-R1 was rechecked against delivery.json SHA-256 5d6590b37f5c400c15205842202e9d50fe9216bd0ce7c84b192d70993d86820b. It is closed at specification level; see delivery-recheck-final.md for exact closure and source anchors. No new open finding remains in this bounded closure review.
- No API, business operation, Git, acceptance test, runtime auth check or fixture execution was performed. The N comparison is explicitly future/not_run with isolation/reset prerequisites; it is not a passed result or a claim that a fixture already exists.
- Diff against the preserved R1-before part changes only REQ-DEL-M10-02 and DEL-M10-RULES; other item and top-level structures are unchanged. Seven closures from delivery-recheck.md are carried forward, not re-executed or independently expanded here.
- The module file exactly matches DEL-M10-RULES.content_markdown, with updated BR/AC/plan/matrix qualifications present. Counts remain32 requirements/126BR/73AC/plans. Copy consistency and source hashes are provenance checks, not runtime proof.
- Initial and first-recheck reports remain preserved. Their earlier scope/independence limits still apply. No whole-pack semantic completeness, accuracy percentage, production guarantee, business approval or CLI-publication verdict is made.

Prior reports were not overwritten: `delivery-initial.json/.md` and `delivery-recheck.json/.md`. The current candidate was not edited.
