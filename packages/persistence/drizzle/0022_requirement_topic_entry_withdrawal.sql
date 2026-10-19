ALTER TABLE "requirement_topic_entries" ADD COLUMN "withdrawn_at" text;
--> statement-breakpoint
ALTER TABLE "requirement_topic_entries" ADD COLUMN "withdrawn_by" bigint;
--> statement-breakpoint
ALTER TABLE "requirement_topic_entries" ADD COLUMN "withdrawal_reason" text;
--> statement-breakpoint
ALTER TABLE "requirement_topic_entries" ADD CONSTRAINT "ck_requirement_topic_entries_withdrawn" CHECK (("withdrawn_at" IS NULL AND "withdrawn_by" IS NULL) OR ("withdrawn_at" IS NOT NULL AND "withdrawn_by" IS NOT NULL));
