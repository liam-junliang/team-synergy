ALTER TABLE remote_mcp_grants
  ADD COLUMN absolute_expires_at timestamptz,
  ADD COLUMN last_refreshed_at timestamptz,
  ADD COLUMN last_refresh_failed_at timestamptz,
  ADD COLUMN last_refresh_failure_reason text;
--> statement-breakpoint
ALTER TABLE remote_mcp_grants DROP CONSTRAINT ck_remote_mcp_grants_expiry;
--> statement-breakpoint
UPDATE remote_mcp_grants AS grant_row
SET last_refreshed_at = history.last_refresh
FROM (
  SELECT grant_id, max(used_at) AS last_refresh
  FROM remote_mcp_oauth_refresh_tokens
  WHERE used_at IS NOT NULL
  GROUP BY grant_id
) AS history
WHERE grant_row.id = history.grant_id;
--> statement-breakpoint
-- Apply the renewal policy only to valid OAuth grants with a live refresh credential.
UPDATE remote_mcp_grants AS grant_row
SET absolute_expires_at = grant_row.created_at + interval '2160 hours',
    expires_at = LEAST(
      COALESCE(grant_row.last_refreshed_at, grant_row.created_at) + interval '720 hours',
      grant_row.created_at + interval '2160 hours'
    )
FROM remote_mcp_oauth_clients AS client
WHERE grant_row.oauth_client_id = client.id
  AND client.allow_refresh
  AND grant_row.revoked_at IS NULL
  AND grant_row.expires_at > now()
  AND EXISTS (
    SELECT 1 FROM remote_mcp_oauth_refresh_tokens AS credential
    WHERE credential.grant_id = grant_row.id AND credential.used_at IS NULL
  );
--> statement-breakpoint
ALTER TABLE remote_mcp_grants ADD CONSTRAINT ck_remote_mcp_grants_expiry CHECK (
  expires_at > created_at AND (
    (absolute_expires_at IS NULL AND expires_at <= created_at + interval '168 hours')
    OR (oauth_client_id IS NOT NULL AND absolute_expires_at = created_at + interval '2160 hours'
      AND expires_at <= absolute_expires_at)
  )
);
--> statement-breakpoint
ALTER TABLE remote_mcp_grants ADD CONSTRAINT ck_remote_mcp_refresh_failure CHECK (
  (last_refresh_failure_reason IS NULL AND last_refresh_failed_at IS NULL)
  OR (last_refresh_failed_at IS NOT NULL AND last_refresh_failure_reason IS NOT NULL
    AND last_refresh_failure_reason IN ('idle_expired', 'authorization_expired', 'authorization_revoked', 'access_lost', 'scope_changed', 'refresh_token_reused'))
);
