import type { Prisma } from "@prisma/client";
import type { AppConfig } from "../env-types.js";
import { open, seal } from "../security/sealed-store.js";
import { generateWireGuardKeypair, isValidWireGuardKey } from "./adapters/wireguard.js";

export interface WireGuardServerMaterial {
  privateKey: string;
  publicKey: string;
}

type DbLike = Pick<Prisma.TransactionClient, "applicationSetting">;

const KEY_PREFIX = "wireguard.serverKey.";

export function wireGuardServerKeySetting(configurationId: string): string {
  return `${KEY_PREFIX}${configurationId}`;
}

/** Reads the sealed server keypair for a WireGuard configuration. */
export async function readWireGuardServerKey(
  db: DbLike,
  cfg: AppConfig,
  configurationId: string
): Promise<WireGuardServerMaterial | null> {
  const setting = await db.applicationSetting.findUnique({
    where: { key: wireGuardServerKeySetting(configurationId) },
  });
  const sealed = (setting?.value as { sealed?: string } | null)?.sealed;
  if (typeof sealed !== "string") return null;
  try {
    const pair = JSON.parse(open(sealed, cfg.encryptionKey)) as Partial<WireGuardServerMaterial>;
    if (
      typeof pair.privateKey === "string" &&
      typeof pair.publicKey === "string" &&
      isValidWireGuardKey(pair.privateKey) &&
      isValidWireGuardKey(pair.publicKey)
    ) {
      return { privateKey: pair.privateKey, publicKey: pair.publicKey };
    }
  } catch {
    // Corrupt or foreign-key envelope: caller may reprovision.
  }
  return null;
}

/**
 * Ensures a WireGuard server keypair exists and that the public half is in the
 * non-secret configuration JSON. The private half is only ever sealed in
 * ApplicationSetting and unsealed for an authorized server-side export.
 */
export async function ensureWireGuardServerKey(
  db: DbLike,
  cfg: AppConfig,
  configurationId: string,
  config: Record<string, unknown>
): Promise<{ config: Record<string, unknown>; material: WireGuardServerMaterial }> {
  let material = await readWireGuardServerKey(db, cfg, configurationId);
  if (!material) {
    const pair = generateWireGuardKeypair();
    material = { privateKey: pair.privateKey, publicKey: pair.publicKey };
    const sealed = seal(JSON.stringify(material), cfg.encryptionKey);
    await db.applicationSetting.upsert({
      where: { key: wireGuardServerKeySetting(configurationId) },
      update: { value: { sealed } },
      create: { key: wireGuardServerKeySetting(configurationId), value: { sealed } },
    });
  }
  return { config: { ...config, serverPublicKey: material.publicKey }, material };
}
