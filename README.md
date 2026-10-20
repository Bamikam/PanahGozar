# PanahGozar

**Multi-protocol VPN & proxy management panel - configuration-first, single-service deployment.**

PanahGozar is a production-oriented TypeScript control plane for VLESS, VMess, Trojan,
Shadowsocks, SOCKS5, HTTP/HTTPS proxy, Telegram MTProto, WireGuard and OpenVPN
configuration. It runs as **one Fastify web service serving both the React SPA and the REST
API**, backed by PostgreSQL.

> **Honest runtime boundary.** This application is a configuration and credential control
> plane. It does **not** start VLESS, VMess, Trojan, Shadowsocks, SOCKS5, HTTP proxy,
> MTProto, WireGuard or OpenVPN listeners. Railway and Render web services expose an HTTP
> entry point and do not provide the UDP/kernel/privileged networking required by these
> runtimes. The panel validates and exports configuration for an externally hosted server,
> reports runtime capabilities truthfully, and **never presents a saved configuration as a
> running or reachable service**.

## What is implemented

- Secure admin authentication: Argon2id, opaque session tokens hashed at rest, HTTP-only
  SameSite cookies, CSRF double-submit, session rotation, rate limiting, role-based access
  (`admin`, `operator`, `viewer`), last-admin protection and audit trail.
- One-time first-admin setup protected by a high-entropy `SETUP_TOKEN`, plus a protected
  `pnpm ops:create-admin` CLI. No default administrator or public password exists.
- Client CRUD with soft deletion, labels/tags/notes, expiry, recorded traffic quotas and
  connection limits whose enforcement status is displayed honestly.
- Per-client credentials sealed with AES-256-GCM; credential rotation, revocation and
  history without exposing sealed values in list/detail APIs.
- Configuration CRUD with strict per-protocol Zod schemas, duplicate detection, preview,
  version history, transactional rollback, inactive-until-reviewed imports, and safe exports.
- Protocol adapters:
  - VLESS, VMess, Trojan and Shadowsocks (Xray-compatible) client URIs + server artifacts.
  - SOCKS5 and HTTP/HTTPS proxy configuration and client artifacts.
  - Telegram MTProto secret generation, redaction, `tg://` share links and server template.
  - WireGuard Curve25519 key lifecycle, sealed server key, client address allocation,
    `wg-quick` client configuration and server export.
  - OpenVPN `.ovpn` profile import with validation, forbidden-directive rejection, sealed
    username/password credentials and client profile export.
- Xray JSON import/export, sing-box JSON import, Xray merged server export, and compatible
  subscription output in `xray_uri` (base64 URI list), `raw_uri` and `singbox_json`.
- Revocable, unguessable subscription tokens (160-bit, SHA-256-hashed at rest) with rotation,
  expiry, client-disable enforcement, `no-store` headers, one-time URL display and tests.
- Runtime capability detection and diagnostics for Node, bindings, filesystem, binaries,
  database, migrations and protocol-specific requirements. Unsupported capabilities are
  machine-readable and visible in the UI.
- Polished responsive UI with English LTR and Persian RTL, dark/light themes, keyboard
  navigation, loading/empty/error states, QR codes, and no fabricated usage statistics.
- Optional fixed-path self-health keep-alive (every 3 minutes) to counter idle spin-down on
  free/Serverless hosting; enabled in the provided Docker/Render configurations and honestly
  documented as best-effort, not an uptime guarantee.
- PostgreSQL schema with Prisma migrations, indexes, foreign keys, soft deletion, audit
  events, runtime capability/health records and application settings.
- Railway, Render, Docker, GitHub Actions and OpenAPI 3.1 support.

## Architecture

```text
Browser (React + Vite + Tailwind)
        |  same origin, HttpOnly session cookie + CSRF header
        v
Fastify 5 (Node.js)  --- /api/* REST + /api/docs OpenAPI UI
        |            --- serves dist/web SPA for all non-API routes
        |            --- liveness /api/health, readiness /api/ready
        v
PostgreSQL (Prisma)  --- all persistent state, no container-local source of truth
        |
        +---- configuration/credential generators -> external protocol servers
```

Single deployment unit, one HTTP entry point, no mandatory worker or remote node. The
in-memory rate limiter and session design assume **one replica**. Do not horizontally scale
this service without moving rate limiting/session checks to shared infrastructure.

## Protocol capability status

| Protocol         | Config model + validation | Client artifact                 | Server artifact                                  | In-process runtime here | Live health verification here |
| ---------------- | ------------------------- | ------------------------------- | ------------------------------------------------ | ----------------------- | ----------------------------- |
| VLESS            | Yes                       | `vless://`                      | Xray inbound (TLS cert paths optional in config) | No                      | No                            |
| VMess            | Yes                       | `vmess://`                      | Xray inbound                                     | No                      | No                            |
| Trojan           | Yes                       | `trojan://`                     | Xray inbound (TLS mandatory)                     | No                      | No                            |
| Shadowsocks      | Yes                       | SIP002 `ss://`                  | Multi-user Xray inbound                          | No                      | No                            |
| SOCKS5           | Yes                       | `socks://` + sing-box           | Xray inbound with accounts                       | No                      | No                            |
| HTTP/HTTPS proxy | Yes                       | `http(s)://` + sing-box         | Xray inbound with accounts/TLS                   | No                      | No                            |
| Telegram MTProto | Yes                       | `tg://proxy` / `t.me/proxy`     | Erlang template + per-client secrets             | No                      | No                            |
| WireGuard        | Yes                       | `.conf`                         | WireGuard server config + peers                  | No                      | No                            |
| OpenVPN          | Yes                       | `.ovpn` with inline credentials | validated profile template                       | No                      | No                            |

Integration formats:

- **Xray JSON:** import validates untrusted input and maps only documented fields; credentials
  embedded in an import are discarded. Export produces a merged full Xray config for active
  Xray-compatible inbounds, including active client credentials.
- **sing-box JSON:** import maps documented outbounds; subscription export builds a valid
  client config for protocols with a documented sing-box outbound. sing-box itself is not
  executed here.
- **Subscriptions:** only adapters that advertise compatibility with the selected format are
  included. Returning a subscription payload is **not** evidence that any remote server is
  reachable.

See [docs/compatibility.md](docs/compatibility.md) for the platform review and exact
limitations, including what infrastructure is required to operate real listeners.

## Getting started locally

Prerequisites:

- Node.js 20.9+ (Node 22 recommended; CI uses 22)
- pnpm 9.6 (`corepack enable && corepack prepare pnpm@9.6.0 --activate`)
- PostgreSQL 15+ (local, Docker, or managed)

```bash
# 1. Install
pnpm install --frozen-lockfile

# 2. Create local env
cp .env.example .env
# then set SESSION_SECRET, ENCRYPTION_KEY, DATABASE_URL and optionally SETUP_TOKEN

# 3. Generate Prisma Client, apply schema, seed reference data
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 4. Run Vite (5173) + Fastify (3000) together
pnpm dev
# open http://127.0.0.1:5173  (Vite binds loopback IPv4 explicitly)
```

To run the production build locally with one process:

```bash
pnpm build
pnpm start      # serves dist/web + API on http://localhost:3000
```

Generate secrets:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 32      # ENCRYPTION_KEY (base64 32-byte values also accepted)
openssl rand -base64 24   # SETUP_TOKEN
```

### First administrator

1. Set a high-entropy `SETUP_TOKEN` (>= 16 chars) in the environment.
2. Start the app. While **no administrator account exists**, the login screen exposes a
   one-time setup form requiring this token.
3. Create the administrator. The route checks the token in constant time, creates the user
   and admin role in a serializable transaction, and is permanently disabled afterwards.
4. Remove `SETUP_TOKEN` from the environment after setup (recommended).

Alternative without HTTP setup: with `SETUP_TOKEN` empty, use the protected CLI from a
trusted environment:

```bash
pnpm ops:create-admin -- --username admin --password 'a-long-random-password'
```

There is no default password, no seeded administrator, and no credentials in the repository.

## Environment variables

All variables are documented in [.env.example](.env.example). Validation happens at startup
with Zod; invalid configuration fails fast without echoing secret values.

| Variable                      | Required         | Notes                                                                                                                                         |
| ----------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | yes (prod)       | `development`, `test`, `production`                                                                                                           |
| `PORT`                        | platform         | Binds `0.0.0.0`; Railway/Render assign it                                                                                                     |
| `PUBLIC_URL`                  | auto or explicit | Used in subscription URLs. Auto-derived from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` when omitted. Set explicitly for custom domains. |
| `DATABASE_URL`                | yes              | PostgreSQL URL; prefer the platform-internal URL                                                                                              |
| `SESSION_SECRET`              | yes              | >= 32 random chars, no known placeholder                                                                                                      |
| `ENCRYPTION_KEY`              | yes              | 32 bytes as 64 hex chars or base64 (Render `generateValue` is supported)                                                                      |
| `SETUP_TOKEN`                 | optional         | Empty disables HTTP setup. >= 16 chars if set.                                                                                                |
| `LOG_LEVEL`                   | optional         | Pino level, default `info`                                                                                                                    |
| `ENABLE_RUNTIME_LISTENERS`    | optional         | Diagnostics only; no listener implementation exists                                                                                           |
| `TRUST_PROXY`                 | optional         | Default true behind platform proxies                                                                                                          |
| `COOKIE_SECURE`               | optional         | `auto` (HTTPS => Secure), `true`, `false`                                                                                                     |
| `RUN_MIGRATIONS_ON_START`     | optional         | Docker/Railway last-resort startup migration                                                                                                  |
| `RUN_SEED_ON_START`           | optional         | Docker/Railway idempotent reference-data seed                                                                                                 |
| `KEEP_ALIVE_ENABLED`          | optional         | Best-effort idle-prevention self health ping; enabled in Docker/Render configs                                                                |
| `KEEP_ALIVE_INTERVAL_MINUTES` | optional         | Ping interval; default `3`, allowed `2..14` minutes                                                                                           |

Never commit real values. Change `ENCRYPTION_KEY` only with a planned credential rotation:
existing sealed credentials become unreadable.

### Idle spin-down and keep-alive

Some free or Serverless hosting plans suspend a web service after a period without traffic.
This repository adds an optional **public self health ping**:

- Every `KEEP_ALIVE_INTERVAL_MINUTES` (default `3`) the Node process requests its own
  `PUBLIC_URL/api/health` through the public edge.
- Only that fixed health path is used. The URL is derived from validated `PUBLIC_URL`; there is
  no user-controlled URL fetch, so this does not add an SSRF surface.
- Three minutes is deliberately below Railway Serverless's ~5-minute outbound-idle threshold
  and Render Free's 15-minute inbound-idle threshold.
- The feature is enabled in [render.yaml](render.yaml) and the [Dockerfile](Dockerfile); it is
  disabled by default in `.env.example` so local development does not generate pointless traffic.

**This is best-effort, not an uptime guarantee.** A sleeping process cannot wake itself, so the
ping only prevents idle sleep while the process is still running. It cannot bypass provider
quotas, maintenance, restarts, or free-database expiry. For genuinely always-on service, use a
paid always-on plan or a VPS, and keep Railway Serverless/App Sleeping disabled. This is exactly
what the current paid Render Blueprint does; the self-ping is defence-in-depth for free or
Serverless configurations. An external uptime monitor can provide an additional independent
wake signal.

Render Free also expires PostgreSQL 30 days after creation; keep-alive does not change that.
See the official [Render Free limitations](https://render.com/docs/free) and
[Railway Serverless behaviour](https://docs.railway.com/deployments/serverless).

## Testing

```bash
pnpm lint          # Prettier check
pnpm typecheck     # strict TypeScript for server + web
pnpm test:unit     # protocol validation, URIs, crypto, state evaluation, redaction, imports
pnpm test:security # auth boundaries, headers, error sanitization, rate limiting (no DB)
pnpm test:integration # requires PostgreSQL + migrations
pnpm build         # strict web typecheck + Vite + server tsc
pnpm ops:validate-manifests
```

Integration tests automatically skip (reported as skipped) when `DATABASE_URL` is absent.
CI provisions PostgreSQL, runs `prisma migrate deploy`, seeds, and executes the full
integration suite. Tests are not reported as passing when skipped.

No verification in this repository includes a live Railway/Render deployment; see
[Deployment verification status](#deployment-verification-status).

## Deploy from GitHub

### Render (Blueprint)

1. Push this repository to GitHub.
2. In Render: **New -> Blueprint**, select the repository and branch.
3. Render reads [render.yaml](render.yaml), creates one web service and one managed
   PostgreSQL database in the same region, and prompts for `SETUP_TOKEN` (`sync: false`).
4. Apply. The build runs `pnpm install --frozen-lockfile`, `prisma generate`, and `pnpm build`.
   The pre-deploy command `pnpm release` runs migrations and idempotent seed data before the
   new release receives traffic.
5. Open the `onrender.com` URL. `PUBLIC_URL` is derived from `RENDER_EXTERNAL_URL`; set it
   explicitly if you attach a custom domain. `RENDER_EXTERNAL_URL` uses HTTPS, so secure
   cookies are enabled.
6. Open the generated URL, complete the one-time setup with `SETUP_TOKEN`, then sign in.

The Blueprint uses paid compute and database plans (`0.5c-512mb` web, `0.5c-1g` database).
Free plans are not used because durable PostgreSQL and predictable shutdown behavior are
required. Adjust plans in the dashboard if needed; schema version 17 is requested.

### Railway

Railway currently supports two paths. Both use one web service + one PostgreSQL service and
one public HTTP domain.

**A. Automatic Dockerfile deployment (recommended for new services)**

1. Push to GitHub and create a Railway project: **New Project -> Deploy from GitHub Repo**.
2. Railway detects the [Dockerfile](Dockerfile) and builds it. The image is unprivileged and
   exposes only the HTTP port.
3. Add **PostgreSQL** to the project (`+ New -> Database -> PostgreSQL`).
4. In the web service variables set:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` (use the internal reference)
   - `SESSION_SECRET` = `openssl rand -base64 48`
   - `ENCRYPTION_KEY` = `openssl rand -hex 32`
   - `SETUP_TOKEN` = `openssl rand -base64 24` (for first-admin setup)
   - `PUBLIC_URL` optional; derived from `RAILWAY_PUBLIC_DOMAIN` when omitted
   - `NODE_ENV=production`, `LOG_LEVEL=info`
5. Generate a public domain (**Settings -> Networking -> Generate Domain**). Keep one replica.
6. Deploy. The Docker entrypoint runs `prisma migrate deploy` and idempotent seed data
   (`RUN_MIGRATIONS_ON_START=1`, `RUN_SEED_ON_START=1` in the image), then starts Node.
7. Set the dashboard health check to `/api/ready` if Railway does not read it automatically.
8. Open the domain, complete the one-time setup with `SETUP_TOKEN`, then sign in.

**B. Railpack / Config-as-Code (existing legacy services)**

[railway.json](railway.json) is retained for existing services that still use Railway
Config-as-Code. It sets the RAILPACK builder, frozen-lockfile build, `pnpm release` pre-deploy
(migrations + seed), `pnpm start`, and a `/api/ready` health check.

> Railway documentation (reviewed 20 October 2026) marks Config-as-Code deprecated: existing
> services keep reading `railway.json` until the **1 December 2026** cutoff, while **new
> services cannot opt in**. For a new service, use the Dockerfile path above and configure
> the start/pre-deploy commands in the dashboard if you build with Railpack instead:
> build `pnpm db:generate && pnpm build`, pre-deploy `pnpm release`, start `pnpm start`,
> health `/api/ready`.

Railway public networking is HTTP(S) through the edge. A manually created TCP Proxy can
expose one extra raw TCP port, but this repository does not create or configure one, and
Railway does not provide UDP or kernel tun/WireGuard support. Those protocol listeners must
run on a VPS/dedicated host.

### Generic Docker

```bash
docker build -t panahgozar .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e SESSION_SECRET='...' \
  -e ENCRYPTION_KEY='...' \
  -e PUBLIC_URL='https://panel.example.com' \
  -e SETUP_TOKEN='...' \
  panahgozar
```

The image runs as the non-root `node` user, migrates and seeds by default, serves only HTTP,
and requires external PostgreSQL. For multi-replica or zero-downtime deployments, disable the
startup hooks (`RUN_MIGRATIONS_ON_START=0`, `RUN_SEED_ON_START=0`) and run `pnpm release` in
a dedicated release phase.

### Database release procedure

```bash
pnpm db:migrate   # prisma migrate deploy: forward-only migrations
pnpm db:seed      # idempotent roles, protocol catalog, safe settings
```

Never use `prisma migrate dev` against production. Never run destructive resets against a
managed database. Migrations are committed SQL files under
[`prisma/migrations`](prisma/migrations); the application does not create schema at runtime.

## API and operations

- OpenAPI JSON: `/api/openapi.json`
- Swagger UI: `/api/docs`
- Liveness: `/api/health` (no database, always fast)
- Readiness: `/api/ready` (database, migrations, reference data; 503 on failure)
- Subscriptions: `GET /api/sub/<token>` (no auth; token is a bearer secret; never log it)
- Admin APIs require session + `x-csrf-token` on mutations. See the OpenAPI document.

Structured Pino logs redact URLs, tokens, secrets, cookies, authorization headers and
credential fields. Request logging replaces the entire URL with a redaction marker, so
subscription bearer tokens cannot leak through access logs.

## Security design

- Argon2id via `@node-rs/argon2` (OWASP baseline: 19 MiB, 2 iterations, parallelism 1).
- Session tokens: 32 random bytes, only SHA-256 hashes in PostgreSQL; HttpOnly, SameSite=Strict,
  Secure under HTTPS. Login rotates and revokes prior sessions. Password/role changes revoke
  sessions.
- CSRF double submit validated against the session, plus same-origin-only CORS behavior.
- Every `/api` route is authenticated by default unless explicitly public. Authorization uses
  role checks at each sensitive route and in the UI.
- Rate limits: global, login (8/5 min), setup, password change, public subscriptions.
- Helmet CSP/HSTS/framing/referrer policy, strict JSON body limit, no stack traces in 5xx
  responses, validation details only for explicit 4xx validation errors.
- AES-256-GCM sealing with random nonce for credentials and WireGuard server keys; private
  material never enters list responses, audit metadata, or logs.
- Imported Xray/sing-box JSON is size/depth bounded and schema-validated; embedded credentials
  are discarded. Imported `.ovpn` profiles reject executable directives.
- No shell execution from the dashboard. No arbitrary command endpoint. No endpoint dumps all
  credentials. No default admin password.
- SQL access is through Prisma; the only raw queries are static health checks.
- SSRF: the application performs no outbound network probes or URL fetches; health verification
  of external protocol servers is intentionally not implemented. `PUBLIC_URL` is display-only.
- Subscriptions are hashed at rest, rotatable, expiring, revocable and `no-store`.

Operational hardening recommendations: use managed PostgreSQL with least-privilege credentials,
restrict database network access, rotate `SESSION_SECRET`/API tokens, remove `SETUP_TOKEN`
after provisioning, enable platform audit logs, and keep the service at one replica while
using in-memory rate limiting.

## Compatibility review

Reviewed on **20 October 2026** against official documentation:

- Railway public networking specs and limits:
  [docs.railway.com/networking/public-networking/specs-and-limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
- Railway TCP Proxy (TCP only, manually configured):
  [docs.railway.com/networking/tcp-proxy](https://docs.railway.com/networking/tcp-proxy)
- Railway Config-as-Code deprecation and IaC replacement:
  [docs.railway.com/config-as-code](https://docs.railway.com/config-as-code),
  [docs.railway.com/infrastructure-as-code](https://docs.railway.com/infrastructure-as-code)
- Render web services / one public HTTP port / PORT binding:
  [render.com/docs/web-services](https://render.com/docs/web-services)
- Render health checks:
  [render.com/docs/health-checks](https://render.com/docs/health-checks)
- Render persistent disks and ephemeral filesystems:
  [render.com/docs/disks](https://render.com/docs/disks)
- Render Free idle spin-down, instance-hour limits and free PostgreSQL expiry:
  [render.com/docs/free](https://render.com/docs/free)
- Railway Serverless / App Sleeping idle detection:
  [docs.railway.com/deployments/serverless](https://docs.railway.com/deployments/serverless)
- Render PostgreSQL connections and connection limits:
  [render.com/docs/postgresql-creating-connecting](https://render.com/docs/postgresql-creating-connecting)

Key findings: both platforms give a single managed HTTP(S) entry point per web service; both
provide ephemeral container filesystems; neither exposes arbitrary UDP or kernel tun/WireGuard
interfaces to ordinary web containers. Railway can manually proxy one raw TCP port but not UDP;
Render's public web-service ingress is HTTP(S). Therefore **no protocol listener is run in this
deployment**. Full matrix: [docs/compatibility.md](docs/compatibility.md).

## Deployment verification status

| Check                                                                                           | Status                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Prettier format check                                                                           | Verified locally                                                                                               |
| TypeScript server/web typecheck                                                                 | Verified locally                                                                                               |
| Unit tests                                                                                      | Verified locally: 51 passed                                                                                    |
| Security tests                                                                                  | Verified locally: 8 passed (in-memory Prisma stub)                                                             |
| Integration tests with PostgreSQL 18                                                            | Verified locally: 14 passed                                                                                    |
| Production build (single deployable)                                                            | Verified locally                                                                                               |
| SPA + API served from one process                                                               | Verified locally in production mode (HTML, immutable assets, health, readiness, login, OpenAPI, Swagger UI)    |
| Browser UI smoke (EN/LTR, FA/RTL, dark/light, mobile, client/config/assignment/QR/export flows) | Verified manually with headless Chrome; harness is outside the committed test suite                            |
| Migrations + seed against PostgreSQL                                                            | Verified locally; `prisma migrate diff` reports no schema drift                                                |
| Production dependency audit                                                                     | Verified locally: no known production vulnerabilities (`pnpm audit --prod --audit-level=high`)                 |
| Keep-alive scheduler                                                                            | Verified in production mode: scheduled `PanahGozar-KeepAlive/1.0` request to `/api/health` returned 200        |
| Railway and Render manifests                                                                    | Validated locally against the platforms' official JSON schemas (20 October 2026)                               |
| Docker image build/runtime                                                                      | **Not verified** in this environment (Docker unavailable); Dockerfile/entrypoint reviewed and manifest-checked |
| Railway deployment                                                                              | **Not performed** in this environment                                                                          |
| Render Blueprint deployment                                                                     | **Not performed** in this environment                                                                          |
| Live protocol listeners                                                                         | **Not supported** in this deployment model                                                                     |

Do not treat unverified rows as successful platform deployment results.

## Documentation

- [Deployment guide](docs/deployment.md) - exact Railway/Render/Docker procedures and release flow
- [Compatibility matrix](docs/compatibility.md) - per-protocol runtime, transport, privilege and verification facts
- [Troubleshooting](docs/troubleshooting.md) - startup, database, proxy/cookie, subscription and deployment issues
- [Security model](docs/security.md) - controls, trust boundaries and operational responsibilities

## Repository layout

```text
prisma/                 schema, migrations, idempotent seed
src/server/             Fastify app, auth, services, routes, capabilities
src/server/protocols/   adapter contract, catalog, Xray/sing-box importers
src/shared/             shared DTO/type contracts
src/web/                React SPA (pages, components, i18n, API client)
tests/                  unit, security, PostgreSQL integration tests
scripts/                manifest validation, admin CLI, clean
docs/                   deployment, compatibility, security, troubleshooting
Dockerfile              non-root, HTTP-only production image
railway.json            legacy Railway Config-as-Code (documented deprecation)
render.yaml             Render Blueprint: one web service + managed PostgreSQL
.github/workflows/ci.yml CI gates
```

## License

MIT. See [LICENSE](LICENSE).
