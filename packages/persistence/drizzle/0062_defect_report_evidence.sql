ALTER TABLE defects
  ADD COLUMN action_steps text,
  ADD COLUMN expected_result text,
  ADD COLUMN actual_result text,
  ADD COLUMN evidence_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE defect_evidence_files (
  defect_id bigint NOT NULL REFERENCES defects(id) ON DELETE CASCADE,
  evidence_index integer NOT NULL,
  content_base64 text NOT NULL,
  PRIMARY KEY (defect_id, evidence_index)
);
