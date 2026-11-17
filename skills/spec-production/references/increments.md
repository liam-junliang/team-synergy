# Incremental specifications and impact

Use this reference when sources change, a team revises a rule, or an existing specification needs a bounded addition or repair. Preserve the prior pack as a historical snapshot; generate the next pack from fresh inputs. Do not replace old evidence hashes in place to make stale content validate.

1. Preserve namespace, candidate keys and AC IDs for the same business identities. Reuse context.bindings. A rename or moved source is not automatically a new requirement. Read [inventory.md](inventory.md) when material keys change and the prior namespace must be supplied explicitly.
2. Run `tsp intake diff <previous> <current>` after preparing and populating the current pack. Distinguish changed source bytes from changed behavior: formatting may not change a rule, and a small permission change may affect many scenarios.
3. Write a short semantic change record beside intake.json or in the relevant document. Classify actual additions, modifications and removals as ADDED, MODIFIED or REMOVED, with stable IDs, before/after behavior, source evidence, decision status, compatibility impact and verification needed. These are report labels, not new intake fields or executable actions.
4. Use affected_keys as a starting point. Search the captured scope for shared permission checks, state/data consumers, interfaces, jobs, UI paths and tests; inspect relevant dossier statements too. Record additional affected IDs and what was not examined. A missing declared link does not prove independence. If necessary evidence is outside the capture, prepare a wider pack or record that impact as unchecked.
5. Reconcile impacted requirements, ACs, plans, API/data descriptions, operations guidance and overview documents. Explain why apparently unchanged dependants remain valid. Keep untouched identities stable; do not rewrite unrelated prose merely to produce a larger delta.

## Removal and uncertainty

A deleted file, missing capture, narrowed scope or removed input does not prove that a product capability was retired. Confirm the semantic removal from evidence; otherwise describe a missing source or uncertain coverage. Do not delete platform entities or clear old bindings as a side effect of a semantic REMOVED record. The platform's reviewed create/bind/skip plan remains the publication boundary; removal/migration decisions outside that protocol need the appropriate separate workflow.

## Completion record

Record which deltas were reconciled, which remain proposed or unresolved, and which tests are planned versus actually executed. Do not call a change implemented because its proposed documents are complete. Export the revised draft and retain the prior output, diff, review and decision evidence for comparison. Archive a change as history only after the applicable review is complete; an archived record is not proof of approval or successful deployment.
