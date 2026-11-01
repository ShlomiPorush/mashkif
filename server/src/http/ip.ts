import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * The one normalization of IP addresses and ranges, used for client
 * addresses, sites, trusted proxies, and blocked ranges. Node's isIP decides
 * what is an address (strictly: ipaddr.js also accepts forms such as
 * 1.2.3); ipaddr.js turns every IPv4-mapped IPv6 spelling (::ffff:1.2.3.4,
 * ::ffff:102:304) into IPv4 and writes IPv6 in RFC 5952 form without a zone.
 */

function spell(address: ipaddr.IPv4 | ipaddr.IPv6): string {
  return address.kind() === "ipv4"
    ? address.toString()
    : new ipaddr.IPv6((address as ipaddr.IPv6).parts).toRFC5952String();
}

/** The canonical spelling of an IP address, or undefined when it is not one. */
export function canonicalAddress(text: string | undefined): string | undefined {
  const value = text?.trim() ?? "";
  if (value === "" || isIP(value) === 0) {
    return undefined;
  }
  return spell(ipaddr.process(value));
}

/**
 * The canonical network of an address or CIDR range: host bits cleared, and
 * an IPv4-mapped range (prefix 96 or longer) written as IPv4. Returns
 * undefined for anything else.
 */
export function canonicalRange(text: string): string | undefined {
  const [addressText = "", prefixText, extra] = text.trim().split("/");
  if (extra !== undefined || isIP(addressText) === 0) {
    return undefined;
  }
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) {
    return undefined;
  }
  let address: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(addressText);
  let prefix =
    prefixText === undefined ? (address.kind() === "ipv4" ? 32 : 128) : Number(prefixText);
  if (prefix > (address.kind() === "ipv4" ? 32 : 128)) {
    return undefined;
  }
  if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress() && prefix >= 96) {
    address = (address as ipaddr.IPv6).toIPv4Address();
    prefix -= 96;
  }
  const bytes = address.toByteArray().map((byte, index) => {
    const kept = Math.min(8, Math.max(0, prefix - index * 8));
    return byte & ((0xff << (8 - kept)) & 0xff);
  });
  return `${spell(ipaddr.fromByteArray(bytes))}/${prefix}`;
}

/** The 16-bit groups of a canonical IPv6 address. */
export function ipv6Parts(address: string): number[] {
  return ipaddr.IPv6.parse(address).parts;
}
