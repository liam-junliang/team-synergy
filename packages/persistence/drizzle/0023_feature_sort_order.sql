ALTER TABLE "features" ADD COLUMN "sort_order" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
WITH ordered_features AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "project_id"
      ORDER BY "module_id" NULLS LAST, "title", "id"
    ) - 1 AS "next_sort_order"
  FROM "features"
)
UPDATE "features" AS feature
SET "sort_order" = ordered_features."next_sort_order"
FROM ordered_features
WHERE feature."id" = ordered_features."id";
--> statement-breakpoint
CREATE INDEX "idx_features_project_sort" ON "features" ("project_id", "sort_order");
