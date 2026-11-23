ALTER TABLE remote_mcp_grants
  ADD COLUMN allow_workspace_write boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE remote_mcp_oauth_requests
  ADD COLUMN requested_workspace_write boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_workspace_write boolean NOT NULL DEFAULT false;
