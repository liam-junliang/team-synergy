# Evaluate useful output and skill changes

Start with the CLI quality report. The script verifies schema, captured hashes/ranges, declared coverage links, structured specification/acceptance/plan presence and text rules. It cannot establish business truth or discover an omitted capability by itself.

## Candidate review

Give a fresh Agent the skill, candidate bundle and relevant raw sources without the writer's intended conclusions. Ask it to reconstruct a workflow and design an acceptance check from the output. Inspect the module → feature → requirement chain for every included capability; declare sampling for deeper fact checks. Check missing coverage, unsupported statements, current-versus-intended confusion, exception/recovery paths and mismatched interface/data/state details.

Evaluate ACs with their linked plan fields rather than fixed prose phrases. Try to determine the exact initial state, actions and observable result without guessing; check reset/clock/time-zone conditions where relevant. Compare repeated rules across detailed requirements and shared documents, not just within each document. Open every finding's cited range to verify that it contains the supporting fact or contradiction. Do not count a syntactically valid citation as a supported claim.

Use evaluation.schema.json for findings, reviewed_keys and not_checked. Its evidence paths, hashes and ranges refer to captured sources. For a defect visible only in generated output, identify the candidate key and field in claim, and cite the relevant source anchor; if no source anchor exists, explicitly record that limitation in a companion review note rather than fabricating one. The review schema itself does not verify evidence or make approval decisions.

Repair findings across every affected representation, then perform a focused independent recheck with the original raw evidence. Preserve the initial report and identify what was corrected. An unresolved business choice stays needs_review even when the writer has produced a coherent proposed option. Agent review is a recommendation, not human approval.

## Skill-change evaluation

Use behavioral comparison for substantive changes to this skill; ordinary document edits do not require a new benchmark campaign. Choose a realistic case that can expose the changed behavior, with a separate project or material-only case when claiming portability. Keep raw inputs, output workspaces and evaluator criteria separate.

1. Freeze raw inputs, their manifest, user request and candidate skill versions. Before examining outputs, state observable criteria such as supported facts, retained uncertainties, stable identities, consistent rules and runnable planned checks. Keep expected answers and known failure descriptions away from the producing Agents.
2. Run independent Agents on the same request and minimum raw inputs, once with the previous skill (or no skill when testing first adoption), once with the candidate. Use isolated outputs; neither writer sees the other's result or the evaluator's answer key. Record model/configuration when available and disclose differences that limit comparison.
3. Run the same protocol checks and independent semantic rubric on both. Review actual artifacts, not confidence statements or matching headings. Record criterion outcomes, unsupported claims, unresolved decisions, corrections and available time/cost observations. Mark unavailable measurements instead of guessing.
4. Keep first-pass results separate from repaired results. Improve instructions only for demonstrated decision failures; rerun the affected case after a correction and add a new case when a broader claim needs evidence. Retain remaining failures and review limits rather than averaging a blocker into a flattering score.

Each comparison record should identify the raw manifest, skill/rule versions, request, output paths, validation results, reviewer reports and conditions that differed. A single comparison shows what happened on that case; repeat runs are needed before claiming reliability or reduced variance. Evaluation artifacts stay outside production inputs unless deliberately supplied as new source material.

Report protocol portability separately from semantic quality. A successful fixture or deterministic replay proves mechanics, not enterprise readiness across arbitrary domains or standards compliance.

For increment testing, change an isolated copy of an input, prepare again and diff. Verify source drift rejection, changed evidence, stable acceptance IDs and unaffected records. Follow increments.md for semantic impact discovery beyond declared links. Never mutate a user's original material merely to demonstrate rejection.
