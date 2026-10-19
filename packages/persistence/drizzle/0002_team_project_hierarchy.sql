CREATE TABLE "teams" (
  "team_id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
  "team_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "role" text NOT NULL,
  "display_name" text NOT NULL,
  "created_at" text NOT NULL,
  PRIMARY KEY ("team_id", "principal_id")
);
--> statement-breakpoint
INSERT INTO "teams" ("team_id", "name", "created_at")
VALUES ('TEAM-LEGACY', 'Legacy workspace', CURRENT_TIMESTAMP::text)
ON CONFLICT ("team_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "team_members" ("team_id", "principal_id", "role", "display_name", "created_at")
SELECT
  'TEAM-LEGACY',
  m."principal_id",
  CASE WHEN bool_or(m."role" = 'owner') THEN 'owner' ELSE 'member' END,
  max(m."display_name"),
  min(m."created_at")
FROM "members" m
GROUP BY m."principal_id"
ON CONFLICT ("team_id", "principal_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "team_id" text DEFAULT 'TEAM-LEGACY' NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "title" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "summary" text;
--> statement-breakpoint
UPDATE "artifacts" a
SET "project_id" = f."project_id"
FROM "tasks" t
INNER JOIN "features" f ON f."feature_id" = t."feature_id"
WHERE a."task_id" = t."task_id";
--> statement-breakpoint
UPDATE "artifacts" SET "project_id" = 'PROJECT-A' WHERE "project_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "project_id" SET DEFAULT 'PROJECT-A';
--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_projects_team" ON "projects" ("team_id");
--> statement-breakpoint
CREATE INDEX "idx_team_members_principal" ON "team_members" ("principal_id");
--> statement-breakpoint
CREATE INDEX "idx_artifacts_project" ON "artifacts" ("project_id");
