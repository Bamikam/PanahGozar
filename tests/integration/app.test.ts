/**
 * Integration tests - full HTTP behavior against PostgreSQL.
 * These tests are skipped (and reported as skipped, never passed) when a
 * database is not configured. CI provisions PostgreSQL and runs migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { PrismaClient } from "@prisma/client";

const hasTestDb = Boolean(
  process.env.DATABASE_URL && (process.env.NODE_ENV === "test" || process.env.VITEST)
);

const SETUP_TOKEN = "integration-setup-token-32-chars-min";
const ADMIN_PASSWORD = "IntegrationAdmin123!";
const OPERATOR_PASSWORD = "IntegrationOperator123!";
const VIEWER_PASSWORD = "IntegrationViewer123!";

describe.skipIf(!hasTestDb)("integration: app + postgres", () => {
  let app: FastifyInstance;
  let db: PrismaClient;
  const adminJar: Record<string, string> = {};
  const operatorJar: Record<string, string> = {};
  const viewerJar: Record<string, string> = {};
  let clientId = "";
  let configId = "";
  let firstSubscriptionToken = "";
  let singboxSubscriptionToken = "";

  function setCookies(response: LightMyRequestResponse, jar: Record<string, string>) {
    const raw = response.headers["set-cookie"];
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    for (const cookie of values) {
      const pair = cookie.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      if (index < 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) jar[name] = value;
      else delete jar[name];
    }
  }

  function cookieHeader(jar: Record<string, string>): string {
    return Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  function authHeaders(jar: Record<string, string>): Record<string, string> {
    return {
      cookie: cookieHeader(jar),
      ...(jar.pg_csrf ? { "x-csrf-token": jar.pg_csrf } : {}),
    };
  }

  async function inject(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    options: {
      jar?: Record<string, string>;
      payload?: unknown;
      csrf?: boolean;
      headers?: Record<string, string>;
    } = {}
  ): Promise<LightMyRequestResponse> {
    const auth = options.jar ? authHeaders(options.jar) : {};
    if (options.csrf === false) delete auth["x-csrf-token"];
    return app.inject({
      method,
      url,
      payload: options.payload as never,
      headers: { ...auth, ...(options.headers ?? {}) },
    });
  }

  async function login(
    username: string,
    password: string,
    jar: Record<string, string>
  ): Promise<LightMyRequestResponse> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    setCookies(response, jar);
    return response;
  }

  beforeAll(async () => {
    process.env.SETUP_TOKEN = SETUP_TOKEN;
    process.env.PUBLIC_URL = "http://localhost:3000";
    process.env.SESSION_SECRET =
      process.env.SESSION_SECRET ?? "integration-session-secret-not-for-production-123456";
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY ??
      "0000000000000000000000000000000000000000000000000000000000000000";
    process.env.LOG_LEVEL = "error";
    process.env.NODE_ENV = "test";

    const { buildApp } = await import("../../src/server/app.js");
    const { loadConfig } = await import("../../src/server/env.js");
    const built = await buildApp({ cfg: loadConfig() });
    app = built.app;
    db = built.db;

    // Remove prior test data in FK-safe order; reference roles/protocols stay.
    await db.auditEvent.deleteMany();
    await db.session.deleteMany();
    await db.configurationVersion.deleteMany();
    await db.credentialReference.deleteMany();
    await db.subscription.deleteMany();
    await db.protocolConfiguration.deleteMany();
    await db.client.deleteMany();
    await db.runtimeHealthCheck.deleteMany();
    await db.runtimeCapability.deleteMany();
    await db.adminUser.deleteMany();

    for (const role of [
      { name: "admin" as const, description: "Full administrative control" },
      { name: "operator" as const, description: "Manage clients and configurations" },
      { name: "viewer" as const, description: "Read-only access" },
    ]) {
      await db.role.upsert({ where: { name: role.name }, update: {}, create: role });
    }
    await db.applicationSetting.upsert({
      where: { key: "subscription.maxPerClient" },
      update: { value: 10 },
      create: { key: "subscription.maxPerClient", value: 10 },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it("serves liveness, readiness, and security headers", async () => {
    const health = await inject("GET", "/api/health");
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("DENY");

    const ready = await inject("GET", "/api/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database.ok).toBe(true);
    expect(ready.json().checks.migrations.ok).toBe(true);
  });

  it("rejects unauthenticated admin access", async () => {
    const response = await inject("GET", "/api/clients");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("performs one-time setup and hard-disables it afterward", async () => {
    const before = await inject("GET", "/api/setup/status");
    expect(before.statusCode).toBe(200);
    expect(before.json().needsSetup).toBe(true);
    expect(before.json().setupEnabled).toBe(true);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "x-setup-token": "wrong-token-wrong-token" },
      payload: { username: "admin_it", password: ADMIN_PASSWORD },
    });
    expect(rejected.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "x-setup-token": SETUP_TOKEN },
      payload: { username: "admin_it", password: ADMIN_PASSWORD },
    });
    expect(created.statusCode).toBe(201);

    const after = await inject("GET", "/api/setup/status");
    expect(after.json()).toMatchObject({ needsSetup: false, initialized: true });

    const disabled = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "x-setup-token": SETUP_TOKEN },
      payload: { username: "admin_second", password: ADMIN_PASSWORD },
    });
    expect(disabled.statusCode).toBe(404);
  });

  it("authenticates with secure cookies and enforces CSRF", async () => {
    const wrong = await login("admin_it", "NotThePassword123", adminJar);
    expect(wrong.statusCode).toBe(401);

    const response = await login("admin_it", ADMIN_PASSWORD, adminJar);
    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe("admin_it");
    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((cookie) => String(cookie).startsWith("pg_session="));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Strict");
    const csrfCookie = cookies.find((cookie) => String(cookie).startsWith("pg_csrf="));
    expect(csrfCookie).not.toContain("HttpOnly");

    const me = await inject("GET", "/api/auth/me", { jar: adminJar });
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).toBe(adminJar.pg_csrf);

    const noCsrf = await inject("POST", "/api/clients", {
      jar: adminJar,
      csrf: false,
      payload: { label: "No CSRF" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe("CSRF");
  });

  it("creates role-scoped users and enforces authorization", async () => {
    for (const account of [
      { username: "operator_it", password: OPERATOR_PASSWORD, role: "operator" },
      { username: "viewer_it", password: VIEWER_PASSWORD, role: "viewer" },
    ]) {
      const response = await inject("POST", "/api/auth/users", {
        jar: adminJar,
        payload: account,
      });
      expect(response.statusCode).toBe(201);
    }
    expect((await login("operator_it", OPERATOR_PASSWORD, operatorJar)).statusCode).toBe(200);
    expect((await login("viewer_it", VIEWER_PASSWORD, viewerJar)).statusCode).toBe(200);

    const viewerCreate = await inject("POST", "/api/clients", {
      jar: viewerJar,
      payload: { label: "Viewer cannot create" },
    });
    expect(viewerCreate.statusCode).toBe(403);

    const viewerRead = await inject("GET", "/api/clients", { jar: viewerJar });
    expect(viewerRead.statusCode).toBe(200);

    const operatorAudit = await inject("GET", "/api/audit", { jar: operatorJar });
    expect(operatorAudit.statusCode).toBe(403);

    const operatorCreate = await inject("POST", "/api/clients", {
      jar: operatorJar,
      payload: { label: "Operator client" },
    });
    expect(operatorCreate.statusCode).toBe(201);

    const users = await inject("GET", "/api/auth/users", { jar: adminJar });
    const admin = users
      .json()
      .users.find((user: { username: string }) => user.username === "admin_it");
    const selfDemote = await inject("PATCH", `/api/auth/users/${admin.id}`, {
      jar: adminJar,
      payload: { role: "viewer" },
    });
    expect(selfDemote.statusCode).toBe(400);
  });

  it("supports client CRUD, validation, and limit truth", async () => {
    const invalid = await inject("POST", "/api/clients", {
      jar: adminJar,
      payload: { label: "", trafficQuotaBytes: "-1" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(Array.isArray(invalid.json().details)).toBe(true);

    const created = await inject("POST", "/api/clients", {
      jar: adminJar,
      payload: {
        label: "Integration Client",
        email: "client@example.test",
        tags: ["it", "smoke"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        trafficQuotaBytes: "1073741824",
        maxConnections: 3,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    clientId = body.id;
    expect(body.trafficEnforcement).toBe("unavailable");
    expect(body.limitEnforcement.expiry).toBe("panel");
    expect(body.limitEnforcement.maxConnections).toBe("unavailable");

    const list = await inject("GET", "/api/clients?search=Integration&page=1&pageSize=10", {
      jar: adminJar,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((client: { id: string }) => client.id === clientId)).toBe(true);

    const patched = await inject("PATCH", `/api/clients/${clientId}`, {
      jar: adminJar,
      payload: { notes: "updated", isDisabled: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().isDisabled).toBe(true);
    const reenabled = await inject("PATCH", `/api/clients/${clientId}`, {
      jar: adminJar,
      payload: { isDisabled: false },
    });
    expect(reenabled.json().isDisabled).toBe(false);

    const detail = await inject("GET", `/api/clients/${clientId}`, { jar: adminJar });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().assignments).toEqual([]);
  });

  it("validates, versions, previews, imports, and exports configurations", async () => {
    const invalid = await inject("POST", "/api/configurations", {
      jar: adminJar,
      payload: {
        protocolId: "vless",
        name: "invalid",
        config: { host: "not a host!", port: 99999 },
      },
    });
    expect(invalid.statusCode).toBe(400);

    const preview = await inject("POST", "/api/configurations/validate", {
      jar: adminJar,
      payload: { protocolId: "vless", config: { host: "edge.example.test", port: 443 } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().valid).toBe(true);

    const created = await inject("POST", "/api/configurations", {
      jar: adminJar,
      payload: {
        protocolId: "vless",
        name: "integration-vless",
        config: {
          host: "edge.example.test",
          port: 443,
          transport: { network: "ws", security: "tls", path: "/ws", tlsSni: "edge.example.test" },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    configId = created.json().id;
    expect(created.json().currentVersion).toBe(1);

    const updated = await inject("PATCH", `/api/configurations/${configId}`, {
      jar: adminJar,
      payload: {
        config: {
          host: "edge.example.test",
          port: 8443,
          transport: { network: "ws", security: "tls", path: "/v2", tlsSni: "edge.example.test" },
        },
        changeNote: "port update",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().currentVersion).toBe(2);

    const versions = await inject("GET", `/api/configurations/${configId}/versions`, {
      jar: adminJar,
    });
    expect(versions.json().total).toBe(2);

    const rollback = await inject("POST", `/api/configurations/${configId}/rollback`, {
      jar: adminJar,
      payload: { versionNumber: 1 },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().currentVersion).toBe(3);

    const exported = await inject("GET", `/api/configurations/${configId}/export/server`, {
      jar: adminJar,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(exported.body).inbounds).toHaveLength(1);

    const xrayDoc = JSON.stringify({
      inbounds: [
        {
          port: 2053,
          listen: "0.0.0.0",
          protocol: "vless",
          settings: {},
          streamSettings: { network: "ws", security: "none", wsSettings: { path: "/imported" } },
        },
      ],
      outbounds: [],
    });
    const missingHost = await inject("POST", "/api/configurations/import/xray", {
      jar: adminJar,
      payload: { protocolId: "vless", text: xrayDoc },
    });
    expect(missingHost.statusCode).toBe(400);
    expect(
      missingHost.json().details.some((issue: { path: string }) => issue.path === "publicHost")
    ).toBe(true);

    const imported = await inject("POST", "/api/configurations/import/xray", {
      jar: adminJar,
      payload: { protocolId: "vless", text: xrayDoc, publicHost: "imported.example.test" },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().isActive).toBe(false);
    expect(imported.json().config.host).toBe("imported.example.test");

    const malformed = await inject("POST", "/api/configurations/import/singbox", {
      jar: adminJar,
      payload: { protocolId: "vless", text: "{not json" },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("assigns credentials and exports only redacted metadata", async () => {
    const assigned = await inject("POST", `/api/clients/${clientId}/assign`, {
      jar: adminJar,
      payload: { configurationId: configId },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().credentialId).toBeTruthy();

    const detail = await inject("GET", `/api/clients/${clientId}`, { jar: adminJar });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().assignments).toHaveLength(1);
    expect(detail.json().assignments[0].sealedSecret).toBeUndefined();
    expect(detail.body.includes("sealedSecret")).toBe(false);

    const uri = await inject("GET", `/api/clients/${clientId}/uri/${configId}`, { jar: adminJar });
    expect(uri.statusCode).toBe(200);
    expect(uri.json().uri.startsWith("vless://")).toBe(true);

    const qr = await inject("GET", `/api/clients/${clientId}/qr/${configId}`, { jar: adminJar });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers["content-type"]).toBe("image/png");
    expect(qr.rawPayload.length).toBeGreaterThan(500);

    const artifact = await inject("GET", `/api/clients/${clientId}/export/${configId}`, {
      jar: adminJar,
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.headers["cache-control"]).toBe("no-store");
    expect(artifact.body.startsWith("vless://")).toBe(true);
  });

  it("provisions WireGuard keys/addresses and OpenVPN credentials end-to-end", async () => {
    const wireguardConfig = await inject("POST", "/api/configurations", {
      jar: adminJar,
      payload: {
        protocolId: "wireguard",
        name: "integration-wireguard",
        notes: null,
        config: {
          serverPort: 51821,
          listenAddressCidr: "10.99.0.1/24",
          serverEndpointHost: "wg.example.test",
          serverEndpointPort: 51821,
          allowedIps: "0.0.0.0/0, ::/0",
          clientDnsServers: ["1.1.1.1"],
          keepaliveSeconds: 25,
        },
      },
    });
    expect(wireguardConfig.statusCode).toBe(201);
    const wgId = wireguardConfig.json().id as string;
    expect(wireguardConfig.json().config.serverPublicKey).toBeTruthy();

    const wgAssign = await inject("POST", `/api/clients/${clientId}/assign`, {
      jar: adminJar,
      payload: { configurationId: wgId },
    });
    expect(wgAssign.statusCode).toBe(200);

    const wgClient = await inject("GET", `/api/clients/${clientId}/export/${wgId}`, {
      jar: adminJar,
    });
    expect(wgClient.statusCode).toBe(200);
    expect(wgClient.body).toContain("[Interface]");
    expect(wgClient.body).toContain("PrivateKey =");
    expect(wgClient.body).toContain("PresharedKey =");
    expect(wgClient.body).toContain("Endpoint = wg.example.test:51821");

    const wgServer = await inject("GET", `/api/configurations/${wgId}/export/server`, {
      jar: adminJar,
    });
    expect(wgServer.statusCode).toBe(200);
    expect(wgServer.body).not.toContain("<PROVISIONED_SERVER_PRIVATE_KEY>");
    expect(wgServer.body).toContain("[Peer]");
    expect(wgServer.body).toContain("PresharedKey =");

    const ovpnProfile = [
      "client",
      "dev tun",
      "proto udp",
      "remote vpn.example.test 1194 udp",
      "<ca>",
      ...Array.from({ length: 8 }, () => "dGVzdA=="),
      "</ca>",
      "auth-user-pass",
      "data-ciphers AES-256-GCM",
    ].join("\n");
    const openvpn = await inject("POST", "/api/configurations", {
      jar: adminJar,
      payload: {
        protocolId: "openvpn",
        name: "integration-openvpn",
        config: { label: "integration-openvpn", profileText: ovpnProfile },
      },
    });
    expect(openvpn.statusCode).toBe(201);
    const ovpnId = openvpn.json().id as string;
    expect(openvpn.json().config.host).toBe("vpn.example.test");
    expect(openvpn.json().config.port).toBe(1194);

    const ovpnAssign = await inject("POST", `/api/clients/${clientId}/assign`, {
      jar: adminJar,
      payload: { configurationId: ovpnId },
    });
    expect(ovpnAssign.statusCode).toBe(200);

    const ovpnClient = await inject("GET", `/api/clients/${clientId}/export/${ovpnId}`, {
      jar: adminJar,
    });
    expect(ovpnClient.statusCode).toBe(200);
    expect(ovpnClient.body).toContain("<auth-user-pass>");
    expect(ovpnClient.body).toContain("remote vpn.example.test 1194 udp");
    expect(ovpnClient.headers["content-type"]).toContain("openvpn-profile");

    const wgSubscription = await inject("POST", "/api/subscriptions", {
      jar: adminJar,
      payload: { clientId, name: "wg-not-in-uri", format: "raw_uri" },
    });
    expect(wgSubscription.statusCode).toBe(201);
    const wgToken = (wgSubscription.json().url as string).split("/api/sub/")[1] ?? "";
    const wgSubFetch = await app.inject({ method: "GET", url: `/api/sub/${wgToken}` });
    // Only URI-compatible artifacts belong in a raw URI subscription.
    expect(wgSubFetch.body).not.toContain("[Interface]");
    expect(wgSubFetch.body).not.toContain("auth-user-pass");
  });

  it("issues, fetches, rotates, and revokes subscriptions", async () => {
    const created = await inject("POST", "/api/subscriptions", {
      jar: adminJar,
      payload: {
        clientId,
        name: "integration-sub",
        format: "xray_uri",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);
    const url = created.json().url as string;
    firstSubscriptionToken = url.split("/api/sub/")[1] ?? "";
    expect(firstSubscriptionToken.length).toBeGreaterThanOrEqual(20);

    const publicFetch = await app.inject({
      method: "GET",
      url: `/api/sub/${firstSubscriptionToken}`,
    });
    expect(publicFetch.statusCode).toBe(200);
    expect(publicFetch.headers["cache-control"]).toContain("no-store");
    const decoded = Buffer.from(publicFetch.body, "base64").toString("utf8");
    expect(decoded.startsWith("vless://")).toBe(true);

    const list = await inject("GET", "/api/subscriptions", { jar: adminJar });
    expect(list.body.includes("tokenHash")).toBe(false);
    expect(list.json().items.every((item: { url: unknown }) => item.url === null)).toBe(true);

    const singbox = await inject("POST", "/api/subscriptions", {
      jar: adminJar,
      payload: { clientId, name: "integration-singbox", format: "singbox_json" },
    });
    expect(singbox.statusCode).toBe(201);
    singboxSubscriptionToken = (singbox.json().url as string).split("/api/sub/")[1] ?? "";
    const singboxFetch = await app.inject({
      method: "GET",
      url: `/api/sub/${singboxSubscriptionToken}`,
    });
    expect(singboxFetch.statusCode).toBe(200);
    const parsed = JSON.parse(singboxFetch.body);
    expect(parsed.outbounds.some((outbound: { type: string }) => outbound.type === "vless")).toBe(
      true
    );
    expect(parsed.outbounds.some((outbound: { type: string }) => outbound.type === "direct")).toBe(
      true
    );

    const subscriptionId = created.json().id as string;
    const rotated = await inject("POST", `/api/subscriptions/${subscriptionId}/rotate`, {
      jar: adminJar,
    });
    expect(rotated.statusCode).toBe(200);
    const newUrl = rotated.json().url as string;
    expect(
      (await app.inject({ method: "GET", url: `/api/sub/${firstSubscriptionToken}` })).statusCode
    ).toBe(404);
    const newToken = newUrl.split("/api/sub/")[1] ?? "";
    expect((await app.inject({ method: "GET", url: `/api/sub/${newToken}` })).statusCode).toBe(200);

    const revoked = await inject("POST", `/api/subscriptions/${subscriptionId}/revoke`, {
      jar: adminJar,
    });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/sub/${newToken}` })).statusCode).toBe(404);
  });

  it("enforces subscription expiry and revoked tokens", async () => {
    const created = await inject("POST", "/api/subscriptions", {
      jar: adminJar,
      payload: { clientId, name: "expiring-sub", format: "raw_uri" },
    });
    expect(created.statusCode).toBe(201);
    const token = (created.json().url as string).split("/api/sub/")[1] ?? "";
    const id = created.json().id as string;
    await db.subscription.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await app.inject({ method: "GET", url: `/api/sub/${token}` })).statusCode).toBe(404);
    await inject("POST", `/api/subscriptions/${id}/revoke`, { jar: adminJar });
    expect((await app.inject({ method: "GET", url: `/api/sub/${token}` })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/sub/invalid-token-shape-1234567890" }))
        .statusCode
    ).toBe(404);
  });

  it("records audit events and returns sanitized metadata", async () => {
    const response = await inject("GET", "/api/audit?page=1&pageSize=100", { jar: adminJar });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBeGreaterThan(5);
    expect(body.items.some((event: { action: string }) => event.action === "client.create")).toBe(
      true
    );
    expect(response.body.includes(firstSubscriptionToken)).toBe(false);
    expect(response.body).not.toMatch(/\$argon2|sealedSecret|tokenHash/);
  });

  it("reports honest diagnostics and protocol states", async () => {
    const diagnostics = await inject("GET", "/api/diagnostics", { jar: adminJar });
    expect(diagnostics.statusCode).toBe(200);
    const body = diagnostics.json();
    expect(body.databaseReachable).toBe(true);
    expect(body.allMigrationsApplied).toBe(true);
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.protocols).toHaveLength(9);
    expect(body.protocols.find((p: { protocolId: string }) => p.protocolId === "vless").state).toBe(
      "runtime_unavailable"
    );
    expect(body.protocols.some((p: { state: string }) => p.state === "running_verified")).toBe(
      false
    );
    expect(body.keepAlive).toMatchObject({
      enabled: false,
      intervalMinutes: 3,
      method: "public-self-health-ping",
      targetPath: "/api/health",
    });

    const dashboard = await inject("GET", "/api/dashboard", { jar: adminJar });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().verifiedRunningProtocols).toBe(0);
    expect(dashboard.json().totalClients).toBeGreaterThan(0);
  });

  it("invalidates the session on logout", async () => {
    const logout = await inject("POST", "/api/auth/logout", { jar: adminJar });
    expect(logout.statusCode).toBe(200);
    const after = await inject("GET", "/api/auth/me", { jar: adminJar });
    expect(after.statusCode).toBe(401);
  });
});
