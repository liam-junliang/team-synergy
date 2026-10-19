ALTER TABLE "projects" ADD COLUMN "overview_document_id" bigint;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "guide_document_id" bigint;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "standards_document_id" bigint;
--> statement-breakpoint
-- The old endpoint selected an arbitrary project document after the library
-- became multi-document. Only migrate an unambiguous explicit audit reference;
-- never infer the overview from a document's title, kind, or insertion order.
DO $$
DECLARE
  project_row record;
  event_row record;
  event_payload jsonb;
  matched_document_id bigint;
  overview_id bigint;
  ambiguous boolean;
BEGIN
  FOR project_row IN SELECT id FROM projects LOOP
    overview_id := NULL;
    ambiguous := false;
    FOR event_row IN SELECT payload FROM audit_events
      WHERE entity_type = 'project' AND entity_id = project_row.id
        AND action IN ('project.document_created', 'project.document_updated') LOOP
      BEGIN
        event_payload := event_row.payload::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN
        CONTINUE;
      END;
      SELECT id INTO matched_document_id FROM project_documents
        WHERE project_id = project_row.id AND code = event_payload->>'document_code';
      IF matched_document_id IS NULL THEN CONTINUE; END IF;
      IF overview_id IS NOT NULL AND overview_id <> matched_document_id THEN
        ambiguous := true;
        EXIT;
      END IF;
      overview_id := matched_document_id;
    END LOOP;
    IF NOT ambiguous AND overview_id IS NOT NULL THEN
      UPDATE projects SET overview_document_id = overview_id WHERE id = project_row.id
        AND EXISTS (SELECT 1 FROM project_documents WHERE id = overview_id AND status = 'active');
    END IF;
  END LOOP;
END;
$$;
