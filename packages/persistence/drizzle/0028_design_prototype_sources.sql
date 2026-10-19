ALTER TABLE "design_prototype_revisions" ADD COLUMN "content_kind" text NOT NULL DEFAULT 'html';
--> statement-breakpoint
ALTER TABLE "design_prototype_revisions" ADD COLUMN "external_url" text;
--> statement-breakpoint
ALTER TABLE "design_prototype_revisions" ADD COLUMN "file_name" text;
--> statement-breakpoint
ALTER TABLE "design_prototype_revisions" ADD COLUMN "file_mime_type" text;
--> statement-breakpoint
ALTER TABLE "design_prototype_revisions" ADD COLUMN "file_size" integer;
--> statement-breakpoint
ALTER TABLE "design_prototype_revisions" ADD COLUMN "file_sha256" text;
--> statement-breakpoint
ALTER TABLE "design_prototype_revisions" ADD COLUMN "file_content_base64" text;
--> statement-breakpoint
UPDATE "design_prototype_revisions" SET "content_kind" = 'image'
WHERE "html_content" ~* '<meta[^>]+name=["'']acp-prototype-kind["''][^>]+content=["'']image["'']';
