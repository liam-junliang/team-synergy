ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_scope_type_check,
  DROP CONSTRAINT IF EXISTS ck_skills_scope,
  ALTER COLUMN scope_id DROP NOT NULL,
  ALTER COLUMN owner_principal_id DROP NOT NULL,
  ADD CONSTRAINT ck_skills_scope CHECK (
    (scope_type = 'platform' AND scope_id IS NULL AND owner_principal_id IS NULL)
    OR (scope_type IN ('team','project') AND scope_id IS NOT NULL AND owner_principal_id IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE skill_revisions ADD COLUMN release_version text;
--> statement-breakpoint
ALTER TABLE skill_revisions ALTER COLUMN created_by DROP NOT NULL,
  ADD CONSTRAINT ck_skill_revision_origin CHECK (
    (release_version IS NULL AND created_by IS NOT NULL)
    OR (release_version IS NOT NULL AND created_by IS NULL AND published_at IS NOT NULL)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX uq_skill_revisions_release ON skill_revisions(skill_id, release_version);
