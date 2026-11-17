CREATE INDEX IF NOT EXISTS idx_tasks_created_id ON tasks (created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_feature_created_id ON tasks (feature_id, created_at DESC, id DESC);
