#!/bin/sh
# Runs once per container start, before whatever CMD was passed (normally
# `node src/index.js`). `migrate deploy` is idempotent — it only applies
# migrations that haven't run against this database yet — so this is safe to
# run on every boot, not just the first one.
#
# `set -e`: a failed migration must stop the boot, not fall through into
# starting a server against a schema the code doesn't match.
set -e

echo "Running database migrations..."
npx prisma migrate deploy

# `exec "$@"` replaces this shell process with the command Docker passed
# (CMD, or whatever overrides it), so the node process becomes PID 1 and
# receives SIGTERM directly from the container runtime. Without exec, this
# shell stays PID 1 and node runs as its child — the same signal-swallowing
# problem the Dockerfile's CMD comment already avoids by not using `npm start`.
exec "$@"
