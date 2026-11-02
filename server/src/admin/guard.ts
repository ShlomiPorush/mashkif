import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Tx } from "../db/client.js";
import type { AdminDeps, AdminEnv } from "./context.js";

/**
 * Admits a request to Mashkif's admin API: Better Auth must find a session,
 * and the admin must have TOTP enabled. Better Auth's own routes enforce
 * their own requirements and do not pass through here.
 */
export function requireAdmin(deps: AdminDeps) {
  return createMiddleware<AdminEnv>(async (c, next) => {
    const found = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (found === null) {
      return c.json({ error: "session_required" }, 401);
    }
    const user = found.user as typeof found.user & {
      username?: string | null;
      twoFactorEnabled?: boolean | null;
    };
    if (user.twoFactorEnabled !== true) {
      return c.json({ error: "totp_required" }, 403);
    }
    c.set("admin", { username: user.username ?? user.name });
    return next();
  });
}

/** Runs an admin change and its audit entries in one transaction. */
export async function adminChange<T>(deps: AdminDeps, work: (tx: Tx) => Promise<T>): Promise<T> {
  return deps.db.transaction(work);
}
/** The JSON object of a request body; an empty object for anything else. */
export async function jsonFields(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A positive integer id from a path parameter, or undefined. */
export function idParam(c: Context, name = "id"): number | undefined {
  const text = c.req.param(name) ?? "";
  return /^[1-9]\d{0,14}$/.test(text) ? Number(text) : undefined;
}

/** A UUID from a path parameter, lowercased, or undefined. */
export function uuidParam(c: Context, name = "id"): string | undefined {
  const text = c.req.param(name) ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ? text.toLowerCase()
    : undefined;
}

export function uniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
  }
  return false;
}
