-- Apply the new optional-binding contract after the additive revision/inbox schema.
-- Existing business records and their binding values remain unchanged.
ALTER TABLE memory_capture_receipts ALTER COLUMN topic_id DROP NOT NULL,
  ALTER COLUMN requirement_id DROP NOT NULL, ALTER COLUMN base_revision DROP NOT NULL,
  ALTER COLUMN revision_after DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE memory_fragments DROP CONSTRAINT IF EXISTS memory_fragments_check;
