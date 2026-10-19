ALTER TABLE "project_document_folders" DROP CONSTRAINT "ck_project_document_folders_system_role";
--> statement-breakpoint
ALTER TABLE "project_document_folders" DROP CONSTRAINT "ck_project_document_folders_system_shape";
--> statement-breakpoint
ALTER TABLE "project_document_folders" ADD CONSTRAINT "ck_project_document_folders_system_role"
  CHECK (system_role IS NULL OR system_role IN ('standards', 'requirements'));
--> statement-breakpoint
ALTER TABLE "project_document_folders" ADD CONSTRAINT "ck_project_document_folders_system_shape"
  CHECK (system_role IS NULL OR (parent_id IS NULL AND status = 'active' AND (
    (system_role = 'standards' AND name = '项目规范') OR
    (system_role = 'requirements' AND name = '需求文档')
  )));
--> statement-breakpoint
-- Keep ordinary same-name folders, descendants and contents intact. They are
-- not requirement documents and must not be adopted as the system directory.
UPDATE project_document_folders SET name = '需求文档（原目录 ' || code || '）'
  WHERE parent_id IS NULL AND name = '需求文档' AND system_role IS NULL;
--> statement-breakpoint
INSERT INTO project_document_folders (project_id, name, system_role, sort_order, status, created_by, created_at, updated_at)
  SELECT id, '需求文档', 'requirements', -1, 'active', NULL, created_at, created_at FROM projects;
--> statement-breakpoint
-- requirement_documents and requirement_document_revisions remain the only
-- source of requirement bodies and history. The library projects them into
-- this project's fixed folder; no content or revision records are duplicated.
COMMENT ON COLUMN project_document_folders.system_role IS
  'Fixed project roots: standards contains project documents; requirements projects existing requirement documents by project_id.';
