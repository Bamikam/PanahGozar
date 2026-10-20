import { generateKeyPairSync, createHash } from "node:crypto";

/**
 * WireGuard Curve25519 key material helpers using native Node crypto.
 *
 * WireGuard keys are Curve25519 keys rendered as 32-byte little-endian,
 * base64-encoded values. Node exposes X25519 keypairs via generateKeyPairSync.
 * Exporting raw bytes requires DER unwrapping — this is key *serialization*,
 * not custom cryptography: the math is from OpenSSL/libuv, the only custom
 * part is slicing the known DER container layout per RFC 8410.
 *
 * RFC 8410 ASN.1 layout ( DER, 44 bytes ):
 *   SPKI  = 30 2a 30 05 06 03 2b 65 6e 03 21 00 || 32-byte pubkey
 *   PKCS8 = 30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20 || 32-byte privkey
 */
const SPKI_PUB_OFFSET = 12; // 12 bytes header + 32-byte key
const PKCS8_PRIV_OFFSET = 16; // 16 bytes header + 32-byte key

export interface WireGuardKeypair {
  privateKey: string; // base64, 44 chars
  publicKey: string; // base64, 44 chars
}

export function generateWireGuardKeypair(): WireGuardKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519", {
    // Key derivation delegated to node's crypto (OpenSSL) — no custom math.
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const pub = publicKey.subarray(SPKI_PUB_OFFSET);
  const priv = privateKey.subarray(PKCS8_PRIV_OFFSET);
  if (pub.length !== 32 || priv.length !== 32) throw new Error("bad x25519 DER layout");

  return {
    privateKey: priv.toString("base64"),
    publicKey: pub.toString("base64"),
  };
}

/** Validates a WireGuard key (base64 of 32 bytes). */
export function isValidWireGuardKey(key: string): boolean {
  if (typeof key !== "string" || key.length !== 44) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return false;
  try {
    const buf = Buffer.from(key, "base64");
    return buf.length === 32;
  } catch {
    return false;
  }
}

/** wg-quick style client configuration text. */
export interface WireGuardClientConfigInput {
  clientPrivateKey: string;
  clientAddressCidr: string; // e.g. "10.0.0.2/32"
  clientDnsServers: string[];
  serverPublicKey: string;
  serverEndpoint: string; // host:port
  allowedIps: string; // e.g. "0.0.0.0/0, ::/0"
  keepaliveSeconds?: number;
  serverPresharedKey?: string;
}

export function renderWireGuardClientConfig(input: WireGuardClientConfigInput): string {
  if (!isValidWireGuardKey(input.clientPrivateKey)) throw new Error("invalid client private key");
  if (!isValidWireGuardKey(input.serverPublicKey)) throw new Error("invalid server public key");
  const lines: string[] = [
    "[Interface]",
    `PrivateKey = ${input.clientPrivateKey}`,
    `Address = ${input.clientAddressCidr}`,
    input.clientDnsServers.length > 0 ? `DNS = ${input.clientDnsServers.join(", ")}` : "",
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKey}`,
    `AllowedIPs = ${input.allowedIps}`,
    `Endpoint = ${input.serverEndpoint}`,
  ];
  if (typeof input.keepaliveSeconds === "number" && input.keepaliveSeconds > 0) {
    lines.push(`PersistentKeepalive = ${input.keepaliveSeconds}`);
  }
  if (input.serverPresharedKey) {
    if (!isValidWireGuardKey(input.serverPresharedKey)) throw new Error("invalid preshared key");
    lines.push(`PresharedKey = ${input.serverPresharedKey}`);
  }
  return lines.filter((l) => l !== "" || l === "").join("\n") + "\n";
}

/**
 * Subnet helper for deterministic client address assignment.
 * Given a base like "10.0.0.0/24" (server side), returns the IP at the given
 * offset. Pure arithmetic; not from user text. Never "auto-detects" routes.
 */
export function nextClientAddress(baseCidr: string, offset: number): string | null {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(baseCidr);
  if (!m) return null;
  const base = m[1];
  const prefixMatch = m[2];
  if (!base || !prefixMatch) return null;
  const addr = base.split(".").map(Number) as [number, number, number, number];
  if (addr.some((p) => p < 0 || p > 255)) return null;
  const prefix = Number(prefixMatch);
  if (prefix > 32) return null;
  const addr32 = ((addr[0] << 24) | (addr[1] << 16) | (addr[2] << 8) | addr[3]) >>> 0;
  const next = (addr32 + offset) >>> 0;
  const lastOctet = next >>> 24;
  const parts = [next >>> 24, (next >>> 16) & 0xff, (next >>> 8) & 0xff, next & 0xff];
  void lastOctet;
  return `${parts.join(".")}/${prefix}`;
}

export function fingerprintPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 16);
}
