# Export policy EP-7

Decision record: Product owner approved EP-7 for the next release in this fixture.
Scope: exports within a workspace; billing and account provisioning are outside this change.
An administrator or analyst may create an export only for their own workspace.
An auditor may inspect export audit records but must not create an export.
Each export may include at most 5,000 rows. Exactly 5,000 is allowed.
Retrying a request within the same workspace must not create a second job.
The same request identifier in different workspaces must not return another workspace's job.
If queue publication fails after persistence, the job must remain recoverable without losing or duplicating the export.
The concrete recovery mechanism is to be designed; this policy does not approve an outbox or a particular queue.
This decision supersedes the administrator-only creation rule in baseline.md.
The legacy synchronous download entry is to be removed; no stored audit history is to be deleted.
Latency, availability and audit retention targets have not been agreed.
