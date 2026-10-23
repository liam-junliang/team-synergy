# Scope and consequential clarification

Choose the smallest scope that satisfies the request. Record it in source.production.scope_statement and, when useful, a short scope note beside intake.json. Do not add private workflow fields to the intake protocol.

| Request | Useful first deliverable | Completion boundary |
| --- | --- | --- |
| Understand an existing product | Capability inventory followed by priority scenarios | Report discovered, specified, excluded and unknown coverage separately; a few deep examples do not complete the inventory. |
| Specify a change or repair | Current behavior, intended outcome, compatibility boundaries and affected scenarios | Cover the change and its interactions; do not require a full enterprise reconstruction first. |
| Work from team materials | Source register, reconciled statements and testable intended capabilities | Mark implementation and execution as unverified when no code/runtime evidence is available. |

Use the selected pack profile for its actual rules. A pilot scope does not bypass an enterprise blocker in an enterprise pack. Keep a broad requested inventory broad, but progress in bounded capability groups.

## Questions that change the result

First inspect declared inputs for answers. Clarify only decisions that materially change actors, permissions, calculations, state transitions, compatibility or acceptance. Record each unresolved decision with the affected stable IDs, competing interpretations, evidence, consequence and the team role that could decide if known. Avoid a generic questionnaire before useful work.

Continue evidence gathering and unaffected specifications while a choice is unresolved. Do not silently select an interpretation for a normative AC. If drafting a concrete option helps review, label it proposed and keep the unresolved decision visible in gaps or source.production.conflicts as appropriate. An unanswered question does not become approval through elapsed time or a passing rule check.

## Current behavior and intended behavior

Keep these claims distinguishable in content_markdown and linked evidence:

- **Current observation:** what the captured implementation or an actual run demonstrates, including defects and incomplete paths. Reading code alone is not runtime verification.
- **Documented expectation:** what an identified source states; record its status and authority when available. A team note may be a proposal rather than an accepted rule.
- **Proposed change:** an option requiring a decision, with its reason and affected behavior.
- **Confirmed decision:** the decision evidence and responsible authority, if supplied; implementation and test status remain separate facts.

Use the existing assessment enum; these prose labels are not new protocol values. Keep each candidate's assessment consistent with its claims, and separate proposed requirements when necessary to avoid presenting them as code observations. Do not convert a bug into a desired business rule merely because it is implemented. Conversely, do not describe an intended fix as already implemented.

Reconcile sources by subject, applicability and explicit authority, not just date. A supported decision may resolve which rule is intended while the implementation gap remains open. If evidence is insufficient, retain both statements and the uncertainty; do not invent the missing authority or a new policy.
