ALTER TABLE "team_members" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    team_id,
    principal_id,
    ROW_NUMBER() OVER (PARTITION BY principal_id ORDER BY created_at, team_id) - 1 AS position
  FROM team_members
)
UPDATE team_members
SET sort_order = ranked.position
FROM ranked
WHERE team_members.team_id = ranked.team_id
  AND team_members.principal_id = ranked.principal_id;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    project_id,
    principal_id,
    ROW_NUMBER() OVER (PARTITION BY principal_id ORDER BY created_at, project_id) - 1 AS position
  FROM members
)
UPDATE members
SET sort_order = ranked.position
FROM ranked
WHERE members.project_id = ranked.project_id
  AND members.principal_id = ranked.principal_id;
