#!/bin/sh
# Starts as root only to make the mounted storage disk writable, then drops to the unprivileged
# `node` user for the actual process (API, worker or migrations).
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /repo/apps/api/storage
  chown -R node:node /repo/apps/api/storage 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
