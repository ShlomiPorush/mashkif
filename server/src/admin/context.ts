import type { Context } from "hono";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db/client.js";
import {
  type ClientAddressResolver,
  normalizeAddress,
  peerAddress,
} from "../http/request-guards.js";

/** Everything the admin and auth routes need. */
export interface AdminDeps {
  db: Db;
  auth: Auth;
  /** Origin of the web app, for example https://mashkif.co.il. */
  publicOrigin: string;
  /** Defaults to the TCP peer address. */
  clientAddress?: ClientAddressResolver;
}

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

/** The error body of every admin and auth refusal: a stable code the web app maps to text. */
export type ErrorBody = { error: string };
