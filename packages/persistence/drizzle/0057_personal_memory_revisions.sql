ALTER TABLE memory_capture_receipts ADD CONSTRAINT ck_memory_receipts_binding CHECK (
  (topic_id IS NULL AND requirement_id IS NULL AND base_revision IS NULL AND revision_after IS NULL AND head_after IS NULL)
  OR (topic_id IS NOT NULL AND requirement_id IS NOT NULL AND base_revision IS NOT NULL AND revision_after IS NOT NULL));
--> statement-breakpoint
ALTER TABLE memory_fragments ADD COLUMN root_id bigint REFERENCES memory_fragments(id),
  ADD COLUMN supersedes_id bigint REFERENCES memory_fragments(id),
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by bigint REFERENCES users(id),
  ADD COLUMN change_reason text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT ck_memory_fragments_entry CHECK (state <> 'confirmed' OR entry_id IS NOT NULL),
  ADD CONSTRAINT ck_memory_fragments_preference_entry CHECK (state <> 'preference' OR entry_id IS NULL),
  ADD CONSTRAINT ck_memory_fragments_revision CHECK (
    (root_id IS NULL AND supersedes_id IS NULL AND revision = 1)
    OR (state = 'preference' AND root_id IS NOT NULL AND supersedes_id IS NOT NULL AND revision > 1)),
  ADD CONSTRAINT ck_memory_fragments_withdrawal CHECK (
    (withdrawn_at IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_at IS NULL OR state = 'preference'));
--> statement-breakpoint
UPDATE memory_fragments f SET created_at = r.created_at FROM memory_capture_receipts r WHERE f.receipt_id = r.id;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_memory_fragments_revision ON memory_fragments(coalesce(root_id,id),revision);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_memory_fragments_supersedes ON memory_fragments(supersedes_id);
--> statement-breakpoint
CREATE INDEX idx_memory_fragments_root ON memory_fragments(root_id);
--> statement-breakpoint
ALTER TABLE memory_projection_jobs ADD COLUMN operation text NOT NULL DEFAULT 'upsert',
  ADD COLUMN generation integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT ck_memory_projection_jobs_operation CHECK (operation IN ('upsert','delete')),
  ADD CONSTRAINT ck_memory_projection_jobs_generation CHECK (generation > 0);
