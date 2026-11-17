#!/usr/bin/env bash
# Install this reviewed file and compose.yaml root-owned; SSH receives image refs only.
set -euo pipefail
umask 077

if [[ -n ${SSH_ORIGINAL_COMMAND:-} ]]; then
  [[ $SSH_ORIGINAL_COMMAND != *$'\n'* && $SSH_ORIGINAL_COMMAND != *$'\r'* ]] || { echo 'Multiline commands are not allowed' >&2; exit 2; }
  read -r -a incoming <<< "$SSH_ORIGINAL_COMMAND"
  set -- "${incoming[@]}"
fi
[[ $# == 5 && ( $1 == deploy || $1 == deploy-loaded || $1 == --validate || $1 == --validate-loaded ) ]] || { echo 'Expected deploy/deploy-loaded SHA API_IMAGE WEB_IMAGE POSTGRES_IMAGE' >&2; exit 2; }
mode=$1; revision=$2; api_image=$3; web_image=$4; pg_image=$5
[[ $revision =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid revision' >&2; exit 2; }
root=${TSP_DEPLOY_ROOT:-/opt/team-synergy}
[[ $root =~ ^/[a-zA-Z0-9_/-]+$ && $root != / && $root != */ && $root != *..* ]] || { echo 'Invalid deployment root' >&2; exit 2; }
[[ -d $root && ! -L $root && $(realpath -e -- "$root") == "$root" ]] || { echo 'Deployment root must be a real existing directory' >&2; exit 2; }
for directory in config deploy backups releases; do
  [[ -d $root/$directory && ! -L $root/$directory ]] || { echo "Missing real $directory directory" >&2; exit 2; }
done
for file in config/server.env config/api.env config/db-password config/db-admin-password deploy/compose.yaml deploy/init-db.sh; do
  [[ -f $root/$file && ! -L $root/$file ]] || { echo "Missing regular $file" >&2; exit 2; }
done
[[ ! -L $root/release.env ]] || { echo 'Release file must not be a link' >&2; exit 2; }
for directory in "$root" "$root/config" "$root/backups" "$root/releases"; do
  permissions=$(stat -c '%a' -- "$directory")
  (( (8#$permissions & 0022) == 0 )) || { echo 'Deployment directories must not be group/world writable' >&2; exit 2; }
done
prefix=; config_dir=; cli_dir=; db_port=15432; web_port=8088
while IFS='=' read -r key value || [[ -n ${key:-} ]]; do
  case "$key" in
    TSP_IMAGE_PREFIX) prefix=$value;;
    TSP_CONFIG_DIR) config_dir=$value;;
    TSP_CLI_DIST_DIR) cli_dir=$value;;
    TSP_DB_PORT) db_port=$value;;
    TSP_WEB_PORT) web_port=$value;;
  esac
done < "$root/config/server.env"
[[ $prefix =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$ ]] || { echo 'Configure the allowed GHCR image prefix' >&2; exit 2; }
[[ $config_dir == "$root/config" && $cli_dir == "$root/cli-distribution" ]] || { echo 'Config and CLI paths must stay inside the deployment root' >&2; exit 2; }
[[ -d $config_dir/runtime && ! -L $config_dir/runtime && -d $cli_dir && ! -L $cli_dir ]] || { echo 'Missing real runtime/CLI directory' >&2; exit 2; }
for port in "$db_port" "$web_port"; do
  [[ $port =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Invalid configured port' >&2; exit 2; }
done
validate_image() {
  local image=$1 role=$2 digest
  if [[ $mode == *-loaded ]]; then
    [[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid loaded $role image ID" >&2; exit 2; }
  else
    digest=${image#"$prefix-$role@sha256:"}
    [[ $image == "$prefix-$role@sha256:"* && $digest =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid $role image" >&2; exit 2; }
  fi
}
validate_image "$api_image" api; validate_image "$web_image" web; validate_image "$pg_image" postgres
if [[ $mode == --validate* ]]; then echo 'Deployment inputs valid; no services changed.'; exit 0; fi

exec 9> "$root/deploy.lock"
flock -n 9 || { echo 'Another deployment holds the lock' >&2; exit 3; }
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
candidate="$root/releases/.candidate-$revision-$$.env"
previous="$root/releases/previous-$timestamp-$$.env"
log="$root/releases/deploy-$timestamp-$$.log"
backup="$root/backups/$timestamp-$revision.dump"
stage=pull; stopped=0
printf 'TSP_API_IMAGE=%s\nTSP_WEB_IMAGE=%s\nTSP_POSTGRES_IMAGE=%s\nTSP_SOURCE_REVISION=%s\nTSP_PULL_POLICY=never\n' "$api_image" "$web_image" "$pg_image" "$revision" > "$candidate"
[[ ! -f $root/release.env ]] || cp -- "$root/release.env" "$previous"
compose() { docker compose --project-name team-synergy --env-file "$root/config/server.env" --env-file "$candidate" -f "$root/deploy/compose.yaml" "$@"; }
ready() { curl --silent --show-error --fail --max-time 5 "http://127.0.0.1:$web_port/api/ready" >/dev/null; }
finish() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then
    rollback=not-attempted
    if (( stopped == 1 )) && [[ -f $previous ]]; then
      rollback=unhealthy
      if docker compose --project-name team-synergy --env-file "$root/config/server.env" --env-file "$previous" -f "$root/deploy/compose.yaml" up -d --no-deps api web >>"$log" 2>&1; then
        for attempt in {1..15}; do if ready >>"$log" 2>&1; then rollback=healthy; break; fi; sleep 2; done
      fi
    fi
    printf '{"status":"failed","revision":"%s","stage":"%s","application_rollback":"%s","database_restored":false}\n' "$revision" "$stage" "$rollback" > "$root/releases/failure-$timestamp-$$.json"
    echo "Deployment failed during $stage; database was not restored. Inspect private release logs." >&2
  fi
  [[ ! -f $candidate ]] || rm -- "$candidate"
  exit "$result"
}
trap finish EXIT
for image in "$api_image" "$web_image" "$pg_image"; do
  if [[ $mode == deploy-loaded ]]; then
    actual=$(docker image inspect --format '{{.Id}}' "$image")
    [[ $actual == "$image" ]] || { echo 'Loaded image ID mismatch' >&2; exit 4; }
  else docker pull "$image" >>"$log" 2>&1; fi
done
for image in "$api_image" "$web_image"; do
  actual=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  [[ $actual == "$revision" ]] || { echo 'Image revision mismatch' >&2; exit 4; }
done
docker run --rm --network none "$pg_image" postgres --version | grep -Eq '\(PostgreSQL\) 16\.'
stage=stop; stopped=1
compose stop --timeout 30 api web >>"$log" 2>&1
stage=database
compose up -d --wait --wait-timeout 120 db >>"$log" 2>&1
stage=backup
compose exec -T db sh -ec 'export PGPASSWORD="$(cat /run/secrets/db-password)"; exec pg_dump -h 127.0.0.1 -p "$PGPORT" -U tsp -d team_synergy --format=custom' > "$backup" 2>>"$log"
[[ -s $backup ]] || { echo 'Empty database backup' >&2; exit 5; }
sha256sum -- "$backup" > "$backup.sha256"
stage=migrate
compose run --rm --no-deps migrate >>"$log" 2>&1
stage=start
compose up -d --no-deps api web >>"$log" 2>&1
stage=ready
healthy=0
for attempt in {1..60}; do
  if ready >>"$log" 2>&1 && curl --silent --fail --max-time 5 "http://127.0.0.1:$web_port/" >/dev/null; then healthy=1; break; fi
  sleep 2
done
(( healthy == 1 )) || { echo 'Readiness failed' >&2; exit 6; }
mv -- "$candidate" "$root/release.env"
printf '{"status":"deployed","revision":"%s","database_backup":"%s","database_restored":false}\n' "$revision" "$backup" > "$root/releases/success-$timestamp-$$.json"
printf '{"status":"deployed","revision":"%s"}\n' "$revision"
