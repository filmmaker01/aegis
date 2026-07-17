#!/bin/sh
# OPTIONAL. Copy one dump to an off-VPS target.
#
# A backup that lives on the machine it backs up is not a backup: it dies with
# the disk it sits on. This uploads a copy somewhere else.
#
# Disabled unless OFFSITE_REMOTE is set. backup.sh calls it after a successful,
# verified dump and ignores a failure here — a local dump that exists beats a
# failed upload.
#
#   OFFSITE_REMOTE=s3remote:planner-backups
#
# rclone is not installed in postgres:17-alpine. Pick one:
#
#   a) Install it at container start (simplest; needs egress):
#        apk add --no-cache rclone
#   b) Bake it into a small image built FROM postgres:17-alpine.
#   c) Ignore this script and pull backups from outside instead — often the
#      safest shape, because the VPS then holds no credentials that can delete
#      the backups. A compromised VPS cannot wipe an archive it cannot reach.
#
# Credentials come from the server-side .env (rclone reads RCLONE_CONFIG_*), and
# never from git. Nothing here is echoed.

set -eu

log() { echo "[offsite] $(date -u +%FT%TZ) $*"; }
die() { echo "[offsite] ERROR: $*" >&2; exit 1; }

DUMP="${1:-}"
[ -n "$DUMP" ] || die "usage: offsite.sh <dump-file>"
[ -f "$DUMP" ] || die "no such dump: $DUMP"
[ -n "${OFFSITE_REMOTE:-}" ] || { log "OFFSITE_REMOTE is not set — skipping (local backups only)"; exit 0; }

command -v rclone >/dev/null 2>&1 || die "rclone is not installed in this image. See the options in the header of this file."

# --checksum, not size-only: a truncated upload must not pass for a good one.
log "uploading $(basename "$DUMP") -> ${OFFSITE_REMOTE}"
rclone copy --checksum "$DUMP" "$OFFSITE_REMOTE" || die "upload failed"

# Prove it landed, rather than trusting the exit code alone.
rclone lsf "${OFFSITE_REMOTE}/$(basename "$DUMP")" >/dev/null 2>&1 \
  || die "upload reported success but the file is not at the remote"

log "uploaded and verified"

# Retention at the remote is deliberately NOT handled here. Prefer a lifecycle
# policy on the bucket, or credentials with no delete permission: if this VPS can
# delete remote backups, then so can whoever takes over this VPS.
