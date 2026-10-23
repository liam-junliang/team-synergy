# Existing specification baseline

Capability CAP-EXPORT, module MOD-REPORTS, feature FEAT-EXPORT.
REQ-EXPORT-CREATE: administrators can request an export. AC-CREATE-01: an administrator gets a queued job.
REQ-EXPORT-LIMIT: at most 10,000 rows. AC-LIMIT-01: reject more than 10,000 rows without creating a job.
REQ-EXPORT-RETRY: a repeated request identifier returns the existing job. AC-RETRY-01: one job after a retry.
REQ-EXPORT-SYNC: the legacy synchronous download entry returns CSV immediately.
REQ-BILLING-INVOICE: billing invoice creation is a separate capability and is outside this request.

The baseline is an existing document, not proof that its rules are still approved or that all behavior is implemented.
