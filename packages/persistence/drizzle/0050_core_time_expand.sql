-- Expand only. Keep the current text readers/writers throughout the verification window.
CREATE OR REPLACE FUNCTION tsp_parse_iso8601(value text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF value !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])(T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9]))?$'
    OR left(value, 4) = '0000' THEN
    RAISE EXCEPTION 'Core timestamp must be a finite ISO 8601 date or timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN (CASE WHEN length(value) = 10 THEN value || 'T00:00:00Z' ELSE value END)::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
  RAISE EXCEPTION 'Core timestamp must be a valid ISO 8601 calendar instant' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at_ts timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_at_ts timestamptz;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS timestamp_ts timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tsp_mirror_created_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at_ts := tsp_parse_iso8601(NEW.created_at);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tsp_mirror_audit_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.timestamp_ts := tsp_parse_iso8601(NEW.timestamp);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mirror_project_created_time BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION tsp_mirror_created_time();
CREATE TRIGGER mirror_task_created_time BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION tsp_mirror_created_time();
CREATE TRIGGER mirror_audit_timestamp BEFORE INSERT OR UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION tsp_mirror_audit_time();
--> statement-breakpoint
UPDATE projects SET created_at_ts = tsp_parse_iso8601(created_at);
UPDATE tasks SET created_at_ts = tsp_parse_iso8601(created_at);
UPDATE audit_events SET timestamp_ts = tsp_parse_iso8601(timestamp);
--> statement-breakpoint
ALTER TABLE projects ADD CONSTRAINT ck_projects_created_at_iso8601 CHECK (created_at_ts IS NOT NULL AND created_at_ts = tsp_parse_iso8601(created_at));
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_created_at_iso8601 CHECK (created_at_ts IS NOT NULL AND created_at_ts = tsp_parse_iso8601(created_at));
ALTER TABLE audit_events ADD CONSTRAINT ck_audit_events_timestamp_iso8601 CHECK (timestamp_ts IS NOT NULL AND timestamp_ts = tsp_parse_iso8601(timestamp));
--> statement-breakpoint
CREATE INDEX idx_projects_created_time ON projects(created_at_ts);
CREATE INDEX idx_tasks_created_time_id ON tasks(created_at_ts DESC, id DESC);
CREATE INDEX idx_tasks_feature_created_time_id ON tasks(feature_id, created_at_ts DESC, id DESC);
CREATE INDEX idx_audit_timestamp_time_id ON audit_events(timestamp_ts, id);
