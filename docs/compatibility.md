# Platform and protocol compatibility review

Review date: **20 October 2026**. Scope: the single-web-service Railway/Render deployment
implemented by this repository.

Sources (official):

- Railway public networking specs and limits:
  https://docs.railway.com/networking/public-networking/specs-and-limits
- Railway TCP Proxy:
  https://docs.railway.com/networking/tcp-proxy
- Railway TCP proxy CLI:
  https://docs.railway.com/cli/tcp-proxy
- Railway Config-as-Code (deprecated):
  https://docs.railway.com/config-as-code
- Railway Infrastructure as Code:
  https://docs.railway.com/infrastructure-as-code
- Railway PostgreSQL:
  https://docs.railway.com/databases/build-a-database-service
- Render web services:
  https://render.com/docs/web-services
- Render health checks:
  https://render.com/docs/health-checks
- Render persistent disks:
  https://render.com/docs/disks
- Render free instance idle spin-down, instance-hour limits and database expiry:
  https://render.com/docs/free
- Railway Serverless / App Sleeping idle detection:
  https://docs.railway.com/deployments/serverless
- Render PostgreSQL connections:
  https://render.com/docs/postgresql-creating-connecting
- Render environment variables:
  https://render.com/docs/configure-environment-variables
- Render Blueprint spec:
  https://render.com/docs/blueprint-spec

## Platform findings

| Capability            | Railway                                                                                                         | Render                                                                                                     | Consequence for PanahGozar                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Public HTTP(S) entry  | Yes, one HTTP port per service; TLS at edge                                                                     | Yes, one HTTP port; bind `0.0.0.0` to `PORT`                                                               | Frontend + API share one Fastify origin                                                                                     |
| Arbitrary TCP ingress | Optional manually created TCP Proxy to one internal port                                                        | No public raw TCP for web services; only the HTTP port                                                     | Not enabled; protocol listeners not started                                                                                 |
| Arbitrary UDP ingress | Not provided by public networking                                                                               | Not provided for web services                                                                              | No UDP protocols (WireGuard/OpenVPN UDP, SOCKS UDP, SS UDP)                                                                 |
| Health checks         | HTTP healthcheck path                                                                                           | HTTP healthcheck path or TCP default                                                                       | `/api/health` liveness, `/api/ready` readiness                                                                              |
| Graceful shutdown     | Deployment overlap/draining settings; platform sends termination                                                | `maxShutdownDelaySeconds`, 30 s default/max 300                                                            | App handles SIGTERM/SIGINT, bounded 25 s                                                                                    |
| Persistent filesystem | Ephemeral unless a volume is attached                                                                           | Ephemeral unless a persistent disk is attached; disks require paid plans and disable zero-downtime deploys | No state is stored on disk                                                                                                  |
| Long-running process  | One container process per deployment                                                                            | One web process; no background worker in this service                                                      | No protocol daemons, no background tunnel process                                                                           |
| Managed PostgreSQL    | PostgreSQL plugin, internal URL                                                                                 | Managed Postgres, internal URL, private-network-only allow list possible                                   | All persistent state in PostgreSQL                                                                                          |
| Secrets               | Environment variables                                                                                           | Environment variables; `sync: false` prompts / `generateValue`                                             | No secrets in repo; startup validation                                                                                      |
| Custom domain         | Supported; TCP proxy domains are separate                                                                       | Supported                                                                                                  | Set `PUBLIC_URL` explicitly when using a custom domain                                                                      |
| Config as code        | `railway.json` deprecated for new services; existing legacy until **2026-12-01**; IaC via `.railway/railway.ts` | `render.yaml` Blueprint supported                                                                          | `railway.json` retained for legacy; Docker/Railway dashboard path documented; Render Blueprint is active                    |
| Idle lifecycle        | Serverless/App Sleeping is opt-in; when enabled it sleeps after ~5–10 min without outbound traffic              | Free web services spin down after 15 min without inbound traffic; paid instances stay available            | Optional 3-minute self-health ping is enabled in the provided configs as best-effort anti-sleep; it cannot guarantee uptime |

Both platforms expose a **single public HTTP(S) endpoint** for a web service. A port being
listened on inside the container does not automatically make it publicly routable, and neither
platform provides kernel-level VPN interfaces to ordinary containers.

## Protocol matrix

"Config in panel" means schema validation, versioning and export. "Runtime here" means a
listener started by this application. **No protocol has runtime here.**

| Protocol         | Config in panel | Client artifact               | Server artifact                     | Required ingress / transport      | Runtime privileges                                                        | Persistent state                                                   | Live health verification here |
| ---------------- | --------------- | ----------------------------- | ----------------------------------- | --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| VLESS            | Yes             | `vless://` URI, QR            | Xray inbound JSON                   | TCP; optional TLS/WS/gRPC         | No root required for high ports; Xray binary and external server required | External server config/certs; panel stores metadata only           | Not possible here             |
| VMess            | Yes             | `vmess://` URI, QR            | Xray inbound JSON                   | TCP; optional TLS/WS/gRPC         | Xray binary required; no root for high ports                              | External server                                                    | Not possible here             |
| Trojan           | Yes             | `trojan://` URI, QR           | Xray inbound JSON                   | TCP + TLS, usually 443            | Xray/implementation + certificate private key                             | Certificates on external server; imported profile secrets sealed   | Not possible here             |
| Shadowsocks      | Yes             | SIP002 `ss://`, QR            | Xray multi-user inbound             | TCP; optional UDP (external only) | Xray or shadowsocks server; no root for high ports                        | External server                                                    | Not possible here             |
| SOCKS5           | Yes             | `socks://`, sing-box          | Xray inbound with accounts          | TCP + optional UDP associate      | Forward proxy process; raw TCP ingress needed                             | External server                                                    | Not possible here             |
| HTTP proxy       | Yes             | `http://` URI                 | Xray inbound with accounts          | TCP                               | Forward proxy process; raw TCP ingress needed                             | External server                                                    | Not possible here             |
| HTTPS proxy      | Yes             | `https://` URI                | Xray inbound with TLS cert paths    | TCP + TLS                         | Certificate private key on external server                                | Certificates external                                              | Not possible here             |
| Telegram MTProto | Yes             | `tg://proxy` / `t.me/proxy`   | Erlang config template              | TCP, typically 443                | MTProto proxy binary/service                                              | Secret sealed; external server holds active secret                 | Not possible here             |
| WireGuard        | Yes             | `.conf`                       | `wg-quick` server config with peers | **UDP**, kernel/userspace WG      | Root or approved userspace implementation; UDP ingress                    | Server key sealed; peers/secrets in Postgres                       | Not possible here             |
| OpenVPN          | Yes             | `.ovpn` with inline user/pass | validated profile template          | UDP and/or TCP; tun/tap           | Root for tun, certificates, server binary                                 | Imported profile stored in config (admin-only); credentials sealed | Not possible here             |

### Xray and sing-box

They are **implementation/config ecosystems, not network protocols**. This panel:

- imports and validates a strict subset of Xray server JSON,
- exports a merged Xray server JSON for active Xray-compatible inbounds,
- imports documented sing-box outbound objects,
- exports sing-box client JSON through compatible subscriptions,
- never runs either binary.

### Why no in-process listener

Even where a pure Node listener is technically possible (for example SOCKS5), the public
ingress does not route arbitrary TCP/UDP to the web container. Starting a listener would
produce a false sense of exposure and cannot be health-verified from outside. The panel
therefore stays a configuration manager and marks listener state as `runtime_unavailable`.

## Requirements to enable real runtime operation

Minimum change: add a separate externally hosted server (VPS, dedicated node, or a compatible
platform with TCP/UDP ingress and required kernel features) and apply the panel-generated
artifacts there.

For WireGuard/OpenVPN specifically:

- public IP with UDP and/or TCP ingress,
- privileged networking or host networking,
- `tun` device or WireGuard kernel/userspace support,
- server binaries and certificate material,
- an operational process supervisor and health monitoring.

The panel does **not** include a remote agent, automatic deployment of configuration to that
server, or a network probe. Those would be additional infrastructure and security surface.
You must apply exported files deliberately and verify reachability independently.

## Compatibility checks encoded in diagnostics

The `/api/diagnostics` endpoint checks:

- Node.js version, platform, architecture, process user,
- writable working directory / home (probe only; no privileged operations),
- binary presence in `PATH` for Xray, Shadowsocks, MTProto, WireGuard, OpenVPN,
- root semantics where applicable,
- UDP/kernel availability (reported unavailable for the web container),
- database reachability and applied migrations,
- reference data presence.

Unavailable checks remain unavailable and carry a reason; they are never converted to
"running" or "verified".

## Status semantics

- `not_configured`: no active configuration.
- `configured`: a valid active configuration exists.
- `runtime_unavailable`: config exists, but this process cannot host that listener.
- `awaiting_verification`: an in-process-capable runtime would need a recorded live check.
- `running_verified`: only with a real, recent, recorded passing health check.
- `degraded`, `stopped`, `error`: evidence-backed negative/partial states.
- There is no generic "online" flag.

In the current architecture every protocol is `not_configured` or
`runtime_unavailable`; `running_verified` is intentionally unreachable because no runtime
implementation exists here and no outbound health probe is performed.

## Deployment verification status

The project has **not** been deployed to Railway or Render within this workspace. Deployment
manifests were validated structurally and against current documentation, but platform build
results are unverified. Do not claim a successful cloud deployment until the health and
readiness endpoints pass on the platform and the first-admin flow works there.
