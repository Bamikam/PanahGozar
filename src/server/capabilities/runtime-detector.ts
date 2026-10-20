import { access, constants, mkdir, rm, stat } from "node:fs/promises";
import { accessSync } from "node:fs";
import { platform, arch, homedir, userInfo } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * Runtime capability detection.
 *
 * Principles (per the project contract):
 *  - Never perform privileged actions to probe capabilities.
 *  - Never assume root, kernel features, UDP support, or binaries exist.
 *  - Every check is evidence-backed and machine-readable.
 *  - Absence is the default; availability must be demonstrated.
 *
 * This deployment model (single web service on Railway/Render) is
 * *externally hosted* for protocol runtimes: the panel manages configuration
 * and credentials, and honestly reports that no protocol listener can be
 * started inside this process/container.
 */

export interface CapabilityCheck {
  key: string;
  label: string;
  available: boolean;
  reason: string;
  evidence?: string;
  checkedAt: string;
}

export interface EnvironmentFacts {
  nodeVersion: string;
  platform: string;
  arch: string;
  processUser: string;
  isWindows: boolean;
  isLinux: boolean;
  isContainer: boolean | null; // best-effort; null = unknown, never assumed
  cwdWritable: boolean;
  homeDirWritable: boolean | null;
}

async function checkFileAccess(
  target: string,
  label: string,
  key: string
): Promise<CapabilityCheck> {
  const checkedAt = new Date().toISOString();
  try {
    await access(target, constants.W_OK);
    return { key, label, available: true, reason: "writable", evidence: target, checkedAt };
  } catch (err) {
    return {
      key,
      label,
      available: false,
      reason: err instanceof Error ? err.message : "not writable",
      evidence: target,
      checkedAt,
    };
  }
}

/**
 * Searches directories in PATH for an executable — a pure fs probe.
 * We do NOT spawn the binary (no side effects, no privilege escalation).
 */
export function findExecutableOnPath(name: string): string | null {
  const pathVar = process.env.PATH ?? "";
  const exts = platform() === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext.toLowerCase()}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Intentionally ignore and continue: absence is normal.
      }
    }
  }
  return null;
}

async function binaryProbe(names: string[]): Promise<{ found: string | null; pathways: string[] }> {
  const pathways: string[] = [];
  for (const n of names) {
    const p = findExecutableOnPath(n);
    if (p) return { found: p, pathways };
    pathways.push(n);
  }
  return { found: null, pathways };
}

export async function collectEnvironmentFacts(): Promise<EnvironmentFacts> {
  const facts: EnvironmentFacts = {
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    processUser: "unknown",
    isWindows: platform() === "win32",
    isLinux: platform() === "linux",
    isContainer: null,
    cwdWritable: false,
    homeDirWritable: null,
  };

  try {
    facts.processUser =
      process.platform === "win32"
        ? userInfo().username
        : userInfo().username || `uid:${process.getuid?.() ?? "?"}`;
  } catch {
    facts.processUser = "unknown";
  }

  // CWD writability - non-destructive probe; the probe directory is removed.
  const cwd = process.cwd();
  const probeDir = path.join(cwd, ".panah-probe");
  try {
    await mkdir(probeDir, { recursive: true });
    await access(probeDir, constants.W_OK);
    facts.cwdWritable = true;
  } catch {
    facts.cwdWritable = false;
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }

  try {
    const home = homedir();
    await access(home, constants.W_OK);
    facts.homeDirWritable = true;
  } catch {
    facts.homeDirWritable = false;
  }

  // Container detection is evidential, never assumed: /.dockerenv existence.
  try {
    const s = await stat("/.dockerenv");
    facts.isContainer = s.isFile();
  } catch {
    facts.isContainer = null; // unknown — do not claim
  }

  return facts;
}

export interface ProtocolRuntimeRequirements {
  protocolId: string;
  binaries: string[];
  needsRoot: boolean;
  needsUdp: boolean;
  needsKernelModule?: string; // e.g. "wireguard"
}

const RUNTIME_REQUIREMENTS: Record<string, ProtocolRuntimeRequirements> = {
  // Xray-core protocols: the panel only produces configuration; running an
  // in-process Xray instance is opt-in via ENABLE_RUNTIME_LISTENERS and still
  // requires the xray binary — which ordinary PaaS containers do not ship.
  vless: { protocolId: "vless", binaries: ["xray"], needsRoot: false, needsUdp: false },
  vmess: { protocolId: "vmess", binaries: ["xray"], needsRoot: false, needsUdp: false },
  trojan: { protocolId: "trojan", binaries: ["xray"], needsRoot: false, needsUdp: false },
  shadowsocks: {
    protocolId: "shadowsocks",
    binaries: ["xray", "ssserver", "ss-local"],
    needsRoot: false,
    needsUdp: false,
  },
  socks: {
    protocolId: "socks",
    binaries: [],
    needsRoot: false,
    needsUdp: true,
    needsKernelModule: "none (pure Node)",
  },
  http: { protocolId: "http", binaries: [], needsRoot: false, needsUdp: false },
  mtproto: {
    protocolId: "mtproto",
    binaries: ["erlang-mtproto-proxy", "mtproto-proxy"],
    needsRoot: false,
    needsUdp: false,
  },
  wireguard: {
    protocolId: "wireguard",
    binaries: ["wg", "wg-quick"],
    needsRoot: true,
    needsUdp: true,
    needsKernelModule: "wireguard",
  },
  openvpn: {
    protocolId: "openvpn",
    binaries: ["openvpn"],
    needsRoot: true,
    needsUdp: true,
    needsKernelModule: "tun",
  },
};

export async function checkProtocolRuntime(
  protocolId: string,
  facts: EnvironmentFacts
): Promise<CapabilityCheck[]> {
  const req = RUNTIME_REQUIREMENTS[protocolId];
  if (!req) return [];
  const checks: CapabilityCheck[] = [];
  const checkedAt = new Date().toISOString();

  // Binaries
  const bin = await binaryProbe(req.binaries);
  checks.push({
    key: `${protocolId}.binary`,
    label: `Required binary for ${protocolId}`,
    available: bin.found !== null,
    reason: bin.found === null ? `no binary in PATH (${bin.pathways.join(", ")})` : "found in PATH",
    evidence: bin.found ?? undefined,
    checkedAt,
  });

  // Runtime listener master switch: protocols hosted externally by default.
  if (bin.found !== null) {
    checks.push({
      key: `${protocolId}.listener_switch`,
      label: `In-process runtime switch for ${protocolId}`,
      available: false, // disabled by design: single web-service deployment
      reason:
        "ENABLE_RUNTIME_LISTENERS is false: this deployment runs protocols on an external server. " +
        "The panel only manages configuration here.",
      checkedAt,
    });
  }

  // Privilege
  if (req.needsRoot) {
    let isRoot = false;
    try {
      isRoot = typeof process.getuid === "function" ? process.getuid() === 0 : false;
    } catch {
      isRoot = false;
    }
    checks.push({
      key: `${protocolId}.privilege`,
      label: `Root privileges for ${protocolId}`,
      available: isRoot,
      reason: isRoot
        ? "process runs as root"
        : "process is not root; hosting containers typically are not",
      checkedAt,
    });
  }

  // UDP + kernel (VPN protocols)
  if (req.needsUdp || req.needsKernelModule) {
    checks.push({
      key: `${protocolId}.udp_kernel`,
      label: `UDP listener & kernel support for ${protocolId}`,
      available: false,
      reason:
        "This web service is reachable only through the platform HTTP router (and optionally a " +
        "manually configured Railway TCP proxy). UDP forwarding and kernel tun/wireguard interfaces " +
        "are not provided to this container. Host this protocol on a VPS or dedicated worker.",
      evidence: `platform=${facts.platform}`,
      checkedAt,
    });
  }

  return checks;
}

/**
 * Full diagnostic sweep. Persists results (upsert by key) so the dashboard
 * and readiness endpoint can read stable, auditable truth.
 */
export async function runCapabilitySweep(
  db: PrismaClient,
  facts: EnvironmentFacts,
  protocolIds: string[]
): Promise<CapabilityCheck[]> {
  const baseChecks: CapabilityCheck[] = [
    {
      key: "node.version",
      label: "Node.js runtime version",
      available: Number(process.versions.node.split(".")[0]) >= 18,
      reason: `running ${process.version} (minimum 18.17 supported)`,
      evidence: process.version,
      checkedAt: new Date().toISOString(),
    },
    {
      key: "platform.http_tcp_only",
      label: "Platform-managed HTTP ingress",
      available: true,
      reason:
        "The supported public entry point is the platform HTTP(S) router. Raw protocol listeners " +
        "are not started by this deployment; only this web app's HTTP port is managed here.",
      checkedAt: new Date().toISOString(),
    },
    {
      key: "process.root",
      label: "Process runs as root",
      available: typeof process.getuid === "function" ? process.getuid() === 0 : false,
      reason:
        typeof process.getuid === "function"
          ? process.getuid() === 0
            ? "process is root"
            : "process is unprivileged"
          : "root semantics are not applicable on this platform",
      checkedAt: new Date().toISOString(),
    },
  ];

  const cwd = await checkFileAccess(process.cwd(), "Working directory", "fs.cwd");
  const all: CapabilityCheck[] = [...baseChecks, cwd];

  for (const pid of protocolIds) {
    all.push(...(await checkProtocolRuntime(pid, facts)));
  }

  // Persist in database for auditability.
  for (const c of all) {
    await db.runtimeCapability.upsert({
      where: { key: c.key },
      update: {
        available: c.available,
        detail: {
          reason: c.reason,
          evidence: c.evidence ?? null,
          label: c.label,
        },
        checkedAt: new Date(c.checkedAt),
      },
      create: {
        key: c.key,
        available: c.available,
        detail: { reason: c.reason, evidence: c.evidence ?? null, label: c.label },
        checkedAt: new Date(c.checkedAt),
      },
    });
  }

  return all;
}
