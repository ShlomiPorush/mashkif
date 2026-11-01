import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

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

/** An IPv4 address the socket reports as IPv4-mapped IPv6 (::ffff:a.b.c.d) becomes plain IPv4. */
export function normalizeAddress(address: string | undefined): string | undefined {
  if (address === undefined || address === "") {
    return undefined;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutation(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Whether a request comes from a page of Mashkif's own origin. Mutations of
 * admin state require it in addition to SameSite=Strict cookies: the Origin
 * header must equal the public origin, and Sec-Fetch-Site, when the browser
 * sends it, must say same-origin.
 */
export function fromOwnOrigin(c: Context, publicOrigin: string): boolean {
  const origin = c.req.header("origin");
  if (origin !== publicOrigin) {
    return false;
  }
  const site = c.req.header("sec-fetch-site");
  return site === undefined || site === "same-origin";
}
