-- Existing project-bound connections keep their project FK and scope.
ALTER TABLE remote_mcp_grants ALTER COLUMN project_id DROP NOT NULL;
