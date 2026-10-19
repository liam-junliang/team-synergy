CREATE TABLE IF NOT EXISTS "project_documents" (
  "project_id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" text NOT NULL
);
