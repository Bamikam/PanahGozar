import type { ProtocolCategoryId, DeploymentMode, ProtocolInfoDTO } from "../../shared/types.js";

/**
 * Canonical protocol catalog. This is reference data, not runtime evidence:
 * every entry is configuration-managed by the panel and hosted externally.
 * Category, transport and privilege facts are shown in the UI so operators
 * can distinguish a valid configuration from a running listener.
 */
export interface ProtocolCatalogEntry extends ProtocolInfoDTO {
  description: string;
  configurationFields: string[];
  externalRuntimeNote: string;
}

export const PROTOCOL_CATALOG: ProtocolCatalogEntry[] = [
  {
    id: "vless",
    displayName: "VLESS",
    category: "xray_proxy",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: false,
    requiresRoot: false,
    docsUrl: "https://xtls.github.io/en/config/inbounds/vless.html",
    description:
      "Lightweight Xray inbound with UUID authentication. Supports TCP, WebSocket and gRPC with optional TLS.",
    configurationFields: ["host", "port", "transport", "allowTransparent"],
    externalRuntimeNote:
      "Run Xray-core on an external server; this panel cannot create a VLESS listener.",
  },
  {
    id: "vmess",
    displayName: "VMess",
    category: "xray_proxy",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: false,
    requiresRoot: false,
    docsUrl: "https://xtls.github.io/en/config/inbounds/vmess.html",
    description:
      "Xray VMess inbound with UUID authentication and AEAD. Generates V2RayN-compatible vmess:// links.",
    configurationFields: ["host", "port", "transport", "usersAlterId", "cipher"],
    externalRuntimeNote:
      "Run Xray-core on an external server; no VMess listener runs in this process.",
  },
  {
    id: "trojan",
    displayName: "Trojan",
    category: "xray_proxy",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: false,
    requiresRoot: false,
    docsUrl: "https://xtls.github.io/en/config/inbounds/trojan.html",
    description:
      "TLS-mandatory Trojan inbound with password authentication and optional fallback target.",
    configurationFields: ["host", "port", "tlsSni", "fallbackTarget"],
    externalRuntimeNote:
      "Requires an external TLS listener (Xray or another Trojan implementation).",
  },
  {
    id: "shadowsocks",
    displayName: "Shadowsocks",
    category: "xray_proxy",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: false,
    requiresRoot: false,
    docsUrl: "https://xtls.github.io/en/config/inbounds/shadowsocks.html",
    description:
      "AEAD Shadowsocks (SIP002). Generates per-client passwords and a multi-user Xray inbound export.",
    configurationFields: ["host", "port", "method", "network"],
    externalRuntimeNote:
      "Run Xray's Shadowsocks inbound or shadowsocks-rust on an external server.",
  },
  {
    id: "socks",
    displayName: "SOCKS5",
    category: "proxy",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: true,
    requiresRoot: false,
    docsUrl: "https://datatracker.ietf.org/doc/html/rfc1928",
    description:
      "SOCKS5 forward proxy with username/password authentication and optional UDP associate.",
    configurationFields: ["host", "port", "bindAddress", "udpAssociate"],
    externalRuntimeNote:
      "Requires a raw TCP listener and optionally UDP; host it outside the web service.",
  },
  {
    id: "http",
    displayName: "HTTP / HTTPS Proxy",
    category: "proxy",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: false,
    requiresRoot: false,
    docsUrl: "https://xtls.github.io/en/config/inbounds/http.html",
    description:
      "HTTP CONNECT forward proxy, optionally wrapped in TLS (HTTPS proxy) with externally hosted certificate paths.",
    configurationFields: ["host", "port", "bindAddress", "allowConnect", "tls"],
    externalRuntimeNote: "Forward-proxy listeners cannot be exposed on the platform HTTP router.",
  },
  {
    id: "mtproto",
    displayName: "Telegram MTProto Proxy",
    category: "integration",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: false,
    requiresRoot: false,
    docsUrl: "https://github.com/seriyps/mtproto_proxy",
    description:
      "Telegram MTProto proxy configuration, CSPRNG secret generation and tg:// share links. No fake listener status.",
    configurationFields: ["host", "port", "adTag", "preferredTransport"],
    externalRuntimeNote:
      "Host erlang-mtproto-proxy or MTProxy on a server with a dedicated TCP port.",
  },
  {
    id: "wireguard",
    displayName: "WireGuard",
    category: "vpn",
    deploymentMode: "external",
    requiresInboundTcp: false,
    requiresUdp: true,
    requiresRoot: true,
    docsUrl: "https://www.wireguard.com/quickstart/",
    description:
      "Curve25519 key lifecycle, client address allocation and wg-quick configuration export. Server private key sealed at rest.",
    configurationFields: [
      "listenAddressCidr",
      "serverPort",
      "serverEndpointHost",
      "allowedIps",
      "clientDnsServers",
    ],
    externalRuntimeNote:
      "WireGuard needs a UDP port and kernel/userspace WireGuard support that the web container does not provide.",
  },
  {
    id: "openvpn",
    displayName: "OpenVPN",
    category: "vpn",
    deploymentMode: "external",
    requiresInboundTcp: true,
    requiresUdp: true,
    requiresRoot: true,
    docsUrl: "https://openvpn.net/community-resources/how-to/",
    description:
      "Validated .ovpn client-profile import, sealed username/password credentials and per-client profile export.",
    configurationFields: ["profileText", "label"],
    externalRuntimeNote:
      "OpenVPN requires tun/tap and usually root; host it externally. The panel never claims a tunnel.",
  },
];

export function catalogEntry(id: string): ProtocolCatalogEntry | undefined {
  return PROTOCOL_CATALOG.find((p) => p.id === id);
}

export function protocolCategoryLabel(id: ProtocolCategoryId): string {
  return id === "xray_proxy"
    ? "Xray-compatible"
    : id === "proxy"
      ? "Proxy"
      : id === "vpn"
        ? "VPN"
        : "Integration";
}

export const DEPLOYMENT_MODE_LABEL: Record<DeploymentMode, string> = {
  external: "External runtime",
  internal: "In-process runtime",
  unknown: "Unknown",
};
