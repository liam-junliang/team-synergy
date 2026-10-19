ALTER TABLE "project_document_folders" ADD COLUMN "system_role" text;
--> statement-breakpoint
ALTER TABLE "project_document_folders" ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_document_folders" ADD CONSTRAINT "ck_project_document_folders_system_role"
  CHECK (system_role IS NULL OR system_role = 'standards');
--> statement-breakpoint
ALTER TABLE "project_document_folders" ADD CONSTRAINT "ck_project_document_folders_system_shape"
  CHECK (system_role IS NULL OR (parent_id IS NULL AND name = '项目规范' AND status = 'active'));
--> statement-breakpoint
ALTER TABLE "project_document_folders" ADD CONSTRAINT "ck_project_document_folders_creator"
  CHECK (created_by IS NOT NULL OR system_role IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_document_folders_system_role"
  ON "project_document_folders" (project_id, system_role);
--> statement-breakpoint
-- Existing ordinary folders keep their identity, hierarchy and documents. The
-- explicit legacy suffix avoids presenting unrelated contents as mandatory rules.
UPDATE project_document_folders SET name = '项目规范（原目录 ' || code || '）'
  WHERE parent_id IS NULL AND name = '项目规范' AND system_role IS NULL;
--> statement-breakpoint
INSERT INTO project_document_folders (project_id, name, system_role, sort_order, status, created_by, created_at, updated_at)
  SELECT id, '项目规范', 'standards', -1, 'active', NULL, created_at, created_at FROM projects;
--> statement-breakpoint
-- Move only the explicitly bound legacy document, including archived documents.
-- Contents, revision counters and immutable revision records are untouched.
UPDATE project_documents AS document SET folder_id = folder.id
  FROM projects AS project, project_document_folders AS folder
  WHERE document.id = project.standards_document_id AND document.project_id = project.id
    AND folder.project_id = project.id AND folder.system_role = 'standards';
--> statement-breakpoint
UPDATE projects SET standards_document_id = NULL WHERE standards_document_id IS NOT NULL;
--> statement-breakpoint
-- Folder membership is now a context material: moves and archival must serialize
-- with context compilation/activation just like document revisions do.
CREATE TRIGGER acp_context_material_fence BEFORE INSERT OR UPDATE OR DELETE ON project_document_folders
  FOR EACH STATEMENT EXECUTE FUNCTION acp_lock_context_materials();
