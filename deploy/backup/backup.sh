#!/bin/sh
# One custom-format dump of the planner database into /backups, with a free-space
# check before it starts, a readability check after, and rotation of old dumps.
#
# Exits non-zero on any failure, so the caller (scheduler.sh, a systemd timer, or
# you at the keyboard) can tell a bad night from a good one.
#
#   docker compose -f deploy/compose.prod.yml exec backup /bin/sh /opt/backup/backup.sh
#
# DATABASE_URL carries the password. It is never echoed: no `set -x`, and every
# log line prints the database name only.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"

log() { echo "[backup] $(date -u +%FT%TZ) $*"; }
die() { echo "[backup] ERROR: $*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"
mkdir -p "$BACKUP_DIR"

# Name the file after the database, never after the URL (which holds the password).
DB_NAME=$(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')
STAMP=$(date -u +%Y%m%d-%H%M%S)
TARGET="${BACKUP_DIR}/${DB_NAME}-${STAMP}.dump"
TMP="${TARGET}.partial"

# --- 1. Free space, BEFORE writing anything ----------------------------------
FREE_MB=$(df -Pm "$BACKUP_DIR" | awk 'NR==2 {print $4}')
log "free space: ${FREE_MB} MB (minimum ${MIN_FREE_MB} MB)"
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || die "only ${FREE_MB} MB free in ${BACKUP_DIR}, need ${MIN_FREE_MB} MB. Rotate or grow the volume; refusing to start a dump that may not fit."

# --- 2. Dump -----------------------------------------------------------------
# Write to .partial first: an interrupted dump must never look like a good one.
log "dumping database '${DB_NAME}'"
if ! pg_dump --format=custom --no-owner --no-privileges --file="$TMP" "$DATABASE_URL"; then
  rm -f "$TMP"
  die "pg_dump failed"
fi

# --- 3. Verify the archive is readable ---------------------------------------
if ! pg_restore --list "$TMP" >/dev/null 2>&1; then
  rm -f "$TMP"
  die "pg_restore --list could not read the dump — it is corrupt, discarding"
fi

TOC_ENTRIES=$(pg_restore --list "$TMP" | grep -c 'TABLE DATA' || true)
[ "$TOC_ENTRIES" -gt 0 ] || log "WARNING: the dump contains no TABLE DATA entries (empty database?)"

mv "$TMP" "$TARGET"
SIZE=$(du -h "$TARGET" | awk '{print $1}')
log "wrote $(basename "$TARGET") (${SIZE}, ${TOC_ENTRIES} table-data entries)"

# --- 4. Rotate ---------------------------------------------------------------
# Deleted only AFTER the new dump is on disk and verified, so a failure above
# leaves the old backups untouched. The newest file is excluded explicitly: with
# retention set low and a long gap between runs, an mtime sweep could otherwise
# delete the dump just taken.
NEWEST=$(ls -1t "${BACKUP_DIR}"/*.dump 2>/dev/null | head -1 || true)
DELETED=0
for f in $(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' -mtime "+${RETENTION_DAYS}" 2>/dev/null); do
  [ "$f" = "$NEWEST" ] && continue
  rm -f "$f" && DELETED=$((DELETED + 1))
done
log "rotation: removed ${DELETED} dump(s) older than ${RETENTION_DAYS} days"

REMAINING=$(ls -1 "${BACKUP_DIR}"/*.dump 2>/dev/null | wc -l | tr -d ' ')
log "done: ${REMAINING} dump(s) retained in ${BACKUP_DIR}"

# --- 5. Offsite (optional) ---------------------------------------------------
# Never fails the backup: a local dump that exists beats a failed upload.
# Tested with -f, not -x: these scripts are bind-mounted read-only from the repo,
# and the execute bit does not survive every checkout (Windows clones drop it).
# Everything here is invoked through `/bin/sh <path>` for the same reason.
if [ -n "${OFFSITE_REMOTE:-}" ] && [ -f /opt/backup/offsite.sh ]; then
  log "offsite: uploading"
  /bin/sh /opt/backup/offsite.sh "$TARGET" || log "WARNING: offsite upload failed; the local dump is fine"
fi
