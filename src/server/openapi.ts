/**
 * OpenAPI (v3.1) document for the PanahGozar admin API. Served at
 * /api/openapi.json and rendered at /api/docs via @fastify/swagger-ui.
 * Security scheme: session cookie (HttpOnly) + CSRF header.
 */
export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "PanahGozar API",
    version: "0.1.0",
    description: [
      "Multi-protocol VPN & proxy management panel - admin REST API.",
      "Protocol runtimes are externally hosted in the reference deployment;",
      "this API manages configuration, credentials, clients, subscriptions, and",
      "reports honest runtime capability status. A configuration or subscription",
      "response is never evidence that an external listener is reachable.",
    ].join("\n"),
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "system" },
    { name: "setup" },
    { name: "auth" },
    { name: "clients" },
    { name: "configurations" },
    { name: "subscriptions" },
    { name: "protocols" },
    { name: "settings" },
    { name: "audit" },
  ],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "pg_session",
      },
      csrfHeader: {
        type: "apiKey",
        in: "header",
        name: "x-csrf-token",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          code: { type: "string" },
          details: {},
        },
        required: ["error"],
      },
      RuntimeState: {
        type: "string",
        enum: [
          "not_configured",
          "configured",
          "runtime_unavailable",
          "awaiting_verification",
          "starting",
          "running_verified",
          "degraded",
          "stopped",
          "error",
        ],
      },
    },
  },
  security: [{ sessionCookie: [], csrfHeader: [] }],
  paths: {
    "/api/health": {
      get: {
        tags: ["system"],
        summary: "Liveness probe (no deps)",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/ready": {
      get: {
        tags: ["system"],
        summary: "Readiness probe (db + migrations)",
        responses: { "200": { description: "ready" }, "503": { description: "degraded" } },
      },
    },
    "/api/setup/status": {
      get: {
        tags: ["setup"],
        summary: "Whether first-admin setup is possible",
        responses: { "200": { description: "status" } },
      },
    },
    "/api/setup": {
      post: {
        tags: ["setup"],
        summary: "One-time first-admin creation (SETUP_TOKEN protected; disabled after init)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: {
                  username: { type: "string", minLength: 3, maxLength: 64 },
                  password: { type: "string", minLength: 12, maxLength: 128 },
                },
              },
            },
          },
        },
        parameters: [
          { name: "x-setup-token", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "201": { description: "created" },
          "403": { description: "invalid setup token" },
          "404": { description: "setup disabled (already initialized)" },
        },
      },
    },
    "/api/auth/login": {
      post: {
        tags: ["auth"],
        summary: "Log in (rate limited, session rotation on success)",
        responses: {
          "200": { description: "session established" },
          "401": { description: "invalid credentials" },
        },
      },
    },
    "/api/auth/logout": {
      post: {
        tags: ["auth"],
        summary: "Revoke current session",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/auth/me": {
      get: {
        tags: ["auth"],
        summary: "Current session identity + CSRF token",
        responses: { "200": { description: "user" }, "401": { description: "unauthenticated" } },
      },
    },
    "/api/auth/password": {
      post: {
        tags: ["auth"],
        summary: "Change own password (rotates sessions)",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/auth/users": {
      get: {
        tags: ["auth"],
        summary: "List admin users (admin only)",
        responses: { "200": { description: "users" } },
      },
      post: {
        tags: ["auth"],
        summary: "Create admin user (admin only)",
        responses: { "201": { description: "created" } },
      },
    },
    "/api/clients": {
      get: {
        tags: ["clients"],
        summary: "Paginated client list",
        responses: { "200": { description: "clients" } },
      },
      post: {
        tags: ["clients"],
        summary: "Create client",
        responses: { "201": { description: "created" } },
      },
    },
    "/api/clients/{id}": {
      get: {
        tags: ["clients"],
        summary: "Get one client",
        responses: { "200": { description: "client" }, "404": { description: "not found" } },
      },
      patch: {
        tags: ["clients"],
        summary: "Update client",
        responses: { "200": { description: "client" } },
      },
      delete: {
        tags: ["clients"],
        summary: "Soft-delete client (admin only)",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/clients/{id}/assign": {
      post: {
        tags: ["clients"],
        summary: "Assign configuration + sealed credential",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/clients/{id}/rotate-credential": {
      post: {
        tags: ["clients"],
        summary: "Rotate credential for assignment",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/clients/{id}/export/{configurationId}": {
      get: {
        tags: ["clients"],
        summary: "Export client artifact (URI/.conf/.ovpn)",
        responses: { "200": { description: "artifact" } },
      },
    },
    "/api/auth/users/{id}": {
      patch: {
        tags: ["auth"],
        summary: "Update role/active state (admin only; rotates sessions; protects last admin)",
        responses: {
          "200": { description: "updated" },
          "400": { description: "invalid" },
          "409": { description: "last admin" },
        },
      },
    },
    "/api/clients/{id}/uri/{configurationId}": {
      get: {
        tags: ["clients"],
        summary: "Client connection data (operator or admin; no-store)",
        responses: {
          "200": { description: "uri and content" },
          "400": { description: "not exportable" },
        },
      },
    },
    "/api/clients/{id}/qr/{configurationId}": {
      get: {
        tags: ["clients"],
        summary: "PNG QR code for URI-based client artifact",
        responses: { "200": { description: "image/png" }, "400": { description: "not URI-based" } },
      },
    },
    "/api/configurations": {
      get: {
        tags: ["configurations"],
        summary: "List configurations",
        responses: { "200": { description: "configurations" } },
      },
      post: {
        tags: ["configurations"],
        summary: "Create + validate configuration",
        responses: {
          "201": { description: "created" },
          "400": { description: "validation failed" },
        },
      },
    },
    "/api/configurations/validate": {
      post: {
        tags: ["configurations"],
        summary: "Validate a candidate configuration without storing it",
        responses: { "200": { description: "validation result with valid/issues" } },
      },
    },
    "/api/configurations/import/xray": {
      post: {
        tags: ["configurations"],
        summary: "Import untrusted Xray JSON (strict validation)",
        responses: { "201": { description: "imported" }, "400": { description: "rejected" } },
      },
    },
    "/api/configurations/import/singbox": {
      post: {
        tags: ["configurations"],
        summary: "Import untrusted sing-box JSON (strict)",
        responses: { "201": { description: "imported" }, "400": { description: "rejected" } },
      },
    },
    "/api/configurations/{id}/versions": {
      get: {
        tags: ["configurations"],
        summary: "Version history",
        responses: { "200": { description: "versions" } },
      },
    },
    "/api/configurations/{id}/rollback": {
      post: {
        tags: ["configurations"],
        summary: "Rollback to version",
        responses: { "200": { description: "new state" } },
      },
    },
    "/api/export/xray-skeleton": {
      get: {
        tags: ["configurations"],
        summary: "Full Xray server skeleton from active configs",
        responses: { "200": { description: "json" } },
      },
    },
    "/api/subscriptions": {
      get: {
        tags: ["subscriptions"],
        summary: "List subscriptions (token never exposed in list)",
        responses: { "200": { description: "items" } },
      },
      post: {
        tags: ["subscriptions"],
        summary: "Create subscription (URL returned once)",
        responses: { "201": { description: "created with one-time URL" } },
      },
    },
    "/api/subscriptions/{id}/rotate": {
      post: {
        tags: ["subscriptions"],
        summary: "Rotate token",
        responses: { "200": { description: "new URL" } },
      },
    },
    "/api/subscriptions/{id}/revoke": {
      post: {
        tags: ["subscriptions"],
        summary: "Revoke",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/sub/{token}": {
      get: {
        tags: ["subscriptions"],
        summary: "Public tokenized subscription fetch",
        responses: {
          "200": { description: "payload" },
          "404": { description: "invalid/revoked/expired" },
        },
      },
    },
    "/api/protocols/{id}/capabilities": {
      get: {
        tags: ["protocols"],
        summary: "Per-adapter capability detection and runtime status",
        responses: {
          "200": { description: "capabilities" },
          "404": { description: "unknown protocol" },
        },
      },
    },
    "/api/protocols/status": {
      get: {
        tags: ["protocols"],
        summary: "Honest per-protocol runtime states",
        responses: { "200": { description: "statuses" } },
      },
    },
    "/api/diagnostics": {
      get: {
        tags: ["protocols"],
        summary: "Machine-readable capability report",
        responses: { "200": { description: "diagnostics" } },
      },
    },
    "/api/dashboard": {
      get: {
        tags: ["settings"],
        summary: "Dashboard stats (no fabricated usage data)",
        responses: { "200": { description: "stats" } },
      },
    },
    "/api/settings": {
      get: {
        tags: ["settings"],
        summary: "Application settings",
        responses: { "200": { description: "settings" } },
      },
      patch: {
        tags: ["settings"],
        summary: "Update settings (admin only)",
        responses: { "200": { description: "ok" } },
      },
    },
    "/api/audit": {
      get: {
        tags: ["audit"],
        summary: "Audit events (admin only)",
        responses: { "200": { description: "events" } },
      },
    },
  },
} as const;
