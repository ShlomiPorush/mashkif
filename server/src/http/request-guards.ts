import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { canonicalAddress } from "./ip.js";

/** Resolves the client address of a request, or undefined when unknown. */
export type ClientAddressResolver = (c: Context) => string | undefined;

/**
 * The TCP peer address. The server resolves the client address through
 * clientAddressResolver (client-address.ts), which reads X-Forwarded-For only
 * from trusted proxies; this is its fallback and the default in tests.
 */
export const peerAddress: ClientAddressResolver = (c) => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
};

/**
 * The canonical client address (see ip.ts): every IPv4-mapped IPv6 spelling
 * becomes IPv4. Undefined when the value is not an IP address.
 */
export function normalizeAddress(address: string | undefined): string | undefined {
  return canonicalAddress(address);
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutation(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Whether a request comes from a page of Mashkif's own origin. Mutations of
 * admin state require it in addition to Better Auth's cookies: the Origin
 * header must equal the public URL, or, while none is set, name the host the
 * request was made to. Sec-Fetch-Site, when the browser sends it, must say
 * same-origin.
 */
export function fromOwnOrigin(c: Context, publicUrl: string | undefined): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined) {
    return false;
  }
  if (publicUrl !== undefined) {
    if (origin !== publicUrl) {
      return false;
    }
  } else {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (host !== c.req.header("host")) {
      return false;
    }
  }
  const site = c.req.header("sec-fetch-site");
  return site === undefined || site === "same-origin";
}
