import { BlockList, isIP } from "node:net";
import { canonicalRange } from "./ip.js";
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
  const canonical: string[] = [];
  for (const entry of entries) {
    const range = canonicalRange(entry);
    if (range === undefined) {
      return { ok: false, invalid: entry };
    }
    canonical.push(range);
  }
  return { ok: true, entries: canonical };
}

function blockListOf(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const range = canonicalRange(entry);
    if (range !== undefined) {
      const [address = "", prefix = ""] = range.split("/");
      list.addSubnet(address, Number(prefix), isIP(address) === 4 ? "ipv4" : "ipv6");
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
 * The agent rate limits, the agent's site, and admin audit entries use this
 * address. Better Auth resolves its own (sign-in rate limits, session records)
 * through advanced.ipAddress, configured from the same trusted proxies but
 * separate; without trusted proxies it applies its own documented behavior.
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
