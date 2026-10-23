# Inventory and source reconciliation

Read manifest files in bounded capability groups. Discover user-facing entry points, services, commands, jobs, permission functions, states, persistence and tests; combine these signals instead of treating folders as product modules. For documents/team notes, record their stated purpose, version and author/confirmation status when available. A team statement can describe intended behavior that code does not yet implement. Use [scope.md](scope.md) when intent or source authority is uncertain.

source.production has version "1.0", scope_statement, discovery_status (partial or reviewed), capabilities and conflicts. Each capability has key, title, disposition (included, excluded or unknown), reason, requirement_keys and evidence. Evidence uses the same captured {path,sha256,line_start,line_end,symbol?} shape as items. Give excluded/unknown capabilities a reason; a discovered capability without enough evidence remains unknown. Do not silently omit it to inflate coverage.

For every included capability, module_key and feature_key are required by this production workflow. Include the referenced module and feature candidates; feature.module_key must equal capability.module_key. Each requirement_keys entry must refer to a requirement candidate with that same module_key and feature_key. A requirement alone, or an overview document with acceptance text, does not complete the chain. The schema permits omitted parent fields for historical packages and unfinished drafts; that compatibility does not make an included capability complete. Unknown/excluded capabilities can omit links that have not been established. Broad product areas need multiple independently testable requirements.

Relationship-only illustration (retain all other required candidate and capability fields):

    items: [
      { key: "module-documents", kind: "module" },
      { key: "feature-save", kind: "feature", module_key: "module-documents" },
      { key: "requirement-save", kind: "requirement", module_key: "module-documents", feature_key: "feature-save" }
    ]
    capability: {
      key: "capability-save", disposition: "included", module_key: "module-documents",
      feature_key: "feature-save", requirement_keys: ["requirement-save"]
    }

A conflict has key, summary, status (open or resolved), resolution and evidence from the contradictory sources. Keep both the implemented observation and documented expectation visible. Evidence must actually contain each contradictory claim, not merely nearby headings or the whole document by default. When resolving, name the rationale/decision authority in resolution and anchor the supporting material. Never select the newest-looking source automatically. Resolving intended policy does not prove that code implements it; retain that gap and its verification needs.

Use stable item keys from context.bindings for the same namespace; assign durable keys for new business capabilities. Reuse keys across renames or moved files. Namespace is preserved for repository captures and for the same material keys/kinds; changing a material path with the same identity does not create a new source namespace. When adding/removing material keys on an existing material-only analysis, pass --namespace <old-namespace> to prepare so comparisons and bindings retain their identity.

Checkpoint: every declared capability has evidence and a disposition; every included capability has a valid module → feature → requirement chain plus the linked requirement specifications, ACs and plans; exclusions/unknowns and conflicts are visible. A narrow declared scope stays narrow even if all catalog documents exist.

Report counts with their denominators: discovered capabilities, included capabilities with complete specifications, and excluded/unknown capabilities. Do not turn a fully populated template catalog or a reviewed sample into a product coverage percentage. Inventory review also checks for plausible omissions against the entry points and scenarios actually examined; a valid list cannot prove that its own discovery was exhaustive.
