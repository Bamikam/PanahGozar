import { z } from "zod";
import {
  HostSchema,
  PortSchema,
  formatHostForAuthority,
  zodIssues,
  type ZodValidationIssue,
} from "../primitives.js";
import type {
  ProtocolAdapter,
  ValidationResult,
  ProtocolCapabilities,
  ClientConfigInput,
  GeneratedConfig,
  RuntimeStatus,
  ExportResult,
  ExportCredential,
} from "../types.js";
import {
  generateWireGuardKeypair,
  isValidWireGuardKey,
  renderWireGuardClientConfig,
  fingerprintPublicKey,
} from "./wireguard.js";
import type { PrismaClient } from "@prisma/client";

/**
 * WireGuard adapter.
 *
 * Honest scope: WireGuard *needs* a UDP listener and (on Linux) a kernel
 * module — unreachable from PaaS web containers that forward HTTP(S)/TCP
 * (Railway/Render docs: inbound traffic is HTTP over TCP to a single PORT;
 * filesystems are ephemeral; background processes are not supported).
 * The panel:
 *  - generates and stores Curve25519 keypairs (server + clients),
 *  - validates configuration,
 *  - emits wq-quick-compatible client configs,
 *  - reports runtime_unavailable — tunnel truth is never fabricated.
 */

const WgServerSchema = z.object({
  serverPort: PortSchema.default(51820),
  listenAddressCidr: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, "must be CIDR like 10.0.0.1/24"),
  serverEndpointHost: HostSchema, // externally-hosted WG endpoint host
  serverEndpointPort: PortSchema.default(51820),
  allowedIps: z
    .string()
    .regex(/^[\d.:a-f/,\s]+$/i, "IPv4/IPv6 CIDR list")
    .default("0.0.0.0/0, ::/0"),
  clientDnsServers: z.array(HostSchema).max(4).default(["1.1.1.1"]),
  keepaliveSeconds: z.number().int().min(0).max(600).default(25),
  // Populated once when the panel provisions the server keypair. Public only.
  serverPublicKey: z.string().max(64).optional(),
});

const WgPeerSchema = z.object({
  clientId: z.string().cuid(),
  addressCidrHint: z.string().max(64).optional(),
});

export function buildServerWgConfig(
  serverPrivateKey: string,
  config: {
    serverPort: number;
    listenAddressCidr: string;
  },
  peers: { publicKey: string; allowedIps: string }[]
): string {
  if (!isValidWireGuardKey(serverPrivateKey)) throw new Error("invalid server private key");
  const lines = [
    "[Interface]",
    `PrivateKey = ${serverPrivateKey}`,
    `Address = ${config.listenAddressCidr}`,
    `ListenPort = ${config.serverPort}`,
    ...peers
      .map((p, i) => [
        "",
        `# Peer ${i + 1}`,
        `[Peer]`,
        `PublicKey = ${p.publicKey}`,
        `AllowedIPs = ${p.allowedIps}`,
      ])
      .flat(),
  ];
  return lines.join("\n") + "\n";
}

export class WireguardAdapter implements ProtocolAdapter {
  readonly id = "wireguard";
  readonly displayName = "WireGuard";

  constructor(private db: PrismaClient) {}

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: false, // .conf files, not URIs
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "WireGuard requires a UDP listener and kernel-level interface (tun/wireguard). Railway and " +
        "Render forward HTTP(S) over TCP only, and use ephemeral, unprivileged containers. Host the " +
        "WireGuard server on a VPS or dedicated machine; the panel manages keys and peer configs.",
      checks: [
        { key: "wireguard.binary", available: false, reason: "no wg/wg-quick in PATH" },
        {
          key: "wireguard.kernel",
          available: false,
          reason: "kernel module unavailable in container",
        },
      ],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = WgServerSchema.safeParse(config);
    if (!parsed.success) {
      const issues: ZodValidationIssue[] = zodIssues(parsed.error);
      return { valid: false, issues };
    }
    const d = parsed.data;
    const prefix = Number(d.listenAddressCidr.split("/")[1]);
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
      return {
        valid: false,
        issues: [
          {
            path: "listenAddressCidr",
            message: "WireGuard server and client addresses require a prefix between /8 and /30",
          },
        ],
      };
    }
    if (d.serverPublicKey && !isValidWireGuardKey(d.serverPublicKey)) {
      return {
        valid: false,
        issues: [{ path: "serverPublicKey", message: "must be a base64 32-byte WireGuard key" }],
      };
    }
    return { valid: true, issues: [], normalized: d as unknown as Record<string, unknown> };
  }

  async generateClientConfig(input: ClientConfigInput): Promise<GeneratedConfig> {
    const serverCfg = input.settings as {
      listenAddressCidr: string;
      serverEndpointHost: string;
      serverEndpointPort: number;
      allowedIps: string;
      clientDnsServers: string[];
      keepaliveSeconds: number;
      serverPublicKey?: string;
    };
    const priv = input.credential.privateKey;
    const serverPub = serverCfg.serverPublicKey ?? input.credential.serverPublicKey;
    if (!priv || !isValidWireGuardKey(priv)) {
      throw new Error("sealed client key was not a valid WireGuard key");
    }
    if (!serverPub || !isValidWireGuardKey(serverPub)) {
      throw new Error("WireGuard server public key has not been provisioned");
    }
    const addressCidr = input.credential.addressCidr;
    if (!addressCidr || !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(addressCidr)) {
      throw new Error("WireGuard client address is missing or invalid");
    }

    const conf = renderWireGuardClientConfig({
      clientPrivateKey: priv,
      clientAddressCidr: addressCidr,
      clientDnsServers: serverCfg.clientDnsServers ?? [],
      serverPublicKey: serverPub,
      serverEndpoint: `${formatHostForAuthority(serverCfg.serverEndpointHost)}:${serverCfg.serverEndpointPort}`,
      allowedIps: serverCfg.allowedIps ?? "0.0.0.0/0, ::/0",
      keepaliveSeconds: serverCfg.keepaliveSeconds,
      serverPresharedKey: input.credential.presharedKey,
    });
    return {
      content: conf,
      compatibleSubscriptionFormats: [], // .conf cannot ride subscription formats
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No WireGuard interface exists in this deployment: UDP + kernel support is not available on " +
        "PaaS web containers. Manage keys and peer configs here; run WireGuard externally.",
    };
  }

  exportConfig(
    config: Record<string, unknown>,
    _schemaVersion: string,
    credentials: readonly ExportCredential[] = []
  ): ExportResult {
    const cfg = config as {
      serverPort: number;
      listenAddressCidr: string;
    };
    const lines = [
      "[Interface]",
      `PrivateKey = <PROVISIONED_SERVER_PRIVATE_KEY>`,
      `Address = ${cfg.listenAddressCidr}`,
      `ListenPort = ${cfg.serverPort}`,
      ...credentials
        .filter(
          (c) => typeof c.secret.publicKey === "string" && typeof c.secret.addressCidr === "string"
        )
        .flatMap((c) => {
          const peer = [
            "",
            `# ${c.clientLabel} (${c.clientId})`,
            "[Peer]",
            `PublicKey = ${c.secret.publicKey}`,
            `AllowedIPs = ${c.secret.addressCidr}`,
          ];
          if (typeof c.secret.presharedKey === "string" && c.secret.presharedKey) {
            peer.push(`PresharedKey = ${c.secret.presharedKey}`);
          }
          return peer;
        }),
    ];
    return {
      filename: "wireguard-server.conf",
      contentType: "text/plain",
      content: lines.join("\n") + "\n",
    };
  }

  supportedSubscriptionFormats() {
    return [];
  }

  // Exposed for the service layer to generate fresh keypairs on demand.
  createKeypair() {
    return generateWireGuardKeypair();
  }

  fingerprint(publicKey: string) {
    return fingerprintPublicKey(publicKey);
  }
}

export { WgServerSchema, WgPeerSchema };
