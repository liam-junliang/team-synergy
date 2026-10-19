ALTER TABLE "requirement_documents" ALTER COLUMN "state" SET DEFAULT 'active';
--> statement-breakpoint
UPDATE "requirement_documents"
SET "state" = 'active'
WHERE "state" IN ('draft', 'in_review', 'change_proposed');
