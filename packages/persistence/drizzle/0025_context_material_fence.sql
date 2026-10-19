-- MVP global material fence. Context compilation and activation acquire the shared
-- transaction lock before reading; material writers acquire the exclusive lock
-- before their statement starts, including inserts that would otherwise be phantoms.
-- Narrow this to project-scoped locks only after defining ordering for cross-project
-- writes. The global lock intentionally trades write concurrency for consistency.
CREATE OR REPLACE FUNCTION acp_lock_context_materials()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1094930512::bigint);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  material_table text;
BEGIN
  FOREACH material_table IN ARRAY ARRAY[
    'projects',
    'requirements',
    'requirement_revisions',
    'requirement_documents',
    'requirement_document_revisions',
    'project_documents',
    'project_document_revisions',
    'design_prototypes',
    'design_prototype_revisions',
    'requirement_topics',
    'requirement_topic_entries',
    'project_repositories'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS acp_context_material_fence ON %I', material_table);
    EXECUTE format(
      'CREATE TRIGGER acp_context_material_fence BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION acp_lock_context_materials()',
      material_table
    );
  END LOOP;
END;
$$;
