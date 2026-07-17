#!/bin/sh
# Restore the planner database from a dump. Destructive: --clean drops the
# existing objects first.
#
# NEVER runs on a schedule and never as part of a deploy. You run it, by hand,
# knowing why.
#
#   # 1. STOP the backend first, so nothing writes during the restore:
#   docker compose -f deploy/compose.prod.yml stop backend
#
#   # 2. Restore:
#   docker compose -f deploy/compose.prod.yml exec backup \
#     /bin/sh /opt/backup/restore.sh planner-20260717-030000.dump
#
#   # 3. Bring the bot back:
#   docker compose -f deploy/compose.prod.yml up -d backend
#
# Restore somewhere else first if you are only verifying a backup:
#   RESTORE_TARGET_URL=postgresql://planner:...@postgres:5432/planner_verify \
#     /bin/sh /opt/backup/restore.sh <file> --yes
#
# --yes skips the confirmation. Use it only in a script you have already thought
# about; interactively, type the word and mean it.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"

log() { echo "[restore] $(date -u +%FT%TZ) $*"; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

FILE="${1:-}"
ASSUME_YES="${2:-}"

# --- 1. An explicit file. No "latest" guessing: restoring the wrong night is
#        indistinguishable from data loss.
[ -n "$FILE" ] || die "usage: restore.sh <dump-file> [--yes]
Available dumps:
$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | sed 's#^#  #' || echo '  (none)')"

case "$FILE" in
  /*) DUMP="$FILE" ;;
  *)  DUMP="${BACKUP_DIR}/${FILE}" ;;
esac

# --- 2. It exists, is readable, and is a real archive -------------------------
[ -f "$DUMP" ] || die "no such dump: $DUMP"
[ -r "$DUMP" ] || die "dump is not readable: $DUMP"
pg_restore --list "$DUMP" >/dev/null 2>&1 || die "not a readable pg_dump archive (custom format expected): $DUMP"

TARGET_URL="${RESTORE_TARGET_URL:-${DATABASE_URL:-}}"
[ -n "$TARGET_URL" ] || die "neither RESTORE_TARGET_URL nor DATABASE_URL is set"
TARGET_DB=$(printf '%s' "$TARGET_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')

TOC_TABLES=$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)
log "dump   : $(basename "$DUMP") ($(du -h "$DUMP" | awk '{print $1}'), ${TOC_TABLES} table-data entries)"
log "target : database '${TARGET_DB}'"

# --- 3. Confirm ---------------------------------------------------------------
if [ "$ASSUME_YES" != "--yes" ]; then
  printf '[restore] This DROPS and replaces everything in "%s". Type RESTORE to continue: ' "$TARGET_DB"
  read -r ANSWER
  [ "$ANSWER" = "RESTORE" ] || die "aborted (got '${ANSWER}')"
fi

# --- 4. Restore ---------------------------------------------------------------
# --exit-on-error: stop at the first problem instead of leaving a half-restored
# database that looks fine until someone reads it.
log "restoring…"
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$TARGET_URL" "$DUMP" \
  || die "pg_restore failed — the database is now in an UNKNOWN state. Do not start the backend. Restore an older dump or rebuild."

# --- 5. Verify the schema is actually there -----------------------------------
# Counts and table names only: never message content or personal data.
log "verifying schema"
psql --dbname="$TARGET_URL" --tuples-only --no-align --quiet -c "
  select 'table: '||tablename from pg_tables where schemaname='public' order by tablename;
" || die "cannot query the restored database"

for t in bot_users tasks task_drafts; do
  if psql --dbname="$TARGET_URL" -tAc "select to_regclass('public.${t}') is not null;" | grep -q '^t$'; then
    N=$(psql --dbname="$TARGET_URL" -tAc "select count(*) from public.${t};")
    log "  ${t}: ${N} row(s)"
  else
    log "  WARNING: table '${t}' is missing from the restored database"
  fi
done

APPLIED=$(psql --dbname="$TARGET_URL" -tAc "select count(*) from _prisma_migrations where finished_at is not null;" 2>/dev/null || echo '?')
log "  migrations applied: ${APPLIED}"

log "done. Start the backend only if the numbers above look right:"
log "  docker compose -f deploy/compose.prod.yml up -d backend"
