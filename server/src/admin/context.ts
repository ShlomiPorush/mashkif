import type { Context } from "hono";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db/client.js";
import type { AsnLookup } from "../geoip.js";
import {
  type ClientAddressResolver,
  normalizeAddress,
  peerAddress,
} from "../http/request-guards.js";

/** Everything the admin routes need. */
export interface AdminDeps {
  db: Db;
  auth: Auth;
  /** BETTER_AUTH_SECRET, which also encrypts stored secrets such as the SMTP password. */
  authSecret: string;
  /** The public URL; undefined means the origin the request was made to. */
  publicUrl: string | undefined;
  /** Environment overrides of settings; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the TCP peer address. */
  clientAddress?: ClientAddressResolver;
  /** For the GeoLite2-ASN status in the settings. */
  asn?: AsnLookup;
  /** Test seams. */
  testHooks?: { afterSettingsRead?: () => Promise<void> };
}

/** The signed-in admin of a request. */
export interface AdminIdentity {
  username: string;
}

/** Hono variables of an admin request. */
export type AdminEnv = { Variables: { admin: AdminIdentity } };

export interface RequestMeta {
  ipAddress: string | undefined;
  userAgent: string | undefined;
}

export function requestMeta(deps: AdminDeps, c: Context): RequestMeta {
  return {
    ipAddress: normalizeAddress((deps.clientAddress ?? peerAddress)(c)),
    userAgent: c.req.header("user-agent"),
  };
}
