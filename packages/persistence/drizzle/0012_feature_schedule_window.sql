ALTER TABLE "features" ADD COLUMN IF NOT EXISTS "start_date" text;
--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN IF NOT EXISTS "end_date" text;
