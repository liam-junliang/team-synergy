#!/usr/bin/env bash
# Fresh CI containers only. Never pass a deployment config or business database.
set -euo pipefail
umask 077
revision=${1:?source revision required}
[[ $revision =~ ^[a-f0-9]{40}$ ]] || exit 2
root=$(mktemp -d "${RUNNER_TEMP:-/tmp}/tsp-container-smoke-XXXXXXXX")
mkdir -p "$root/config/runtime" "$root/cli-distribution"
printf '' > "$root/config/api.env"
openssl rand -hex 32 > "$root/config/db-password"
openssl rand -hex 32 > "$root/config/db-admin-password"
chmod 440 "$root/config/db-password"
chmod 400 "$root/config/db-admin-password"
# Official PG bookworm uses UID 999; Node uses GID 1000. Both need app-password read access.
sudo chown 999:1000 "$root/config/db-password"
# The PostgreSQL entrypoint initially runs as root, then drops privileges.
sudo chown 0:0 "$root/config/db-admin-password"
export TSP_CONFIG_DIR="$root/config" TSP_CLI_DIST_DIR="$root/cli-distribution"
export TSP_API_IMAGE="${TSP_API_IMAGE:-tsp-api:$revision}" TSP_WEB_IMAGE="${TSP_WEB_IMAGE:-tsp-web:$revision}" TSP_POSTGRES_IMAGE="${TSP_POSTGRES_IMAGE:-tsp-postgres:$revision}"
export TSP_PULL_POLICY=never TSP_DB_PORT=15433 TSP_API_PORT=18081 TSP_WEB_PORT=18082 TSP_WEB_ORIGIN=http://localhost:18082
export TSP_MEMORY_ENABLED=0 TSP_CODE_ANALYSIS_ENABLED=0 TSP_SYSTEM_AGENT_ENABLED=0
project="tsp-smoke-${GITHUB_RUN_ID:-$$}"
compose() { docker compose -p "$project" -f deploy/containers/compose.yaml "$@"; }
finish() { result=$?; trap - EXIT; compose ps --all; compose down --remove-orphans >/dev/null 2>&1 || true; exit "$result"; }
trap finish EXIT
compose config --quiet
compose up -d --wait --wait-timeout 120 db
compose run --rm --no-deps migrate > "$root/migration.log" 2>&1
# Bootstrap passwords stay inside container logs; do not publish or dump those logs.
compose up -d --wait --wait-timeout 120 api web
curl --silent --fail --max-time 10 http://127.0.0.1:18082/api/ready > "$root/ready.json"
curl --silent --fail --max-time 10 http://127.0.0.1:18082/ | grep -q 'Team Synergy'
status=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:18082/api/projects)
[[ $status == 401 ]] || { echo 'Expected unauthenticated projects request to be rejected' >&2; exit 3; }
echo 'Isolated platform readiness, static page, reverse proxy and authentication smoke passed.'
