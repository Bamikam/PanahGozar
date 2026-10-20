import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM sealing for credential material stored in PostgreSQL.
 *
 * This is not a home-grown cipher — it is the standard Node crypto AES-256-GCM,
 * authenticated, with per-record random nonce and a version tag for future key
 * rotation. In dev/test the key comes from ENCRYPTION_KEY (validated at boot);
 * platforms such as Railway can inject it as a generated secret variable.
 */
const ALGO = "aes-256-gcm";
const VERSION = "v1";
const IV_LEN = 12;

export interface SealedEnvelope {
  v: "v1";
  iv: string;
  ct: string;
  tag: string;
}

export function seal(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const env: SealedEnvelope = {
    v: VERSION,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
  return `j${JSON.stringify(env)}`;
}

export function open(sealed: string, key: Buffer): string {
  if (!sealed.startsWith("j")) throw new Error("unknown sealed format");
  const env = JSON.parse(sealed.slice(1)) as SealedEnvelope;
  if (env.v !== VERSION) throw new Error("unsupported sealed version");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

export function safeOpen(sealed: string, key: Buffer): string | null {
  try {
    return open(sealed, key);
  } catch {
    return null;
  }
}

/** Constant-time string comparison for token checks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // compare against self to keep timing uniform, then fail
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
