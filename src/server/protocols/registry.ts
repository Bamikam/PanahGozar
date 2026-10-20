import type { ProtocolAdapter } from "./types.js";
import { VlessAdapter } from "./adapters/vless.js";
import { VmessAdapter } from "./adapters/vmess.js";
import { TrojanAdapter } from "./adapters/trojan.js";
import { ShadowsocksAdapter } from "./adapters/shadowsocks.js";
import { SocksAdapter } from "./adapters/socks.js";
import { HttpAdapter } from "./adapters/http.js";
import { MtprotoAdapter } from "./adapters/mtproto.js";
import { WireguardAdapter } from "./adapters/wireguard-adapter.js";
import { OpenvpnAdapter } from "./adapters/openvpn.js";
import type { PrismaClient } from "@prisma/client";

/**
 * Protocol registry — one instance per adapter, deterministic order
 * matching the staged implementation order in the project contract.
 */
export class ProtocolRegistry {
  private byId = new Map<string, ProtocolAdapter>();
  readonly ordered: ProtocolAdapter[];

  constructor(db: PrismaClient) {
    this.ordered = [
      new VlessAdapter(),
      new VmessAdapter(),
      new TrojanAdapter(),
      new ShadowsocksAdapter(),
      new SocksAdapter(),
      new HttpAdapter(),
      new MtprotoAdapter(db),
      new WireguardAdapter(db),
      new OpenvpnAdapter(),
    ];
    for (const a of this.ordered) this.byId.set(a.id, a);
  }

  get(id: string): ProtocolAdapter | undefined {
    return this.byId.get(id);
  }

  require(id: string): ProtocolAdapter {
    const a = this.byId.get(id);
    if (!a) throw new Error(`unknown protocol: ${id}`);
    return a;
  }

  list(): ProtocolAdapter[] {
    return this.ordered;
  }
}
