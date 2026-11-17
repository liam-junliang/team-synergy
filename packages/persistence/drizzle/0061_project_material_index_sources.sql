-- Contract follows 0060 expansion; never rewrite deployed historical migrations.
ALTER TABLE memory_projection_jobs DROP CONSTRAINT ck_memory_projection_jobs_source;
--> statement-breakpoint
ALTER TABLE memory_projection_jobs ADD CONSTRAINT ck_memory_projection_jobs_source CHECK(num_nonnulls(fragment_id,project_document_revision_id,material_index_id)=1);
--> statement-breakpoint
ALTER TABLE project_memory_bindings ALTER COLUMN updated_by DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE project_memory_bindings ADD CONSTRAINT ck_project_memory_bindings_actor CHECK((updated_source='system' AND updated_by IS NULL) OR (updated_source='member' AND updated_by IS NOT NULL));
