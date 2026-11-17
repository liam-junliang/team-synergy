ALTER TABLE memory_fragments ADD COLUMN applicability text NOT NULL DEFAULT 'project'
  CHECK (applicability IN ('project','account') AND (applicability = 'project' OR state = 'preference'));
