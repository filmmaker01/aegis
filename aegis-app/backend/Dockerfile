FROM oven/bun:1.3.14 AS build

WORKDIR /app

# Copy the repository instead of enumerating workspace manifests. The master branch
# intentionally has no mobile package, while the mobile branch does; this build must
# remain valid for both repository shapes.
COPY . .

RUN bun install --frozen-lockfile --filter @web-app-demo/backend

WORKDIR /app/backend

RUN DATABASE_URL="postgresql://superuser:superpassword@localhost:5432/web_app_demo?schema=public" bun run prisma:generate

FROM oven/bun:1.3.14 AS runtime

WORKDIR /app

COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/backend ./backend

WORKDIR /app/backend

ENV NODE_ENV=production

# Liveness only: is the process still serving? A dead database must NOT mark the
# container unhealthy — restarting the bot cannot revive Postgres, it would just
# flap. /ready reports database state and is for monitoring, not for the
# supervisor. No curl in this image and none added: bun does the request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Serve only. Migrations are NOT run here: they belong to the one-shot `migrate`
# service in deploy/compose.prod.yml, which the backend waits on via
# `condition: service_completed_successfully`. Running `migrate deploy` from this
# CMD under `restart: unless-stopped` would crash-loop the bot on a bad migration
# and retry DDL on every restart. `start:prod` (migrate + serve) is kept in
# package.json for hosts that have no orchestration to express the dependency.
# The Prisma client is already generated in the build stage.
CMD ["bun", "run", "start:raw"]
