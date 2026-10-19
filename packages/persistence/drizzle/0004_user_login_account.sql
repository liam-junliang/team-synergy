ALTER TABLE "users" ADD COLUMN "account" text;
--> statement-breakpoint
UPDATE "users" SET "account" = lower("user_id") WHERE "account" IS NULL;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "account" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_account" ON "users" ("account");
