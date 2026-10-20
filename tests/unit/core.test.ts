import { describe, it, expect } from "vitest";
import { seal, open } from "../../src/server/security/sealed-store.js";
import {
  generateSessionToken,
  generateSubscriptionToken,
  sha256,
  tokenHint,
  generateMtprotoSecret,
} from "../../src/server/security/tokens.js";
import { redactMeta, redactRequestUrl } from "../../src/server/logger.js";
import { evaluateState } from "../../src/server/services/status-service.js";
import { importXrayConfig } from "../../src/server/protocols/xray-import.js";
import { importSingboxConfig } from "../../src/server/protocols/singbox-import.js";
import { parseSafeJson } from "../../src/server/protocols/primitives.js";
import { decodeEncryptionKey } from "../../src/server/env.js";

/** Key format test vectors for sealed-store and token generation (spec §17). */
const KEY = Buffer.alloc(32, 7);

describe("sealed store (AES-256-GCM)", () => {
  it("seals and opens round-trip", () => {
    const payload = JSON.stringify({ password: "s3cr3t-value" });
    const sealed = seal(payload, KEY);
    expect(sealed.startsWith("j")).toBe(true);
    expect(sealed.includes("s3cr3t-value")).toBe(false);
    expect(open(sealed, KEY)).toBe(payload);
  });

  it("fails to open with wrong key (auth tag mismatch)", () => {
    const sealed = seal("data", KEY);
    expect(() => open(sealed, Buffer.alloc(32, 9))).toThrow();
  });

  it("uses random IVs so identical plaintexts seal differently", () => {
    const a = seal("same", KEY);
    const b = seal("same", KEY);
    expect(a).not.toBe(b);
  });
});

describe("token generation", () => {
  it("session tokens are 43-char base64url from 32 bytes", () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("subscription tokens have ≥128-bit entropy and hash-stable", () => {
    const t = generateSubscriptionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{27}$/);
    expect(sha256(t)).toHaveLength(64);
  });

  it("mtproto secret is dd-prefixed 16-byte hex when padded", () => {
    const s = generateMtprotoSecret(true);
    expect(s).toMatch(/^dd[0-9a-f]{32}$/);
  });

  it("tokenHint never exposes the full token", () => {
    const t = generateSubscriptionToken();
    expect(tokenHint(t)).toHaveLength(6);
    expect(tokenHint(t)).not.toBe(t);
  });
});

describe("secret redaction", () => {
  it("scrubs sensitive keys defensively", () => {
    const meta = {
      label: "alice",
      password: "hunter2",
      passwordHash: "argon2id$…",
      nested: { privateKey: "KEYMATERIAL", url: "https://panel/api/sub/SUPER-SECRET-TOKEN" },
      tokens: ["a"],
    };
    const out = redactMeta(meta);
    expect(out.password).toBe("[scrubbed]");
    expect(out.passwordHash).toBe("[scrubbed]");
    expect((out.nested as Record<string, unknown>).privateKey).toBe("[scrubbed]");
    expect((out.nested as Record<string, unknown>).url).toBe("[scrubbed]");
    expect(out.tokens).toBe("[scrubbed]");
    expect(out.label).toBe("alice");
  });

  it("redacts subscription bearer tokens from request URLs", () => {
    expect(redactRequestUrl("/api/sub/SUPER-SECRET-TOKEN")).toBe("/api/sub/[redacted]");
    expect(redactRequestUrl("/api/sub/SUPER-SECRET-TOKEN?token=abc&x=1")).toBe(
      "/api/sub/[redacted]?token=[redacted]&x=1"
    );
    expect(redactRequestUrl("/api/health")).toBe("/api/health");
  });
});

describe("environment secret decoding", () => {
  it("accepts 64-character hex and base64 32-byte keys, rejecting other lengths", () => {
    const hex = "ab".repeat(32);
    expect(decodeEncryptionKey(hex)?.toString("hex")).toBe(hex);
    const base64 = Buffer.alloc(32, 9).toString("base64");
    expect(decodeEncryptionKey(base64)?.length).toBe(32);
    expect(decodeEncryptionKey("not-a-key")).toBeNull();
    expect(decodeEncryptionKey(Buffer.alloc(16, 9).toString("base64"))).toBeNull();
  });
});

describe("capability state evaluation", () => {
  it("maps no-configuration → not_configured", () => {
    const r = evaluateState(false, false, null);
    expect(r.state).toBe("not_configured");
  });

  it("external-only protocols stay runtime_unavailable even when configured", () => {
    const r = evaluateState(true, false, null);
    expect(r.state).toBe("runtime_unavailable");
    expect(r.enforcementNote).toContain("external");
  });

  it("in-process + live passing check → running_verified only from a real check", () => {
    const r = evaluateState(true, true, "running_verified");
    expect(r.state).toBe("running_verified");
  });

  it("in-process + failed check → error, never verified", () => {
    const r = evaluateState(true, true, "error");
    expect(r.state).toBe("error");
  });

  it("in-process verified check degraded → degraded", () => {
    const r = evaluateState(true, true, "degraded");
    expect(r.state).toBe("degraded");
  });

  it("in-process + configured but never verified → awaiting_verification", () => {
    const r = evaluateState(true, true, null);
    expect(r.state).toBe("awaiting_verification");
  });
});

describe("expiry calculations", () => {
  it("helper identifies future vs past expiry", () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    expect(isExpired(past)).toBe(true);
    expect(isExpired(future)).toBe(false);
  });
});

function isExpired(date: Date): boolean {
  return date.getTime() < Date.now();
}

describe("safe JSON parsing", () => {
  it("rejects >1MB imports", () => {
    const r = parseSafeJson("x".repeat(1_000_001));
    expect(r.ok).toBe(false);
  });
});

describe("xray import (untrusted)", () => {
  it("accepts valid doc and extracts inbounds", () => {
    const doc = JSON.stringify({
      inbounds: [
        { port: 443, protocol: "vless", settings: {}, streamSettings: { network: "ws" } },
        { port: 8000, protocol: "socks", settings: {} },
      ],
      outbounds: [],
    });
    const r = importXrayConfig(doc);
    expect(r.ok).toBe(true);
    expect(r.inbounds).toHaveLength(2);
    expect(r.inbounds[0]?.protocol).toBe("vless");
  });

  it("rejects unexpected structure and unsupported protocols", () => {
    const r1 = importXrayConfig(JSON.stringify({ inbounds: "nope" }));
    expect(r1.ok).toBe(false);
    const r2 = importXrayConfig(
      JSON.stringify({ inbounds: [{ port: 1, protocol: "dokodemo-door" }] })
    );
    expect(r2.issues.some((i) => i.includes("unsupported protocol"))).toBe(true);
  });
});

describe("sing-box import (untrusted)", () => {
  it("accepts known outbound types and skips unknown", () => {
    const doc = JSON.stringify({
      outbounds: [
        { type: "vless", tag: "proxy", server: "s.co", server_port: 443 },
        { type: "some-future", tag: "x" },
      ],
    });
    const r = importSingboxConfig(doc);
    expect(r.outbounds).toHaveLength(1);
    expect(r.issues.some((i) => i.includes("unsupported"))).toBe(true);
  });
});
