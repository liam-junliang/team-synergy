ALTER TABLE project_document_folders DROP CONSTRAINT ck_project_document_folders_system_role;
--> statement-breakpoint
ALTER TABLE project_document_folders DROP CONSTRAINT ck_project_document_folders_system_shape;
--> statement-breakpoint
ALTER TABLE project_document_folders ADD CONSTRAINT ck_project_document_folders_system_role
  CHECK (system_role IS NULL OR system_role IN ('standards', 'requirements', 'architecture'));
--> statement-breakpoint
ALTER TABLE project_document_folders ADD CONSTRAINT ck_project_document_folders_system_shape
  CHECK (system_role IS NULL OR (parent_id IS NULL AND status = 'active' AND (
    (system_role = 'standards' AND name = '项目规范') OR
    (system_role = 'requirements' AND name = '需求文档') OR
    (system_role = 'architecture' AND name = '架构设计')
  )));
--> statement-breakpoint
-- Preserve ordinary same-name folders and every descendant, document and revision.
UPDATE project_document_folders SET name = '架构设计（原目录 ' || code || '）'
  WHERE parent_id IS NULL AND name = '架构设计' AND system_role IS NULL;
--> statement-breakpoint
INSERT INTO project_document_folders (project_id, name, system_role, sort_order, status, created_by, created_at, updated_at)
  SELECT id, '架构设计', 'architecture', -1, 'active', NULL, created_at, created_at FROM projects
  ON CONFLICT (project_id, system_role) DO NOTHING;
--> statement-breakpoint
ALTER TABLE project_documents DROP CONSTRAINT ck_project_documents_kind;
--> statement-breakpoint
ALTER TABLE project_documents ADD CONSTRAINT ck_project_documents_kind
  CHECK (kind IN ('doc', 'api', 'diagram', 'general', 'integration', 'deployment', 'data', 'operations', 'release'));
--> statement-breakpoint
ALTER TABLE project_documents ALTER COLUMN kind SET DEFAULT 'doc';
--> statement-breakpoint
-- Legacy kind values and all source/history rows remain untouched. Architecture
-- documents are projected by project_id rather than copied into project_documents.
COMMENT ON COLUMN project_document_folders.system_role IS
  'Fixed roots: standards contains project documents; requirements and architecture project their original source records and immutable revisions.';
