CREATE TABLE IF NOT EXISTS "requirement_documents" (
  "document_id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "module_key" text NOT NULL,
  "title" text NOT NULL,
  "current_revision" integer DEFAULT 1 NOT NULL,
  "state" text DEFAULT 'draft' NOT NULL,
  "owner_principal_id" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_documents_project" ON "requirement_documents" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_documents_module" ON "requirement_documents" USING btree ("project_id", "module_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_documents_state" ON "requirement_documents" USING btree ("project_id", "state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirement_document_revisions" (
  "document_id" text NOT NULL,
  "revision" integer NOT NULL,
  "summary" text NOT NULL,
  "content" text NOT NULL,
  "keywords" text DEFAULT '[]' NOT NULL,
  "change_summary" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" text NOT NULL,
  CONSTRAINT "requirement_document_revisions_document_id_revision_pk" PRIMARY KEY("document_id", "revision")
);
--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "document_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirements_document" ON "requirements" USING btree ("document_id");
