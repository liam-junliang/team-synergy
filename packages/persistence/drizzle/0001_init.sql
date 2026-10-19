CREATE TABLE "projects" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "current_snapshot" integer DEFAULT 0 NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
  "user_id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "bind_token_hash" text,
  "bind_token_expires_at" text,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
  "principal_id" text NOT NULL,
  "project_id" text NOT NULL,
  "role" text NOT NULL,
  "display_name" text NOT NULL,
  "created_at" text NOT NULL,
  PRIMARY KEY ("principal_id", "project_id")
);
--> statement-breakpoint
CREATE TABLE "devices" (
  "device_id" text PRIMARY KEY NOT NULL,
  "principal_id" text NOT NULL,
  "device_name" text,
  "credential_hash" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "features" (
  "feature_id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "title" text NOT NULL,
  "goal" text,
  "status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements" (
  "requirement_id" text PRIMARY KEY NOT NULL,
  "feature_id" text NOT NULL,
  "title" text NOT NULL,
  "current_revision" integer DEFAULT 0 NOT NULL,
  "state" text DEFAULT 'draft' NOT NULL,
  "owner_principal_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_revisions" (
  "requirement_id" text NOT NULL,
  "revision" integer NOT NULL,
  "summary" text,
  "acceptance_criteria" text NOT NULL,
  "open_questions" text,
  "created_at" text NOT NULL,
  PRIMARY KEY ("requirement_id", "revision")
);
--> statement-breakpoint
CREATE TABLE "defects" (
  "defect_id" text PRIMARY KEY NOT NULL,
  "feature_id" text NOT NULL,
  "title" text NOT NULL,
  "severity" text NOT NULL,
  "reported_by" text NOT NULL,
  "found_in" text,
  "description" text NOT NULL,
  "status" text DEFAULT 'reported' NOT NULL,
  "related_requirement" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
  "task_id" text PRIMARY KEY NOT NULL,
  "feature_id" text NOT NULL,
  "title" text NOT NULL,
  "profile" text NOT NULL,
  "source" text DEFAULT 'requirement' NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "requirement_id" text,
  "defect_id" text,
  "assignee_principal_id" text,
  "acceptance" text NOT NULL,
  "validation_seams" text,
  "scope" text,
  "base_snapshot" integer NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
  "task_id" text NOT NULL,
  "depends_on_task_id" text NOT NULL,
  PRIMARY KEY ("task_id", "depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
  "workspace_id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL UNIQUE,
  "path" text NOT NULL,
  "git_base" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
  "run_id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "profile" text NOT NULL,
  "workspace_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "base_snapshot" integer NOT NULL,
  "started_at" text NOT NULL,
  "finished_at" text
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
  "session_id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "agent_command" text NOT NULL,
  "launch_kind" text NOT NULL,
  "prompt_path" text,
  "resumed_from_session_id" text,
  "process_id" integer,
  "status" text NOT NULL,
  "started_at" text NOT NULL,
  "finished_at" text,
  "exit_code" integer,
  "last_error" text,
  "last_output" text
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
  "artifact_id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "run_id" text,
  "kind" text NOT NULL,
  "uri" text NOT NULL,
  "content_hash" text NOT NULL,
  "published" boolean DEFAULT false NOT NULL,
  "published_at" text
);
--> statement-breakpoint
CREATE TABLE "evidences" (
  "evidence_id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "run_id" text,
  "type" text NOT NULL,
  "acceptance_refs" text,
  "result" text NOT NULL,
  "command" text,
  "summary" text,
  "report_uri" text,
  "recorded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "timestamp" text NOT NULL,
  "principal_id" text NOT NULL,
  "run_id" text,
  "action" text NOT NULL,
  "entity_id" text NOT NULL,
  "base_snapshot" integer NOT NULL,
  "from_state" text,
  "to_state" text,
  "payload" text
);
--> statement-breakpoint
CREATE TABLE "context_graph_snapshots" (
  "graph_id" text NOT NULL,
  "graph_snapshot" integer NOT NULL,
  "project_id" text NOT NULL,
  "created_at" text NOT NULL,
  PRIMARY KEY ("graph_id", "graph_snapshot")
);
--> statement-breakpoint
CREATE TABLE "context_nodes" (
  "node_id" text NOT NULL,
  "graph_id" text NOT NULL,
  "graph_snapshot" integer NOT NULL,
  "kind" text NOT NULL,
  "verification" text NOT NULL,
  "freshness" text NOT NULL,
  "payload" text,
  PRIMARY KEY ("node_id", "graph_id", "graph_snapshot")
);
--> statement-breakpoint
CREATE TABLE "context_edges" (
  "edge_id" text NOT NULL,
  "graph_id" text NOT NULL,
  "graph_snapshot" integer NOT NULL,
  "from_node" text NOT NULL,
  "to_node" text NOT NULL,
  "relation" text NOT NULL,
  "verification" text NOT NULL,
  "freshness" text NOT NULL,
  PRIMARY KEY ("edge_id", "graph_id", "graph_snapshot")
);
--> statement-breakpoint
CREATE INDEX "idx_users_status" ON "users" ("status");
--> statement-breakpoint
CREATE INDEX "idx_members_project" ON "members" ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_devices_principal" ON "devices" ("principal_id");
--> statement-breakpoint
CREATE INDEX "idx_features_project" ON "features" ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_requirements_feature" ON "requirements" ("feature_id");
--> statement-breakpoint
CREATE INDEX "idx_requirements_state" ON "requirements" ("state");
--> statement-breakpoint
CREATE INDEX "idx_defects_feature" ON "defects" ("feature_id");
--> statement-breakpoint
CREATE INDEX "idx_defects_status" ON "defects" ("status");
--> statement-breakpoint
CREATE INDEX "idx_tasks_feature" ON "tasks" ("feature_id");
--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" ("status");
--> statement-breakpoint
CREATE INDEX "idx_tasks_assignee" ON "tasks" ("assignee_principal_id");
--> statement-breakpoint
CREATE INDEX "idx_tasks_requirement" ON "tasks" ("requirement_id");
--> statement-breakpoint
CREATE INDEX "idx_tasks_defect" ON "tasks" ("defect_id");
--> statement-breakpoint
CREATE INDEX "idx_task_deps_on" ON "task_dependencies" ("depends_on_task_id");
--> statement-breakpoint
CREATE INDEX "idx_runs_task" ON "runs" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_runs_status" ON "runs" ("status");
--> statement-breakpoint
CREATE INDEX "idx_runs_principal" ON "runs" ("principal_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_task_active" ON "runs" ("task_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_run_started" ON "agent_sessions" ("run_id", "started_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_status" ON "agent_sessions" ("status");
--> statement-breakpoint
CREATE INDEX "idx_artifacts_task" ON "artifacts" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_evidences_task" ON "evidences" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_evidences_type" ON "evidences" ("type");
--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_events" ("entity_id");
--> statement-breakpoint
CREATE INDEX "idx_audit_principal" ON "audit_events" ("principal_id");
--> statement-breakpoint
CREATE INDEX "idx_nodes_snapshot" ON "context_nodes" ("graph_id", "graph_snapshot");
--> statement-breakpoint
CREATE INDEX "idx_edges_snapshot" ON "context_edges" ("graph_id", "graph_snapshot");
--> statement-breakpoint
CREATE INDEX "idx_edges_from" ON "context_edges" ("from_node", "graph_snapshot");
--> statement-breakpoint
CREATE INDEX "idx_edges_to" ON "context_edges" ("to_node", "graph_snapshot");
