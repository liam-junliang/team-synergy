-- Release only after the deployed 0050 verification receipt and a fresh backup.
-- No CASCADE: unexpected dependencies must stop the migration safely.
SET LOCAL lock_timeout = '5s';
LOCK TABLE projects, tasks, audit_events IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF (EXISTS (SELECT 1 FROM projects) OR EXISTS (SELECT 1 FROM tasks) OR EXISTS (SELECT 1 FROM audit_events))
    AND NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1792731600000
      AND xmin <> pg_current_xact_id()::text::xid) THEN
    RAISE EXCEPTION 'Deploy and verify the committed 0050 expand release before core time cutover' USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE item record; invalid_count bigint;
BEGIN
  FOR item IN SELECT * FROM (VALUES ('projects','created_at'),('tasks','created_at'),('audit_events','timestamp')) AS times(table_name,column_name)
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NULL OR %I IS DISTINCT FROM tsp_parse_iso8601(%I) OR %I < %L::timestamptz OR %I >= %L::timestamptz',
      item.table_name, item.column_name || '_ts', item.column_name || '_ts', item.column_name,
      item.column_name || '_ts', '0001-01-01T00:00:00Z', item.column_name || '_ts', '10000-01-01T00:00:00Z') INTO invalid_count;
    IF invalid_count <> 0 THEN
      RAISE EXCEPTION 'Core time cutover stopped: % has % invalid mirrors; preserve the source and investigate', item.table_name, invalid_count USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
DROP TRIGGER mirror_project_created_time ON projects;
DROP TRIGGER mirror_task_created_time ON tasks;
DROP TRIGGER mirror_audit_timestamp ON audit_events;
DROP FUNCTION tsp_mirror_created_time();
DROP FUNCTION tsp_mirror_audit_time();
--> statement-breakpoint
ALTER TABLE projects DROP CONSTRAINT ck_projects_created_at_iso8601;
ALTER TABLE tasks DROP CONSTRAINT ck_tasks_created_at_iso8601;
ALTER TABLE audit_events DROP CONSTRAINT ck_audit_events_timestamp_iso8601;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN created_at;
ALTER TABLE projects RENAME COLUMN created_at_ts TO created_at;
ALTER TABLE tasks DROP COLUMN created_at;
ALTER TABLE tasks RENAME COLUMN created_at_ts TO created_at;
ALTER TABLE audit_events DROP COLUMN timestamp;
ALTER TABLE audit_events RENAME COLUMN timestamp_ts TO timestamp;
--> statement-breakpoint
ALTER TABLE projects ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE tasks ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE audit_events ALTER COLUMN timestamp SET NOT NULL, ALTER COLUMN timestamp SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE projects ADD CONSTRAINT ck_projects_created_at_finite CHECK (isfinite(created_at) AND created_at >= '0001-01-01T00:00:00Z'::timestamptz AND created_at < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_created_at_finite CHECK (isfinite(created_at) AND created_at >= '0001-01-01T00:00:00Z'::timestamptz AND created_at < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE audit_events ADD CONSTRAINT ck_audit_events_timestamp_finite CHECK (isfinite(timestamp) AND timestamp >= '0001-01-01T00:00:00Z'::timestamptz AND timestamp < '10000-01-01T00:00:00Z'::timestamptz);
--> statement-breakpoint
ALTER INDEX idx_projects_created_time RENAME TO idx_projects_created_at;
ALTER INDEX idx_tasks_created_time_id RENAME TO idx_tasks_created_id;
ALTER INDEX idx_tasks_feature_created_time_id RENAME TO idx_tasks_feature_created_id;
ALTER INDEX idx_audit_timestamp_time_id RENAME TO idx_audit_timestamp_id;
DROP FUNCTION tsp_parse_iso8601(text);
