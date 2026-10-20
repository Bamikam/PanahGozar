import { describe, it, expect } from "vitest";
import { VlessAdapter } from "../../src/server/protocols/adapters/vless.js";
import { VmessAdapter } from "../../src/server/protocols/adapters/vmess.js";
import { TrojanAdapter } from "../../src/server/protocols/adapters/trojan.js";
import { ShadowsocksAdapter } from "../../src/server/protocols/adapters/shadowsocks.js";
import { SocksAdapter } from "../../src/server/protocols/adapters/socks.js";
import { HttpAdapter } from "../../src/server/protocols/adapters/http.js";
import { MtprotoAdapter } from "../../src/server/protocols/adapters/mtproto.js";
import {
  isValidWireGuardKey,
  generateWireGuardKeypair,
  nextClientAddress,
} from "../../src/server/protocols/adapters/wireguard.js";
import { WireguardAdapter } from "../../src/server/protocols/adapters/wireguard-adapter.js";
import {
  OpenvpnAdapter,
  validateOvpnProfile,
} from "../../src/server/protocols/adapters/openvpn.js";
import { buildTgLink } from "../../src/server/protocols/adapters/mtproto.js";

/**
 * Unit tests for protocol adapters (spec §17): configuration validation,
 * URI generation, and truthful capability reporting.
 */

describe("vless adapter", () => {
  const a = new VlessAdapter();

  it("validates a good config", async () => {
    const r = await a.validateConfig({
      host: "example.com",
      port: 443,
      transport: { network: "ws", security: "tls", path: "/ws" },
    });
    expect(r.valid).toBe(true);
  });

  it("rejects bad port and host", async () => {
    const r = await a.validateConfig({ host: "not a host!", port: 99999 });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path.includes("port"))).toBe(true);
  });

  it("requires serviceName for grpc+tls", async () => {
    const r = await a.validateConfig({
      host: "h.co",
      port: 80,
      transport: { network: "grpc", security: "tls" },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((issue) => issue.path.includes("serviceName"))).toBe(true);
  });

  it("builds a correct vless:// URI", async () => {
    const g = await a.generateClientConfig({
      serverHost: "example.com",
      serverPort: 8443,
      credential: { uuid: "8f4c1e2a-1111-4222-8333-444455556666" },
      settings: {
        network: "ws",
        security: "tls",
        path: "/v2",
        host: "cdn.example.com",
        tlsSni: "sni.example.com",
      },
      remark: "Alice — phone",
    });
    const uri = new URL(g.uri!);
    expect(uri.protocol).toBe("vless:");
    expect(uri.username).toBe("8f4c1e2a-1111-4222-8333-444455556666");
    expect(uri.hostname).toBe("example.com");
    expect(uri.port).toBe("8443");
    expect(uri.searchParams.get("type")).toBe("ws");
    expect(uri.searchParams.get("security")).toBe("tls");
    expect(uri.searchParams.get("path")).toBe("/v2");
    expect(decodeURIComponent(uri.hash.slice(1))).toBe("Alice — phone");
  });

  it("reports runtime_unavailable, never running", async () => {
    const s = await a.getRuntimeStatus();
    expect(s.state).toBe("runtime_unavailable");
    expect(s.state).not.toBe("running_verified");
  });
});

describe("vmess adapter", () => {
  const a = new VmessAdapter();

  it("generates a valid base64 vmess:// payload", async () => {
    const g = await a.generateClientConfig({
      serverHost: "s.example.com",
      serverPort: 10086,
      credential: { uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      settings: { network: "tcp", security: "none", cipher: "auto", usersAlterId: 0 },
      remark: "vmess test",
    });
    expect(g.uri!.startsWith("vmess://")).toBe(true);
    const payload = JSON.parse(Buffer.from(g.uri!.slice(8), "base64").toString("utf8"));
    expect(payload).toMatchObject({
      v: "2",
      add: "s.example.com",
      port: "10086",
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      aid: "0",
      net: "tcp",
      tls: "none",
    });
  });

  it("rejects invalid cipher and alterId", async () => {
    const bad = await a.validateConfig({ host: "h.co", port: 1, cipher: "rc4-md5" });
    expect(bad.valid).toBe(false);
    const badAid = await a.validateConfig({ host: "h.co", port: 1, usersAlterId: -1 });
    expect(badAid.valid).toBe(false);
  });
});

describe("trojan adapter", () => {
  const a = new TrojanAdapter();

  it("encodes password and forces tls in URI", async () => {
    const g = await a.generateClientConfig({
      serverHost: "t.co",
      serverPort: 443,
      credential: { password: "pA55word-with/ch+ar" },
      settings: { tlsSni: "t.co" },
      remark: "T",
    });
    const uri = new URL(g.uri!);
    expect(decodeURIComponent(uri.username)).toBe("pA55word-with/ch+ar");
    expect(uri.searchParams.get("security")).toBe("tls");
  });
});

describe("shadowsocks adapter", () => {
  const a = new ShadowsocksAdapter();

  it("SIP002 URI round-trips method:password", async () => {
    const g = await a.generateClientConfig({
      serverHost: "1.2.3.4",
      serverPort: 8388,
      credential: { password: "secret-password-123" },
      settings: { method: "aes-256-gcm" },
      remark: "SS node",
    });
    expect(g.uri!.startsWith("ss://")).toBe(true);
    const userinfo = g.uri!.slice(5, g.uri!.indexOf("@"));
    const decoded = Buffer.from(
      userinfo
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(userinfo.length / 4) * 4, "="),
      "base64"
    ).toString("utf8");
    expect(decoded).toBe("aes-256-gcm:secret-password-123");
  });

  it("rejects weak stream cipher like aes-256-cfb", async () => {
    const r = await a.validateConfig({ host: "h.co", port: 8388, method: "aes-256-cfb" });
    expect(r.valid).toBe(false);
  });
});

describe("socks/http adapters", () => {
  it("socks builds auth URI with raw_uri compatibility only", async () => {
    const a = new SocksAdapter();
    const g = await a.generateClientConfig({
      serverHost: "1.1.1.1",
      serverPort: 1080,
      credential: { username: "u1", password: "p1" },
      settings: {},
      remark: "S",
    });
    expect(g.uri!.startsWith("socks://u1:p1@1.1.1.1:1080#")).toBe(true);
    expect(g.compatibleSubscriptionFormats).toEqual(["raw_uri", "singbox_json"]);
  });

  it("http builds auth URI", async () => {
    const a = new HttpAdapter();
    const g = await a.generateClientConfig({
      serverHost: "1.1.1.1",
      serverPort: 8080,
      credential: { username: "u2", password: "p2" },
      settings: {},
      remark: "",
    });
    expect(g.uri!.startsWith("http://u2:p2@1.1.1.1:8080#")).toBe(true);
  });
});

describe("mtproto adapter", () => {
  it("generates standard tg://proxy share link", () => {
    const { tgUri } = buildTgLink("dd" + "ab".repeat(16), "1.2.3.4", 443, "TG");
    expect(tgUri.startsWith("tg://proxy?server=1.2.3.4&port=443&secret=dd")).toBe(true);
  });
});

describe("wireguard key material", () => {
  it("generates valid 44-char base64 keypairs", () => {
    const kp = generateWireGuardKeypair();
    expect(kp.privateKey).toHaveLength(44);
    expect(kp.publicKey).toHaveLength(44);
    expect(isValidWireGuardKey(kp.privateKey)).toBe(true);
    expect(isValidWireGuardKey(kp.publicKey)).toBe(true);
  });

  it("derives distinct keypairs and rejects junk keys", () => {
    const kp1 = generateWireGuardKeypair();
    const kp2 = generateWireGuardKeypair();
    expect(kp1.privateKey).not.toBe(kp2.privateKey);
    expect(isValidWireGuardKey("not-a-key")).toBe(false);
    // "A".repeat(44) decodes to 33 bytes → not a valid 32-byte WG key.
    expect(isValidWireGuardKey("A".repeat(44))).toBe(false);
  });

  it("nextClientAddress computes sequential addresses in subnet", () => {
    expect(nextClientAddress("10.0.0.1/24", 1)).toBe("10.0.0.2/24");
    expect(nextClientAddress("10.0.0.1/24", 254)).toBe("10.0.0.255/24");
  });

  it("adapter refuses in-process hosting", async () => {
    const dbStub = {} as never;
    const a = new WireguardAdapter(dbStub);
    const caps = await a.detectCapabilities();
    expect(caps.canHostInProcess).toBe(false);
    expect(caps.requiresExternalServer).toBe(true);
  });
});

describe("openvpn profile validation", () => {
  it("accepts a well-formed embedded-CA profile", () => {
    const good = [
      "client",
      "remote vpn.example.com 1194 udp4",
      "<ca>",
      ...Array.from({ length: 12 }, () => "dGVzdA=="),
      "</ca>",
      "auth-user-pass",
      "data-ciphers AES-256-GCM",
    ].join("\n");
    const r = validateOvpnProfile(good);
    expect(r.valid).toBe(true);
  });

  it("rejects a profile with no remote and no CA", () => {
    const r = validateOvpnProfile("client\ndata-ciphers AES-256-GCM\n");
    expect(r.valid).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects executable directives in untrusted profiles", () => {
    const bad = [
      "client",
      "remote vpn.example.com 1194 udp",
      "<ca>",
      "dGVzdA==",
      "</ca>",
      "script-security 2",
      "up /bin/sh",
    ].join("\n");
    const result = validateOvpnProfile(bad);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.includes("forbidden executable directive"))).toBe(
      true
    );
  });

  it("injects sealed credentials as an inline auth block for export", async () => {
    const adapter = new OpenvpnAdapter();
    const profile = [
      "client",
      "remote vpn.example.com 1194 udp4",
      "<ca>",
      ...Array.from({ length: 8 }, () => "dGVzdA=="),
      "</ca>",
      "auth-user-pass /tmp/credentials",
      "data-ciphers AES-256-GCM",
    ].join("\n");
    const validation = await adapter.validateConfig({ label: "vpn", profileText: profile });
    expect(validation.valid).toBe(true);
    const generated = await adapter.generateClientConfig({
      serverHost: "vpn.example.com",
      serverPort: 1194,
      credential: { username: "user_1", password: "pass-1" },
      settings: validation.normalized!,
      remark: "Client",
    });
    expect(generated.content).toContain("<auth-user-pass>\nuser_1\npass-1\n</auth-user-pass>");
    expect(generated.content).not.toContain("/tmp/credentials");
  });
});

describe("HTTP/HTTPS proxy adapter", () => {
  it("requires certificate paths for a TLS listener and exports the certificates", async () => {
    const adapter = new HttpAdapter();
    const missing = await adapter.validateConfig({
      host: "proxy.example.com",
      port: 8443,
      tls: true,
    });
    expect(missing.valid).toBe(false);
    const valid = await adapter.validateConfig({
      host: "proxy.example.com",
      port: 8443,
      bindAddress: "0.0.0.0",
      tls: true,
      certificateFile: "/etc/ssl/fullchain.pem",
      keyFile: "/etc/ssl/privkey.pem",
    });
    expect(valid.valid).toBe(true);
    const exported = adapter.exportConfig(valid.normalized!, "1", []);
    const parsed = JSON.parse(exported.content);
    expect(parsed.streamSettings.security).toBe("tls");
    expect(parsed.streamSettings.tlsSettings.certificates[0].certificateFile).toBe(
      "/etc/ssl/fullchain.pem"
    );
  });

  it("builds a sing-box HTTPS proxy outbound", async () => {
    const adapter = new HttpAdapter();
    const outbound = await adapter.generateSingboxOutbound!({
      serverHost: "proxy.example.com",
      serverPort: 8443,
      credential: { username: "u", password: "p" },
      settings: { tls: true },
      remark: "proxy",
    });
    expect(outbound.type).toBe("http");
    expect((outbound.tls as { enabled: boolean }).enabled).toBe(true);
  });
});

describe("Xray TLS server exports", () => {
  it("includes configured certificate paths for VLESS and Trojan", async () => {
    const vless = new VlessAdapter();
    const vlessValidation = await vless.validateConfig({
      host: "edge.example.com",
      port: 443,
      transport: {
        network: "ws",
        security: "tls",
        path: "/ws",
        tlsSni: "edge.example.com",
        certificateFile: "/etc/xray/fullchain.pem",
        keyFile: "/etc/xray/key.pem",
      },
    });
    expect(vlessValidation.valid).toBe(true);
    const vlessExport = JSON.parse(vless.exportConfig(vlessValidation.normalized!, "1").content);
    expect(vlessExport.streamSettings.tlsSettings.certificates[0].keyFile).toBe(
      "/etc/xray/key.pem"
    );

    const trojan = new TrojanAdapter();
    const trojanValidation = await trojan.validateConfig({
      host: "edge.example.com",
      port: 443,
      certificateFile: "/etc/xray/fullchain.pem",
      keyFile: "/etc/xray/key.pem",
    });
    expect(trojanValidation.valid).toBe(true);
    const trojanExport = JSON.parse(trojan.exportConfig(trojanValidation.normalized!, "1").content);
    expect(trojanExport.streamSettings.tlsSettings.certificates[0].certificateFile).toBe(
      "/etc/xray/fullchain.pem"
    );
  });
});

describe("sing-box client outbounds", () => {
  it("generates a VLESS WS/TLS outbound without exposing anything else", async () => {
    const adapter = new VlessAdapter();
    const outbound = await adapter.generateSingboxOutbound!({
      serverHost: "edge.example.com",
      serverPort: 443,
      credential: { uuid: "8f4c1e2a-1111-4222-8333-444455556666" },
      settings: {
        network: "ws",
        security: "tls",
        path: "/ws",
        tlsSni: "edge.example.com",
      },
      remark: "client",
    });
    expect(outbound.type).toBe("vless");
    expect(outbound.server).toBe("edge.example.com");
    expect((outbound.transport as { type: string }).type).toBe("ws");
    expect((outbound.tls as { enabled: boolean }).enabled).toBe(true);
  });
});
