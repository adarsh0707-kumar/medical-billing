#!/usr/bin/env bash
# Takes a compressed logical backup of the database.
#
#   ./scripts/backup.sh                       # development stack
#   COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.prod ./scripts/backup.sh
#
# Writes backups/medicaldb-<timestamp>.dump in pg_dump's custom format, which
# pg_restore can read selectively and which compresses far better than SQL text.
#
# A backup you have never restored is a hope, not a backup. scripts/restore.sh
# is the other half, and docs/06 documents rehearsing it.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-}"
OUT_DIR="${OUT_DIR:-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

compose() {
  if [[ -n "$ENV_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

# Read the credentials from the running container rather than duplicating them
# here, so this script cannot drift out of step with the stack it backs up.
DB_USER="$(compose exec -T postgres printenv POSTGRES_USER | tr -d '\r')"
DB_NAME="$(compose exec -T postgres printenv POSTGRES_DB | tr -d '\r')"

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/${DB_NAME}-${STAMP}.dump"

echo "Backing up ${DB_NAME} as ${DB_USER} -> ${OUT}"

# --format=custom for selective restore, --no-owner so the dump restores cleanly
# into a database whose role names differ from production's.
compose exec -T postgres pg_dump \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --format=custom \
  --no-owner \
  --no-privileges \
  > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "Wrote ${OUT} (${SIZE})"

# A zero-byte file means pg_dump failed while the shell reported success.
if [[ ! -s "$OUT" ]]; then
  echo "ERROR: the dump is empty. Not keeping it." >&2
  rm -f "$OUT"
  exit 1
fi

if [[ "$RETAIN_DAYS" -gt 0 ]]; then
  find "$OUT_DIR" -name "${DB_NAME}-*.dump" -type f -mtime "+${RETAIN_DAYS}" -print -delete \
    | sed 's/^/  pruned /' || true
fi
