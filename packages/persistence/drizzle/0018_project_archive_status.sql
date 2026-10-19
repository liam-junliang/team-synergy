ALTER TABLE "projects" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;
ALTER TABLE "projects" ADD CONSTRAINT "ck_projects_status" CHECK ("status" IN ('active', 'archived'));
