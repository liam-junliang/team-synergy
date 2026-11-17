ALTER TABLE users ADD COLUMN login_failure_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN login_locked_until timestamptz;
--> statement-breakpoint
CREATE TABLE auth_rate_limits (
  key text PRIMARY KEY,
  minute_started_at timestamptz NOT NULL,
  minute_count integer NOT NULL,
  hour_started_at timestamptz NOT NULL,
  hour_count integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_auth_rate_limits_expiry ON auth_rate_limits(hour_started_at);
