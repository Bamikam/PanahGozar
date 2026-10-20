# Troubleshooting

## Startup exits immediately

The app validates environment variables and fails fast with a variable name and requirement
(never the value). Common causes:

- `SESSION_SECRET` missing, too short, or still a placeholder.
- `ENCRYPTION_KEY` not 32 bytes encoded as 64 hex characters or base64.
- `DATABASE_URL` not a `postgres://` / `postgresql://` URL.
- `PUBLIC_URL` missing in production and no platform URL variable available.
- `SETUP_TOKEN` shorter than 16 characters.

Generate values:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 32      # ENCRYPTION_KEY
```

Render generates a base64 256-bit `ENCRYPTION_KEY`, which the app accepts. Railway should use
64 hex characters or any 32-byte base64 value.

## `PUBLIC_URL` / subscription links use the wrong host

`PUBLIC_URL` controls subscription URLs. In production it is auto-derived from
`RENDER_EXTERNAL_URL` (Render) or `RAILWAY_PUBLIC_DOMAIN` (Railway) only when not set. If you
attach a custom domain, set `PUBLIC_URL=https://panel.example.com` (no trailing slash) and
redeploy. Existing subscriptions embed the previous origin only because the URL was issued by
the platform; rotating a token returns a URL based on the current `PUBLIC_URL`.

## Readiness returns 503

`/api/ready` checks:

- PostgreSQL connectivity,
- `_prisma_migrations` with at least one finished migration,
- at least one seeded role.

Fix:

```bash
pnpm db:migrate
pnpm db:seed
```

Verify from the platform or shell. During a fresh Render pre-deploy or Docker startup, allow a
few seconds for the release commands.

## Database TLS / connection errors

- Use the provider's internal URL when the service and database are in the same region.
- External connections may require `?sslmode=require`; never disable TLS on public links.
- Render warns that external TLS connections need SNI; always use the full hostname, not an IP.
- Check database network allow lists; Render's Blueprint sets `ipAllowList: []` so only Render
  private networking can connect. Use the internal URL.
- Connection limits: avoid many replicas with large pools. This app uses one Prisma client and
  is intended to run as one replica.

## Setup page does not appear

- Setup appears only when **no admin user exists**.
- If `SETUP_TOKEN` is empty, HTTP setup is intentionally disabled. Use:

```bash
pnpm ops:create-admin -- --username admin --password 'a-long-random-password'
```

on a trusted shell (Render Shell / Railway SSH / local Docker exec).

- Once one admin exists, `/api/setup` returns 404 permanently by design.

## 401 after login / cookie not set

- Access the app over HTTPS in production.
- `COOKIE_SECURE=auto` sets Secure cookies only when `PUBLIC_URL` starts with `https://`.
  If you terminate TLS at a proxy but set `PUBLIC_URL=http://...`, the cookie may not be sent.
- Do not access the app via an IP, a different hostname from `PUBLIC_URL`, or mixed HTTP/HTTPS.
- Confirm the platform terminates TLS and forwards `X-Forwarded-Proto`.
- Check the browser blocked third-party cookies (this is not a third-party context) or a custom
  proxy rewrites Set-Cookie headers.

## 403 CSRF on admin actions

The browser must send `x-csrf-token`. The SPA reads the JS-readable `pg_csrf` cookie and adds
the header. Common causes:

- A proxy strips cookies or headers.
- The request is made by a script outside the SPA without the header.
- Mixed origins: frontend and API must be same-origin.
- Cached/stale page after session rotation: reload and sign in again.

## Rate limited (429)

Limits are per process and per client IP: global 300/min, login 8/5 min, setup 5/15 min.
Wait for the window or restart the single instance only if appropriate. Behind a proxy, keep
`TRUST_PROXY=true` so the real client IP is used. A misconfigured trusted chain can group all
clients under the proxy IP.

## Subscription returns 404

The API deliberately returns 404 for invalid, revoked, expired, and disabled-client tokens.
Also check:

- The token was copied completely; no trailing punctuation.
- The subscription itself has not expired.
- The client is not disabled, deleted, or expired.
- The signing server was restarted with the same database (tokens are hashes in PostgreSQL).

A rotated token immediately invalidates the old URL; the new URL is displayed once. If it was
lost, rotate again.

## Subscription returns an empty list or empty sing-box config

This means no **active** assigned configuration advertises compatibility with the selected
format. For example:

- `xray_uri` carries URI artifacts only (VLESS/VMess/Trojan/Shadowsocks), not `.ovpn`/`.conf`.
- `raw_uri` carries URI-capable protocols, including SOCKS/HTTP/MTProto.
- `singbox_json` includes only adapters with a documented sing-box outbound (currently the
  Xray-compatible protocols plus SOCKS/HTTP).
- Inactive configurations and revoked/expired credentials are excluded.

This is expected. It is not evidence of a reachable server.

## Protocol status says `runtime_unavailable`

This is the correct and expected state in the single-service Railway/Render deployment. The
panel generates configuration; it does not host listeners. A saved config never marks a
service as running. See [compatibility.md](compatibility.md).

## QR code is blank / unavailable

- QR requires a URI artifact. WireGuard `.conf` and OpenVPN `.ovpn` are files, not QR-able URIs.
- QR images are fetched with an authenticated request and rendered from a `blob:` URL. Ensure
  CSP permits `img-src 'self' data: blob:` (the app sets this). A reverse proxy must not strip
  CSP or block blob URLs in the browser.
- If the client/config is disabled/inactive, the artifact endpoint returns an error instead.

## Exports fail or contain placeholders

- A client must be active, not expired, not disabled, and have an active credential.
- The configuration must be active.
- WireGuard server export requires a provisioned server key; assigning at least one client
  provisions it. Export server configuration from the configuration row.
- TLS Xray server exports may contain certificate placeholders if no certificate paths were
  entered; add paths in the configuration form (they are external server paths, never read by
  the panel).
- MTProto server template contains a placeholder secret by design; per-client `tg://` links are
  the actual credential-bearing artifacts.
- OpenVPN config downloads are validated profile templates; per-client artifacts are generated
  with inline credentials through the client export endpoint.

## Prisma Client / query engine errors

- Run `pnpm db:generate` after installing or changing the schema. The Docker build does this.
- Alpine images need `openssl` and `libc6-compat` (the provided Dockerfile installs both).
- If native binary download is blocked during install, configure your package registry/proxy
  and rerun `pnpm install --frozen-lockfile`.
- Do not copy a `node_modules` tree between different operating systems/architectures.

## Docker build/start problems

- The Dockerfile requires network access for pnpm and Corepack during build.
- The runtime image runs as `node`; it needs no writable application directory, but be careful
  not to mount volumes over `/app` or strip execute permissions from the entrypoint.
- If the container restarts before readiness, inspect logs for migration failures or missing
  `DATABASE_URL`/secrets. Startup fails closed.
- Set `RUN_MIGRATIONS_ON_START=0`/`RUN_SEED_ON_START=0` only if you run `pnpm release` in a
  separate release phase. Keep one replica if startup hooks remain enabled.
- The container intentionally cannot host VPN/proxy listeners and exposes no UDP.

## Railway-specific

- Config-as-Code is deprecated for new services. Use the Dockerfile path or configure build,
  pre-deploy (`pnpm release`), start (`pnpm start`) and health (`/api/ready`) in the dashboard.
- Use `DATABASE_URL=${{Postgres.DATABASE_URL}}` or the exact internal variable reference shown
  by your database service.
- Generate a public domain; without it `RAILWAY_PUBLIC_DOMAIN` is unavailable.
- Do not enable a TCP Proxy for this web app; no protocol listener runs here. UDP proxy is not
  available.
- Keep one replica.

## Render-specific

- Apply the Blueprint in the same region for web and database to use private networking.
- `SETUP_TOKEN` uses `sync: false`: Render prompts only during initial Blueprint creation. If
  it was omitted, set it manually or use the Render Shell CLI path.
- Free PostgreSQL expires; data loss is expected if it is allowed to expire.
- Do not attach a persistent disk for application state; state is in PostgreSQL. Disks disable
  zero-downtime deploys.
- The health check `/api/ready` must return 2xx within five seconds. If the database is slow to
  accept connections during a release, check Render's pre-deploy logs.

## Static SPA returns 503 / frontend missing

`pnpm start` expects `dist/web/index.html`. Run `pnpm build` first. In development, Vite runs
separately on 5173 and proxies `/api` to 3000; use `pnpm dev`, not `pnpm start`, for that setup.

## Logs appear to hide every URL

This is intentional. Access logs redact the full request URL to prevent subscription bearer
tokens and other URL-embedded secrets from leaking. Use structured audit events and route logs
for operations. Do not change this redaction without a reviewed sanitizer.

## Still stuck

Collect: platform deploy logs, sanitized startup logs, `/api/health` and `/api/ready` outputs,
database provider status, and the exact failing request (never include passwords, tokens,
`.env` values, private keys, or subscription URLs). Do not paste sealed credentials or keys into
issues.
