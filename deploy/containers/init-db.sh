#!/bin/sh
set -eu
# Only the empty-volume bootstrap sees the cluster administrator password.
TSP_APP_PASSWORD=$(cat /run/secrets/db-password)
export TSP_APP_PASSWORD
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password TSP_APP_PASSWORD
CREATE ROLE tsp WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
ALTER DATABASE team_synergy OWNER TO tsp;
GRANT ALL ON SCHEMA public TO tsp;
SQL
unset TSP_APP_PASSWORD
