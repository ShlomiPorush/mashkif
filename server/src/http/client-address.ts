import { BlockList, isIP } from "node:net";
import { type ClientAddressResolver, normalizeAddress, peerAddress } from "./request-guards.js";

/**
 * Parses MASHKIF_TRUSTED_PROXIES: addresses or CIDR ranges, separated by
 * commas or white space. Returns the entries, or the first invalid one.
 */
export function parseTrustedProxies(
  text: string,
): { ok: true; entries: string[] } | { ok: false; invalid: string } {
  const entries = text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    if (subnetOf(entry) === undefined) {
      return { ok: false, invalid: entry };
    }
  }
  return { ok: true, entries };
}

type Subnet = { address: string; prefix: number; family: "ipv4" | "ipv6" };

function subnetOf(entry: string): Subnet | undefined {
  const [address = "", prefixText, extra] = entry.split("/");
  if (extra !== undefined) {
    return undefined;
  }
  const version = isIP(address);
  if (version === 0) {
    return undefined;
  }
  const max = version === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) {
    return undefined;
  }
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (prefix > max) {
    return undefined;
  }
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

function blockListOf(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const subnet = subnetOf(entry);
    if (subnet !== undefined) {
      list.addSubnet(subnet.address, subnet.prefix, subnet.family);
    }
  }
  return list;
}

function contains(list: BlockList, address: string): boolean {
  const version = isIP(address);
  return version !== 0 && list.check(address, version === 4 ? "ipv4" : "ipv6");
}

/**
 * The client address of a request. X-Forwarded-For counts only when the TCP
 * peer is a trusted proxy; then the right-most address that is not a trusted
 * proxy is the client. Each proxy appends the address it received the
 * request from, so only the part added by trusted proxies is believed and
 * anything a client wrote further left is ignored. A malformed entry stops
 * the walk at the last trusted hop, which is stricter for rate limits, never
 * weaker. With no trusted proxies this is the TCP peer.
 *
 * The admin sign-in rate limits, Better Auth's session records, the agent
 * rate limits, and the agent's site all use this one address.
 */
export function clientAddressResolver(
  trustedProxies: readonly string[],
  peer: ClientAddressResolver = peerAddress,
): ClientAddressResolver {
  const trusted = blockListOf(trustedProxies);
  return (c) => {
    const direct = normalizeAddress(peer(c));
    if (direct === undefined || trustedProxies.length === 0 || !contains(trusted, direct)) {
      return direct;
    }
    // Headers.get joins repeated headers with ", " in order.
    const header = c.req.raw.headers.get("x-forwarded-for");
    if (header === null || header.trim() === "") {
      return direct;
    }
    const hops = header.split(",");
    let client = direct;
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = normalizeAddress(hops[index]?.trim());
      if (hop === undefined || isIP(hop) === 0) {
        return client;
      }
      client = hop;
      if (!contains(trusted, hop)) {
        return hop;
      }
    }
    // Every hop is a trusted proxy: the left-most one is the client.
    return client;
  };
}
