import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { type AdminSession, checkSession, touchSession } from "../auth/session-policy.js";
import type { Tx } from "../db/client.js";
import { session } from "../db/schema.js";
import type { AdminDeps } from "./context.js";

/**
 * The full admin session of a request (password plus TOTP, or a passkey with
 * user verification), or the refusal: the same codes as the auth routes.
 * Records the activity, which restarts the idle limit.
 */
export async function requireFullSession(
  deps: AdminDeps,
  c: Context,
): Promise<AdminSession | Response> {
  const check = await checkSession(deps.auth, deps.db, c.req.raw.headers);
  if (check.state === "none") {
    return c.json({ error: check.ended === undefined ? "session_required" : "session_ended" }, 401);
  }
  if (check.state !== "full") {
    return c.json({ error: "totp_required" }, 403);
  }
  await touchSession(deps.db, check);
  return check;
}

/** The session ended (for example by reset-admin) before the change could commit. */
export const SESSION_GONE = Symbol("session gone");

/**
 * Runs an admin change and its audit entries in one transaction that holds
 * a share lock on the admin's session row. reset-admin deletes sessions in
 * its own transaction, so it waits for a change already under way, and a
 * change that starts after a reset finds no session and commits nothing.
 */
export async function adminChange<T>(
  deps: AdminDeps,
  admin: AdminSession,
  work: (tx: Tx) => Promise<T>,
): Promise<T | typeof SESSION_GONE> {
  return deps.db.transaction(async (tx) => {
    const [held] = await tx
      .select({ id: session.id })
      .from(session)
      .where(eq(session.id, admin.sessionId))
      .for("share");
    if (held === undefined) {
      return SESSION_GONE;
    }
    return work(tx);
  });
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
