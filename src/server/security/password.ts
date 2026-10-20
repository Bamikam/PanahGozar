import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id password hashing via @node-rs/argon2 (prebuilt natives, OWASP
 * recommended parameters). No home-grown cryptography.
 * Memory 19 MiB, iterations 2, parallelism 1 — OWASP minimal; tuned countries
 * for low-RAM hosting (Railway/Render free tiers) still benefit from the
 * memory-hardened Argon2id cost profile.
 */
const ARGON_OPTS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON_OPTS);
}

export async function verifyPassword(hashedStored: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(hashedStored, plaintext);
  } catch {
    return false;
  }
}
