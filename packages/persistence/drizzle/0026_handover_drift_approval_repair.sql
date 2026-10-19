-- Early development databases applied 0024 before drift_approval was added.
-- An already recorded migration is not replayed; repair it in a new migration.
ALTER TABLE "task_handovers" ADD COLUMN IF NOT EXISTS "drift_approval" text;
