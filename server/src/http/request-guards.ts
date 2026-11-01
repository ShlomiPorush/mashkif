import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/** Resolves the client address of a request, or undefined when unknown. */
export type ClientAddressResolver = (c: Context) => string | undefined;

/**
 * The TCP peer address. Forwarded headers are not trusted yet: behind a
 * reverse proxy every client shares the proxy's address, which makes the
 * sign-in rate limit stricter, never weaker. Trusted proxies come with the
 * agent API (MVP stage 1, step 2a).
 */
export const peerAddress: ClientAddressResolver = (c) => {
  try {
    return getConnInfo(c).remote.address ?? undefined;
  } catch {
    return undefined;
  }
};

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
