ALTER TABLE memory_projection_jobs ALTER COLUMN fragment_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE memory_projection_jobs ADD COLUMN project_document_revision_id bigint REFERENCES project_document_revisions(id);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_memory_projection_jobs_document_revision ON memory_projection_jobs(project_document_revision_id);
--> statement-breakpoint
ALTER TABLE memory_projection_jobs ADD CONSTRAINT ck_memory_projection_jobs_source
  CHECK ((fragment_id IS NOT NULL) <> (project_document_revision_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE memory_projection_jobs ADD CONSTRAINT ck_memory_projection_jobs_document_engine
  CHECK (project_document_revision_id IS NULL OR engine = 'tencent');
--> statement-breakpoint
INSERT INTO memory_projection_jobs(project_document_revision_id,engine)
SELECT r.id,'tencent' FROM project_document_revisions r
JOIN project_documents d ON d.id=r.document_id AND d.revision=r.revision
JOIN projects p ON p.id=d.project_id
WHERE d.status='active' AND p.status='active'
ON CONFLICT (project_document_revision_id) DO NOTHING;
