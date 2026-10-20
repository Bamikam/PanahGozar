# Deployment guide

This repository deploys as **one web service + one PostgreSQL database**. The same Node
process serves the React SPA and the Fastify API. No worker, VPN daemon, privileged
container, raw UDP port, or second application service is required.

> Protocol listeners do not run in this deployment. The panel manages validated configuration
> for externally hosted servers. See [compatibility.md](compatibility.md).

## Prerequisites

- GitHub repository containing this project.
- Node.js 20.9+ (22 recommended) and pnpm 9.6 for local checks.
- PostgreSQL 15+ (Railway/Render managed is supported and preferred).
- Secrets generated locally or by the platform (never committed):
  - `SESSION_SECRET`: `openssl rand -base64 48`
  - `ENCRYPTION_KEY`: `openssl rand -hex 32` (or Render's generated base64 32-byte value)
  - `SETUP_TOKEN`: `openssl rand -base64 24` (one-time first-admin provisioning)

## Release model

The only schema changes are committed Prisma migrations. The release path is:

```bash
pnpm db:migrate   # prisma migrate deploy (forward-only)
pnpm db:seed      # idempotent roles + protocol catalog + safe settings
pnpm start        # node dist/server/index.js
```

- Render runs `pnpm release` in `preDeployCommand` before routing traffic to the new release.
- Railway/Docker: the image entrypoint runs migrate + seed when
  `RUN_MIGRATIONS_ON_START=1` and `RUN_SEED_ON_START=1` (defaults in the Docker image).
- Generic platforms: run `pnpm release` in a release phase or set the flags for a
  single-replica startup.
- Never use `prisma migrate dev` against production. Never run `prisma migrate reset` on a
  managed database.

Keep **one replica** while session/rate-limit storage is in-memory. A horizontally scaled
deployment needs shared session/rate-limit infrastructure first.

## Render (Blueprint)

1. Push the repository to GitHub (default branch `main` unless you edit `render.yaml`).
2. In Render: **New -> Blueprint** -> select the repository.
3. Render reads [`render.yaml`](../render.yaml):
   - one `web` service (`runtime: node`, `plan: 0.5c-512mb`, health `/api/ready`),
   - one managed PostgreSQL (`plan: 0.5c-1g`, PostgreSQL 17, private-network only),
   - `DATABASE_URL` wired from the database's internal connection string,
   - `SESSION_SECRET` and `ENCRYPTION_KEY` generated,
   - `SETUP_TOKEN` requested as a secret (`sync: false`).
4. Provide `SETUP_TOKEN` when prompted and apply the Blueprint.
5. The first deploy runs the build, then `pnpm release` in the pre-deploy phase, then starts
   the service. Wait for the health check `/api/ready` to pass.
6. Open `https://<service>.onrender.com`. `PUBLIC_URL` is automatically derived from
   `RENDER_EXTERNAL_URL`. If you use a custom domain, set `PUBLIC_URL` explicitly to that
   HTTPS origin, because subscription links must be externally correct.
7. Complete the first-admin setup with the token. Remove `SETUP_TOKEN` afterward and redeploy
   if your security policy requires removing the unused value.

Notes:

- The selected plans are paid; free PostgreSQL is time-limited and unsuitable for durable
  production data. Change plans in the dashboard if needed.
- The Blueprint does not attach a persistent disk. All state is in PostgreSQL.
- `RENDER_EXTERNAL_URL` is a built-in Render variable. If it is unavailable for some reason,
  set `PUBLIC_URL=https://your-service.onrender.com` manually.
- Render sends SIGTERM; the app closes Fastify and Prisma with a bounded 25 s timeout.
- Render's health check path is `/api/ready`: it returns 503 if PostgreSQL/migrations are not
  ready, preventing a broken instance from receiving traffic.

### Render shell / first admin without SETUP_TOKEN

If you deploy without `SETUP_TOKEN`, the HTTP setup route is disabled. Use the Render Shell:

```bash
pnpm ops:create-admin -- --username admin --password 'a-long-random-password'
```

Then sign in normally. This command refuses known defaults and short passwords.

## Railway

Railway currently supports Config-as-Code for legacy services only. The documented path for
a new deployment is to let Railway build the Dockerfile and configure networking/variables in
the dashboard.

### Option A: automatic Dockerfile (recommended)

1. Push the repository to GitHub.
2. Railway: **New Project -> Deploy from GitHub Repo** -> select this repository.
3. Railway detects [`Dockerfile`](../Dockerfile) and builds the production image.
4. Add a PostgreSQL service: **+ New -> Database -> PostgreSQL**.
5. In the web service's **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (internal reference; use the variable name
     Railway shows for your database service).
   - `SESSION_SECRET` = output of `openssl rand -base64 48`.
   - `ENCRYPTION_KEY` = output of `openssl rand -hex 32`.
   - `SETUP_TOKEN` = output of `openssl rand -base64 24`.
   - `NODE_ENV` = `production`.
   - `LOG_LEVEL` = `info`.
   - `PUBLIC_URL` is optional; it is derived from `RAILWAY_PUBLIC_DOMAIN` when omitted. Set it
     explicitly for a custom domain.
6. **Settings -> Networking -> Generate Domain** to expose the HTTP service.
7. **Settings -> Healthcheck Path** = `/api/ready` (if not already picked up).
8. Deploy. The image runs migrations and idempotent seed data before Node starts.
9. Open the domain, complete the first-admin setup, then sign in.
10. Keep one replica. Do not add a TCP Proxy unless a separate protocol service actually
    listens on that port; this app does not. UDP forwarding is unavailable on Railway public
    networking.

If you need the release phase separated from container start (recommended for multiple
replicas):

- set `RUN_MIGRATIONS_ON_START=0` and `RUN_SEED_ON_START=0`,
- run `pnpm release` in your CI/CD release step against the production database,
- deploy the new image.

### Option B: legacy Config-as-Code / Railpack

[`railway.json`](../railway.json) is included for existing Railway services already opted into
Config-as-Code. It configures:

- RAILPACK builder,
- frozen-lockfile install + Prisma generate + production build,
- `pnpm release` pre-deploy (migrations + seed),
- `pnpm start`, `/api/ready` health check, restart policy and graceful overlap/draining.

Per Railway's documentation reviewed on **19 October 2026**, Config-as-Code is deprecated;
new services cannot opt in, and existing config-as-code files stop being read on
**1 December 2026**. For a new service, use Option A or configure the equivalent commands in
the dashboard. Do not rely on `railway.json` alone for a brand-new service.

Both `railway.json` and `render.yaml` are validated against the platforms' official JSON
schemas (`https://railway.com/railway.schema.json` and
`https://render.com/schema/render.yaml.json`) in local release checks, in addition to the
repository's structural deployment validator (`pnpm ops:validate-manifests`).

### Railway PostgreSQL

Use the managed PostgreSQL plugin/service. Prefer the private/internal connection URL. If TLS
is required by your provider, append `?sslmode=require` as instructed by Railway. Do not expose
the database publicly unless you have a specific need and network restrictions.

## Generic Docker / other hosts

```bash
docker build -t panahgozar .
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://user:pass@db:5432/panahgozar?schema=public' \
  -e SESSION_SECRET='...' \
  -e ENCRYPTION_KEY='...' \
  -e PUBLIC_URL='https://panel.example.com' \
  -e SETUP_TOKEN='...' \
  panahgozar
```

- Runs as the non-root `node` user.
- Exposes one HTTP port only; no `--privileged`, `--network host`, `NET_ADMIN`, or UDP ports.
- Requires external PostgreSQL and durable database backups.
- Startup migration/seed flags are enabled in the image and can be disabled in orchestrated
  release pipelines.

## Database and backups

- Use managed PostgreSQL.
- Take provider backups; the app does not include a backup subsystem.
- Store `ENCRYPTION_KEY` in a secret manager and back it up separately. Losing it makes all
  sealed credentials unreadable.
- Rotate `SESSION_SECRET` to force reauthentication. No separate session table migration is
  needed; old hashes become unreachable.
- Rotating `ENCRYPTION_KEY` requires a controlled credential re-seal procedure, which is not
  automated in this release. Treat key rotation as a planned migration with exports/rotation.

## Verify a deployment

Replace the host with your deployment origin:

```bash
curl -fsS https://YOUR_HOST/api/health
curl -fsS https://YOUR_HOST/api/ready
curl -fsSI https://YOUR_HOST/ | head
```

Expected:

- `/api/health` -> 200, `{ "status": "ok" }` independent of PostgreSQL.
- `/api/ready` -> 200 with database/migrations/reference-data checks, or 503 with sanitized
  details if a dependency is not ready.
- `/` -> 200 HTML with the SPA; `/assets/...` -> static assets with immutable caching.
- `/api/clients` without a session -> 401.
- Setup screen appears only when no administrator exists; `SETUP_TOKEN` is required.

## Rollback

1. Application rollback: redeploy the previous successful build/image via the platform.
2. Database: migrations are forward-only. Prefer a roll-forward fix. Restoring a database
   snapshot is a last resort and loses subsequent writes.
3. If a release adds columns, the previous application version normally remains compatible
   because additions are nullable/defaulted; verify before relying on this.

## Deployment status

No live Railway or Render deployment is claimed by this repository. CI validates builds and
manifests; actual platform build success must be confirmed on the platform before announcing
it. See the README verification table.
