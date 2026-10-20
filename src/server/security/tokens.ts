import { randomBytes, createHash, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Token generation. All tokens are drawn from a CSPRNG (crypto.randomBytes).
 * Opaque 128-bit+ entropy, URL-safe base64url or hex. Nothing predictable.
 */

/** Base64url encode without padding. */
export function b64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Session token: 32 random bytes, base64url (same value returned to admin). */
export function generateSessionToken(): string {
  return b64url(randomBytes(32));
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Subscription token: 20 random bytes (160 bits) as base64url, unguessable. */
export function generateSubscriptionToken(): string {
  return b64url(randomBytes(20));
}

/** First-k-chars hint for admin-side identification (non-sensitive). */
export function tokenHint(token: string): string {
  return token.slice(0, 6);
}

/** Constant-time comparison for opaque token checks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Perform a same-length comparison so the failure path stays cheap/uniform.
    const padded = Buffer.alloc(ab.length);
    bb.copy(padded);
    timingSafeEqual(ab, padded);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** VLESS/VMess client UUID. */
export function generateUuid(): string {
  return randomUUID();
}

/** Trojan/VMess password compatible random string (44 chars base64url). */
export function generateRandomSecret(): string {
  return b64url(randomBytes(33));
}

/**
 * MTProto proxy secret.
 * Telegram MTProto proxy servers accept a 16-byte secret encoded as hex;
 * the "dd" prefix marks the padded variant per MTProto-proxy conventions.
 * We generate a true random 16-byte secret and hex-encode it.
 */
export function generateMtprotoSecret(padded = true): string {
  const raw = randomBytes(16);
  return padded ? `dd${raw.toString("hex")}` : raw.toString("hex");
}

/**
 * SOCKS/HTTP basic-auth username: readable, low-entropy-string safe.
 * Random hex, 12 chars.
 */
export function generateProxyUsername(): string {
  return randomBytes(6).toString("hex");
}
