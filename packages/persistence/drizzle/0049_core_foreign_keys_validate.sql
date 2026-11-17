-- Validate only after a successful expansion and a clean, repeated orphan check.
-- No rows are deleted, reparented or manufactured by either migration.
DO $$
DECLARE item record; orphan_count bigint;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('tasks','feature_id','features','fk_tasks_feature'),
    ('members','project_id','projects','fk_members_project'),
    ('features','project_id','projects','fk_features_project'),
    ('runs','task_id','tasks','fk_runs_task'),
    ('device_sessions','device_id','devices','fk_device_sessions_device')
  ) AS relations(child_table, child_column, parent_table, constraint_name)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I child LEFT JOIN public.%I parent ON parent.id = child.%I WHERE child.%I IS NOT NULL AND parent.id IS NULL',
      item.child_table, item.parent_table, item.child_column, item.child_column) INTO orphan_count;
    IF orphan_count <> 0 THEN
      RAISE EXCEPTION 'Core reference migration stopped: %.% -> %.id has % orphan rows. Run integrity inspection and repair the source data explicitly; no data was changed.',
        item.child_table, item.child_column, item.parent_table, orphan_count USING ERRCODE = '23503';
    END IF;
  END LOOP;

  FOR item IN SELECT * FROM (VALUES
    ('tasks','feature_id','features','fk_tasks_feature'),
    ('members','project_id','projects','fk_members_project'),
    ('features','project_id','projects','fk_features_project'),
    ('runs','task_id','tasks','fk_runs_task'),
    ('device_sessions','device_id','devices','fk_device_sessions_device')
  ) AS relations(child_table, child_column, parent_table, constraint_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass(format('public.%I', item.child_table)) AND c.conname = item.constraint_name AND c.contype = 'f') THEN
      RAISE EXCEPTION 'Core reference constraint % is missing; apply 0048_core_foreign_keys_expand first.', item.constraint_name USING ERRCODE = '55000';
    END IF;
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', item.child_table, item.constraint_name);
  END LOOP;
END;
$$;
