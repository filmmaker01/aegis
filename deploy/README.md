# Production deployment — one VPS, Docker Compose

The Telegram task planner runs on a single VPS: the bot, PostgreSQL 17, Caddy and
a daily backup, all in Compose. No managed database, no Supabase, no cloud
provider SDK.

```
Internet ─:80/:443─► caddy ──► backend:3000          network: edge
                                  │
                                  ├──► postgres:5432  network: internal (internal: true)
                     migrate ─────┤    (no published ports, named volume)
                     backup  ─────┘
```

`internal: true` means that network has no gateway: the database is unreachable
from the host and from the internet. That isolation — not TLS — is what makes the
plaintext `DATABASE_URL` safe, and it is exactly why `backend/src/env.ts` accepts
a bare service name in production while still rejecting a public host without TLS.

Migrations do **not** run inside the backend. The one-shot `migrate` service runs
`prisma migrate deploy` and exits; `backend` starts only after it exits 0. A bad
migration stops the rollout once, loudly, instead of crash-looping the bot.

---

## 1. Prepare an empty Ubuntu VPS

```bash
ssh root@<vps-ip>
adduser --disabled-password --gecos "" planner
usermod -aG sudo planner
rsync --archive --chown=planner:planner ~/.ssh /home/planner/

# Only SSH and HTTP(S). Postgres has no published port and must never get one.
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
ufw status
```

Disable password logins in `/etc/ssh/sshd_config` (`PasswordAuthentication no`),
then `systemctl restart ssh`.

## 2. Install Docker and Compose

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker planner        # log out and back in
docker --version
docker compose version            # MUST be v2.17.0 or newer
```

**Compose v2.17.0 is the minimum.** The backend waits for the one-shot `migrate`
service via `depends_on … condition: service_completed_successfully`, and that
condition was added in Compose v2.17.0. On older versions Compose ignores it and
starts the backend before migrations finish — against a schema that may not exist
yet. `get.docker.com` installs a current release; if you are on a pinned or
distro-packaged Compose, check the version before continuing.

## 3. DNS

An A record for your domain must point at the VPS **before** Caddy starts, or the
ACME challenge fails and you burn Let's Encrypt rate limit.

```bash
dig +short <your-domain>          # must print the VPS IP
```

## 4. Server-side `.env`

```bash
sudo mkdir -p /opt/planner && sudo chown planner:planner /opt/planner
cd /opt/planner
git clone <repo-url> .
git checkout <RELEASE_SHA>

cp deploy/.env.production.example deploy/.env
chmod 600 deploy/.env
vi deploy/.env                    # fill in every <placeholder>
```

Generate each secret with `openssl rand -hex 32`. `deploy/.env` is git-ignored and
gitleaks scans every push; it exists only on this machine.

> `DATABASE_URL`'s password must match `POSTGRES_PASSWORD`. URL-encode reserved
> characters (`@` → `%40`, `/` → `%2F`), or the URL will not parse and the backend
> will refuse to start.

## 5. First run

Bring it up one layer at a time, so a failure is obvious.

```bash
cd /opt/planner
export COMPOSE="docker compose -f deploy/compose.prod.yml --env-file deploy/.env"

# 5.1 Database
$COMPOSE up -d postgres
$COMPOSE ps                        # wait for postgres: healthy

# 5.2 Migrations on the empty database — a one-shot that must exit 0
$COMPOSE up migrate
$COMPOSE ps -a migrate             # State: exited (0)
#   expect: "All migrations have been successfully applied."

# 5.3 The bot (starts only because migrate exited 0)
$COMPOSE up -d backend
$COMPOSE logs -f backend           # "Backend listening on ..."

# 5.4 HTTPS
$COMPOSE up -d caddy
$COMPOSE logs caddy | grep -i certificate

# 5.5 Backups
$COMPOSE up -d backup
$COMPOSE logs backup               # "started; daily dump at 03:00 UTC"
```

## 6. Verify

```bash
$COMPOSE ps                                      # all Up/healthy; migrate exited (0)

curl -sS https://<your-domain>/health            # {"status":"ok"}

# /ready is not exposed publicly — it reports database state. Ask from inside:
$COMPOSE exec backend bun -e \
  "console.log(await (await fetch('http://127.0.0.1:3000/ready')).text())"
#   {"status":"ready","db":"ok","metrics":{...}}

# Applied migrations
$COMPOSE exec postgres psql -U planner -d planner \
  -c "select migration_name, finished_at from _prisma_migrations order by started_at;"

# PostgreSQL must NOT be published. Both must print nothing:
$COMPOSE port postgres 5432 2>/dev/null || echo "postgres is not published — correct"
ss -ltnp | grep 5432 || echo "nothing on 5432 on the host — correct"
```

## 7. Register the Telegram webhook

**Last step.** Until now the bot receives nothing; this is what switches it on.

```bash
cd /opt/planner/aegis-app
set -a && . ../deploy/.env && set +a
bun run --cwd backend set-webhook -- --url "https://<your-domain>/telegram/webhook" --drop-pending
bun run --cwd backend webhook-info
```

Expect `allowed_updates = ["message","callback_query"]`. **`message` must be
there**: without it Telegram delivers no commands at all and the bot looks dead
while every button still works.

`--drop-pending` discards whatever queued up while the webhook pointed elsewhere.

## 8. Command menu (`setMyCommands`)

The backend publishes it on boot, best-effort. Verify:

```bash
curl -sS "https://api.telegram.org/bot<TOKEN>/getMyCommands"
```

Expect `/start /new /tasks /today /settings /cancel`. If it is empty, restart the
backend and check its logs for `setMyCommands rejected`.

## 9. Update without losing data

```bash
cd /opt/planner
git fetch origin && git checkout <NEW_RELEASE_SHA>
git status --porcelain                  # MUST be empty

$COMPOSE build backend
$COMPOSE up migrate                     # exits 0, or stop here
$COMPOSE up -d backend
$COMPOSE logs -f backend
curl -sS https://<your-domain>/health
```

`postgres` is not recreated and `pgdata` is untouched. Take a backup first (§10)
whenever the release carries a migration.

## 10. Manual backup

```bash
$COMPOSE exec backup /bin/sh /opt/backup/backup.sh
$COMPOSE exec backup ls -lh /backups
```

It checks free space first, verifies the dump with `pg_restore --list`, then
rotates anything older than `BACKUP_RETENTION_DAYS` — never the newest one.

## 11. Restore into a scratch database (verify a backup)

A backup you have never restored is not a backup. Do this monthly.

```bash
$COMPOSE exec postgres psql -U planner -d postgres -c "create database planner_verify;"

$COMPOSE exec -e RESTORE_TARGET_URL="postgresql://planner:<PASSWORD>@postgres:5432/planner_verify" \
  backup /bin/sh /opt/backup/restore.sh <dump-file> --yes

# Compare against production
$COMPOSE exec postgres psql -U planner -d planner        -c "select count(*) from tasks;"
$COMPOSE exec postgres psql -U planner -d planner_verify -c "select count(*) from tasks;"

$COMPOSE exec postgres psql -U planner -d postgres -c "drop database planner_verify;"
```

## 12. Full production restore

**Destructive.** Read §16 first.

```bash
$COMPOSE stop backend                     # nothing may write during a restore
$COMPOSE exec backup ls -lh /backups
$COMPOSE exec backup /bin/sh /opt/backup/restore.sh planner-20260717-030000.dump
#   type RESTORE when prompted; it prints row counts afterwards
$COMPOSE up -d backend
$COMPOSE exec backend bun -e \
  "console.log(await (await fetch('http://127.0.0.1:3000/ready')).text())"
```

If `pg_restore` fails midway the database is in an unknown state: do **not** start
the backend. Restore an older dump.

## 13. Free space

The database stops when the disk fills, and the backup refuses to start a dump it
may not be able to finish (`BACKUP_MIN_FREE_MB`).

```bash
df -h /
docker system df
$COMPOSE exec backup df -h /backups
docker system prune -f                    # images/build cache only; volumes are safe
```

Never `docker system prune --volumes` here: `pgdata` is your database.

## 14. Logs

```bash
$COMPOSE logs -f backend
$COMPOSE logs backup | tail -50
$COMPOSE logs caddy | grep -i error
$COMPOSE logs migrate                     # what the last rollout migrated
```

## 15. Roll the app back without touching the schema

```bash
cd /opt/planner
git checkout <PREVIOUS_RELEASE_SHA>
$COMPOSE build backend
$COMPOSE up -d backend                    # do NOT run migrate
```

The schema stays where it is. This works when the new schema is backward
compatible with the old code — additive migrations usually are. If the release
dropped or renamed something the old code reads, a code rollback alone will not
save you: restore from backup (§12).

## 16. Destructive migrations

`prisma migrate deploy` does not ask. Before any release that drops or renames a
column, table or type:

1. Take a fresh backup (§10) and **verify it restores** (§11). Not "there is a
   dump" — verify it.
2. Read the migration SQL. If it drops anything, decide whether the data is needed.
3. Prefer expand/contract: ship the additive migration, deploy code that works
   with both shapes, and drop only in a later release. Then a code rollback is
   always possible.
4. There is no `prisma migrate down`. Rolling a schema back means restoring a
   backup — and everything written since that backup is gone.

---

## Backups: why a loop and not cron

The `backup` service runs `scheduler.sh`, a shell loop that sleeps until
`BACKUP_SCHEDULE_HOUR` and runs `backup.sh`.

`postgres:17-alpine` has no crond running, so cron would mean installing and
supervising a second process. Worse, cron writes to its own sink: a failed dump
would be invisible to `docker compose logs backup` — exactly when you need to see
it. The loop keeps schedule, output and exit codes in one place, adds nothing to
the image, and `restart: unless-stopped` already supervises it.

It waits in short `BACKUP_POLL_SECONDS` quanta (default 5s) rather than one long
`sleep`, and traps SIGTERM, so `docker compose stop` returns within a few seconds
instead of hanging until the grace period expires and the container is killed.
`init: true` puts tini at PID 1 to forward the signal; `stop_grace_period: 20s`
gives an in-progress dump room to finish.

**A host systemd timer** is the other reasonable choice. It keeps running while
the stack is down and suits a fleet — but it splits the deployment across Compose
and the host, needs unit files and root, and needs a way onto the `internal`
network. For one VPS the loop has fewer moving parts. If you want the timer:

```ini
# /etc/systemd/system/planner-backup.service
[Service]
Type=oneshot
WorkingDirectory=/opt/planner
ExecStart=/usr/bin/docker compose -f deploy/compose.prod.yml --env-file deploy/.env exec -T backup /bin/sh /opt/backup/backup.sh

# /etc/systemd/system/planner-backup.timer
[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```
```bash
systemctl enable --now planner-backup.timer
```
Then set `BACKUP_SCHEDULE_HOUR=` to nothing and drop the `backup` service's
entrypoint, or you will dump twice a day.

## Off-site backups

`deploy/backup/offsite.sh` is optional and disabled unless `OFFSITE_REMOTE` is
set. A backup on the machine it backs up dies with that machine's disk.

The safest shape is to **pull** backups from elsewhere rather than push from here:
a VPS that can delete the remote copies is a VPS whose attacker can too. If you do
push, give the credentials no delete permission and set a lifecycle policy on the
bucket. `rclone` is not in `postgres:17-alpine` — see the header of `offsite.sh`.

## What is where

| Path | |
|---|---|
| `deploy/compose.prod.yml` | the stack |
| `deploy/Caddyfile` | HTTPS + reverse proxy |
| `deploy/.env.production.example` | template; the real `.env` lives only on the server |
| `deploy/backup/scheduler.sh` | daily loop |
| `deploy/backup/backup.sh` | dump + verify + rotate |
| `deploy/backup/restore.sh` | manual restore |
| `deploy/backup/offsite.sh` | optional upload |
| `aegis-app/docker-compose.yml` | **development/CI only** — publishes ports, weak passwords |

Other deployment configs (`aegis-app/fly.toml`, `aegis-app/.do/`) target the
earlier Fly.io / DigitalOcean hosting. This PR adds the VPS stack alongside them
and leaves them untouched; whether to keep or remove them is a separate decision.
