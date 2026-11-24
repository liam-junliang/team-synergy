ALTER TABLE device_sessions
  ADD COLUMN access_expires_at text,
  ADD COLUMN previous_access_token_hash text,
  ADD COLUMN previous_access_expires_at text,
  ADD COLUMN refresh_token_hash text,
  ADD COLUMN previous_refresh_token_hash text,
  ADD COLUMN refresh_request_id_hash text,
  ADD COLUMN last_refreshed_at text;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_device_sessions_previous_access_token ON device_sessions (previous_access_token_hash)
  WHERE previous_access_token_hash IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_device_sessions_refresh_token ON device_sessions (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_device_sessions_previous_refresh_token ON device_sessions (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;
