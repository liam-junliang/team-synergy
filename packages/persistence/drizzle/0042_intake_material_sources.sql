-- A material-only source is project-scoped and has no invented repository identity.
ALTER TABLE intake_batches ALTER COLUMN repository_id DROP NOT NULL;
ALTER TABLE intake_bindings ALTER COLUMN repository_id DROP NOT NULL;
-- PostgreSQL treats NULLs as distinct in the existing repository-scoped index.
-- Preserve that index for historical sources and enforce material identity separately.
CREATE UNIQUE INDEX uq_intake_bindings_material_source
  ON intake_bindings(project_id, namespace, kind, source_key)
  WHERE repository_id IS NULL;
