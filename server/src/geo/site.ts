import { isIPv4, isIPv6 } from "node:net";

/** The eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) {
    text = text.slice(0, zone);
  }
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? [] : new Array(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((group) => Number.parseInt(group, 16));
}

/**
 * The site of a public address (decision D8): an IPv4 address itself, or the
 * /64 network of an IPv6 address, in one canonical spelling. Returns
 * undefined for anything that is not an IP address.
 */
export function siteKeyOf(address: string): string | undefined {
  if (isIPv4(address)) {
    return address;
  }
  if (!isIPv6(address)) {
    return undefined;
  }
  const prefix = ipv6Groups(address)
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":");
  return `${prefix}::/64`;
}
