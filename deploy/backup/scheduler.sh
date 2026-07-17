#!/bin/sh
# Entrypoint of the `backup` service: run backup.sh once a day at
# BACKUP_SCHEDULE_HOUR (UTC), then wait for the next one.
#
# Why a loop and not cron:
#   - postgres:17-alpine ships no running crond, so cron would mean installing
#     and supervising another process in the container;
#   - cron writes to its own mail/log sink, so a failed dump would be invisible
#     to `docker compose logs backup` — exactly when you need to see it;
#   - this keeps schedule, output and exit codes in one place, with nothing extra
#     installed, and `restart: unless-stopped` already supervises it.
#
# A host systemd timer is the other reasonable option; deploy/README.md documents
# it for anyone who prefers it.
#
# Shutdown behaviour (important): `docker compose stop` sends SIGTERM and then,
# after its timeout (10s by default), SIGKILL. A single long `sleep 8h` does NOT
# see the signal until it returns, so the container would hang for the full grace
# period and then be killed. Instead this waits in short POLL_SECONDS quanta and
# checks a stop flag between them, and a TERM/INT trap sets that flag — so the
# loop returns within one quantum of the signal and exits 0 cleanly.
#
# The loop never exits on a FAILED dump: one bad night must not take the service
# down. The failure is logged loudly and the next run is attempted as scheduled.

set -eu

HOUR="${BACKUP_SCHEDULE_HOUR:-3}"
# How often the wait loop wakes to re-check the clock and the stop flag. Small
# enough that shutdown is prompt (< this many seconds), large enough to stay
# idle. 5s is well inside Compose's 10s stop grace period.
POLL_SECONDS="${BACKUP_POLL_SECONDS:-5}"
ALIVE=/tmp/backup-scheduler-alive

STOP=0
log() { echo "[backup-scheduler] $(date -u +%FT%TZ) $*"; }

on_term() {
  log "received stop signal — exiting after the current wait quantum"
  STOP=1
}
trap on_term TERM INT

# Sleep for `$1` seconds in POLL_SECONDS chunks, returning early if a stop signal
# arrives. Returns 1 when interrupted so the caller can break out.
wait_interruptible() {
  remaining="$1"
  while [ "$remaining" -gt 0 ]; do
    [ "$STOP" -eq 1 ] && return 1
    step="$POLL_SECONDS"
    [ "$remaining" -lt "$step" ] && step="$remaining"
    # `sleep` is interrupted by the trap on most shells, but the short quantum is
    # what actually bounds shutdown latency, so correctness does not rely on it.
    sleep "$step"
    remaining=$((remaining - step))
    touch "$ALIVE"
  done
  return 0
}

touch "$ALIVE"
log "started; daily dump at ${HOUR}:00 UTC; poll ${POLL_SECONDS}s; retention ${BACKUP_RETENTION_DAYS:-14}d"

while [ "$STOP" -eq 0 ]; do
  now_h=$(date -u +%H); now_h=$((10#$now_h))
  now_m=$(date -u +%M); now_m=$((10#$now_m))
  target=$((10#$HOUR))

  wait_min=$(( target * 60 - (now_h * 60 + now_m) ))
  [ "$wait_min" -le 0 ] && wait_min=$((wait_min + 1440))
  log "next dump in ${wait_min} min"

  if ! wait_interruptible $((wait_min * 60)); then
    break   # stop signal during the wait
  fi
  [ "$STOP" -eq 1 ] && break

  touch "$ALIVE"
  if /bin/sh /opt/backup/backup.sh; then
    log "dump OK"
  else
    log "DUMP FAILED (exit $?) — the stack keeps running; investigate now"
  fi

  # Avoid double-firing inside the same target minute (interruptible too).
  wait_interruptible 90 || break
done

log "stopped"
exit 0
