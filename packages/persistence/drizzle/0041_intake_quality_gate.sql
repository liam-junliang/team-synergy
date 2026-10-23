-- Keep historical profile and quality unknown: the old rows do not record this basis.
ALTER TABLE intake_batches ADD COLUMN profile text;
ALTER TABLE intake_batches ADD COLUMN quality_rule_version text;
ALTER TABLE intake_batches ADD COLUMN quality_report_json text;
ALTER TABLE intake_batches ADD COLUMN frozen_quality_json text;
ALTER TABLE intake_batches ADD CONSTRAINT ck_intake_batches_profile CHECK (profile IS NULL OR profile IN ('pilot', 'enterprise'));
