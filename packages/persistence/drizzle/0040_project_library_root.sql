ALTER TABLE project_document_folders DROP CONSTRAINT ck_project_document_folders_system_role;
--> statement-breakpoint
ALTER TABLE project_document_folders DROP CONSTRAINT ck_project_document_folders_system_shape;
--> statement-breakpoint
ALTER TABLE project_document_folders ADD CONSTRAINT ck_project_document_folders_system_role
  CHECK (system_role IS NULL OR system_role IN ('root', 'overview', 'standards', 'requirements', 'architecture', 'testing'));
--> statement-breakpoint
-- Preserve ordinary same-name roots before creating the fixed project library root.
UPDATE project_document_folders SET name = '项目资料（原目录 ' || code || '）'
  WHERE parent_id IS NULL AND name = '项目资料' AND system_role IS NULL;
--> statement-breakpoint
UPDATE project_document_folders SET name = '项目说明（原目录 ' || code || '）'
  WHERE parent_id IS NULL AND name = '项目说明' AND system_role IS NULL;
--> statement-breakpoint
INSERT INTO project_document_folders (project_id, name, system_role, sort_order, status, created_by, created_at, updated_at)
  SELECT id, '项目资料', 'root', -10, 'active', NULL, created_at, created_at FROM projects
  ON CONFLICT (project_id, system_role) DO NOTHING;
--> statement-breakpoint
INSERT INTO project_document_folders (project_id, parent_id, name, system_role, sort_order, status, created_by, created_at, updated_at)
  SELECT p.id, r.id, '项目说明', 'overview', -9, 'active', NULL, p.created_at, p.created_at
  FROM projects p
  JOIN project_document_folders r ON r.project_id = p.id AND r.system_role = 'root'
  ON CONFLICT (project_id, system_role) DO NOTHING;
--> statement-breakpoint
UPDATE project_document_folders f
  SET parent_id = r.id,
      sort_order = CASE f.system_role
        WHEN 'standards' THEN -8
        WHEN 'requirements' THEN -7
        WHEN 'architecture' THEN -6
        WHEN 'testing' THEN -5
        ELSE f.sort_order
      END
  FROM project_document_folders r
  WHERE r.project_id = f.project_id
    AND r.system_role = 'root'
    AND f.system_role IN ('standards', 'requirements', 'architecture', 'testing')
    AND (f.parent_id IS DISTINCT FROM r.id OR f.sort_order <> CASE f.system_role
      WHEN 'standards' THEN -8
      WHEN 'requirements' THEN -7
      WHEN 'architecture' THEN -6
      WHEN 'testing' THEN -5
      ELSE f.sort_order
    END);
--> statement-breakpoint
-- Project home bindings move into the overview folder so the server-side folder rule holds for existing projects.
UPDATE project_documents d
  SET folder_id = o.id
  FROM projects p
  JOIN project_document_folders o ON o.project_id = p.id AND o.system_role = 'overview'
  WHERE d.project_id = p.id
    AND d.status = 'active'
    AND d.id IN (p.overview_document_id, p.guide_document_id)
    AND d.folder_id IS DISTINCT FROM o.id;
--> statement-breakpoint
ALTER TABLE project_document_folders ADD CONSTRAINT ck_project_document_folders_system_shape
  CHECK (system_role IS NULL OR (status = 'active' AND (
    (system_role = 'root' AND parent_id IS NULL AND name = '项目资料') OR
    (system_role IN ('overview', 'standards', 'requirements', 'architecture', 'testing') AND parent_id IS NOT NULL AND (
      (system_role = 'overview' AND name = '项目说明') OR
      (system_role = 'standards' AND name = '项目规范') OR
      (system_role = 'requirements' AND name = '需求文档') OR
      (system_role = 'architecture' AND name = '架构设计') OR
      (system_role = 'testing' AND name = '测试资料')
    ))
  )));
--> statement-breakpoint
COMMENT ON COLUMN project_document_folders.system_role IS
  'Fixed project library: root contains overview, standards, requirements, architecture and testing child folders.';
