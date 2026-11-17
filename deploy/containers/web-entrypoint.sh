#!/bin/sh
set -eu
for port in "$TSP_API_PORT" "$TSP_WEB_PORT"; do
  case "$port" in ''|*[!0-9]*) echo 'Invalid web port' >&2; exit 2;; esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || exit 2
done
envsubst '${TSP_API_PORT} ${TSP_WEB_PORT}' < /etc/nginx/tsp.conf.template > /tmp/tsp-nginx.conf
exec nginx -c /tmp/tsp-nginx.conf -g 'daemon off;'
