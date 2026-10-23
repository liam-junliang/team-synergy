-- Scope the material consistency fence to the project aggregate. Revision and
-- relationship rows resolve their owning project, including both sides of moves.
CREATE FUNCTION acp_context_material_projects(material_table text, material jsonb)
RETURNS bigint[] LANGUAGE plpgsql STABLE AS $$
DECLARE result bigint[];
BEGIN
  IF material IS NULL THEN RETURN ARRAY[]::bigint[]; END IF;
  CASE material_table
    WHEN 'projects' THEN result := ARRAY[(material->>'id')::bigint];
    WHEN 'requirements' THEN
      SELECT array_agg(DISTINCT project_id) INTO result FROM (
        SELECT project_id FROM features WHERE id = (material->>'feature_id')::bigint
        UNION SELECT project_id FROM project_modules WHERE id = (material->>'module_id')::bigint
        UNION SELECT project_id FROM requirement_documents WHERE id = (material->>'document_id')::bigint
      ) scopes;
    WHEN 'requirement_revisions' THEN
      SELECT acp_context_material_projects('requirements', to_jsonb(r)) INTO result
        FROM requirements r WHERE id = (material->>'requirement_id')::bigint;
    WHEN 'requirement_document_revisions' THEN
      SELECT ARRAY[project_id] INTO result FROM requirement_documents WHERE id = (material->>'document_id')::bigint;
    WHEN 'project_document_revisions' THEN
      SELECT ARRAY[project_id] INTO result FROM project_documents WHERE id = (material->>'document_id')::bigint;
    WHEN 'design_prototype_revisions' THEN
      SELECT ARRAY[project_id] INTO result FROM design_prototypes WHERE id = (material->>'prototype_id')::bigint;
    WHEN 'requirement_topic_entries' THEN
      SELECT ARRAY[project_id] INTO result FROM requirement_topics WHERE id = (material->>'topic_id')::bigint;
    ELSE result := ARRAY[(material->>'project_id')::bigint];
  END CASE;
  RETURN coalesce(result, ARRAY[]::bigint[]);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION acp_lock_context_materials()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_scope bigint;
BEGIN
  -- Cross-project moves lock both old and new owners in deterministic order.
  -- Bulk cross-project writers should acquire all project fences in this order
  -- before writing, so separate rows cannot invert transaction lock order.
  FOR project_scope IN
    SELECT DISTINCT scope FROM unnest(
      acp_context_material_projects(TG_TABLE_NAME, CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END)
      || acp_context_material_projects(TG_TABLE_NAME, CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END)
    ) scope WHERE scope IS NOT NULL ORDER BY scope
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('project:' || project_scope::text)::bigint);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE material_table text;
BEGIN
  FOREACH material_table IN ARRAY ARRAY[
    'projects', 'requirements', 'requirement_revisions', 'requirement_documents',
    'requirement_document_revisions', 'project_documents', 'project_document_revisions',
    'design_prototypes', 'design_prototype_revisions', 'requirement_topics',
    'requirement_topic_entries', 'project_repositories', 'project_document_folders'
  ] LOOP
    EXECUTE format('DROP TRIGGER acp_context_material_fence ON %I', material_table);
    EXECUTE format('CREATE TRIGGER acp_context_material_fence BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION acp_lock_context_materials()', material_table);
  END LOOP;
END;
$$;
