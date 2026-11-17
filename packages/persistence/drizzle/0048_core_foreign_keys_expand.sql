-- Expand only: reject existing orphans and fence new writes before validation.
-- RESTRICT deletes are immediate even when insertion checks are explicitly deferred.
DO $$
DECLARE item record; orphan_count bigint; existing record;
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
    SELECT c.* INTO existing FROM pg_constraint c
      WHERE c.conrelid = to_regclass(format('public.%I', item.child_table)) AND c.conname = item.constraint_name;
    IF FOUND THEN
      IF existing.contype <> 'f' OR existing.confrelid <> to_regclass(format('public.%I', item.parent_table))
        OR existing.confdeltype <> 'r' OR existing.confupdtype <> 'a' OR NOT existing.condeferrable OR existing.condeferred
        OR existing.conkey <> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = existing.conrelid AND attname = item.child_column)]
        OR existing.confkey <> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = existing.confrelid AND attname = 'id')]
      THEN
        RAISE EXCEPTION 'Core reference constraint % has an unexpected definition; inspect it manually before retrying.', item.constraint_name USING ERRCODE = '55000';
      END IF;
    ELSE
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID',
        item.child_table, item.constraint_name, item.child_column, item.parent_table);
    END IF;
  END LOOP;
END;
$$;
