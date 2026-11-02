import { isIPv4 } from "node:net";
import { canonicalAddress, ipv6Parts } from "../http/ip.js";

/**
 * The site of a public address (decision D8): an IPv4 address itself, or the
 * /64 network of an IPv6 address, in one canonical spelling. Every
 * IPv4-mapped IPv6 spelling counts as its IPv4 address. Returns undefined
 * for anything that is not an IP address.
 */
export function siteKeyOf(address: string): string | undefined {
  const canonical = canonicalAddress(address);
  if (canonical === undefined) {
    return undefined;
  }
  if (isIPv4(canonical)) {
    return canonical;
  }
  const prefix = ipv6Parts(canonical)
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":");
  return `${prefix}::/64`;
}
