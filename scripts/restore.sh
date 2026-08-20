#!/usr/bin/env bash
# Restores a dump produced by scripts/backup.sh.
#
#   ./scripts/restore.sh backups/medicaldb-20260820T110000Z.dump
#
# THIS REPLACES THE CONTENTS OF THE DATABASE. It drops every object in the
# target and rebuilds it from the dump, so anything written since the dump was
# taken is gone. It asks before doing that unless FORCE=1.

set -euo pipefail

DUMP="${1:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-}"

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Usage: $0 <dump-file>" >&2
  echo "Available:" >&2
  ls -1t backups/*.dump 2>/dev/null | head -10 | sed 's/^/  /' >&2 || echo "  (none)" >&2
  exit 1
fi

compose() {
  if [[ -n "$ENV_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

DB_USER="$(compose exec -T postgres printenv POSTGRES_USER | tr -d '\r')"
DB_NAME="$(compose exec -T postgres printenv POSTGRES_DB | tr -d '\r')"

if [[ "${FORCE:-0}" != "1" ]]; then
  echo "About to REPLACE the contents of '${DB_NAME}' from ${DUMP}."
  echo "Everything written since that dump will be lost."
  read -r -p "Type the database name to confirm: " CONFIRM
  [[ "$CONFIRM" == "$DB_NAME" ]] || { echo "Aborted."; exit 1; }
fi

echo "Restoring ${DUMP} into ${DB_NAME}..."

# --clean --if-exists drops existing objects first; without it the restore fails
# on every table that already exists and leaves a half-restored database.
# --single-transaction makes the whole thing atomic: a failure rolls back rather
# than leaving the database in a state that is neither the old one nor the new.
compose exec -T postgres pg_restore \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --single-transaction \
  < "$DUMP"

echo "Restored. Verify before trusting it:"
echo "  compose exec -T postgres psql -U ${DB_USER} -d ${DB_NAME} -c '\\dt'"
