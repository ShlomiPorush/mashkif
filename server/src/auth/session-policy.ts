import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type SessionAssurance, session } from "../db/schema.js";
import { type Auth, SESSION_IDLE_SECONDS, SESSION_MAX_AGE_SECONDS } from "./auth.js";

/**
 * What a request's session may do.
 * - none: no session, or one that ended.
 * - enrollment: signed in with the password before TOTP exists; may only enroll TOTP.
 * - full: password plus TOTP, or a passkey with user verification.
 */
export type SessionState = "none" | "enrollment" | "full";

export interface AdminSession {
  state: Exclude<SessionState, "none">;
  sessionId: string;
  userId: string;
  username: string;
  assurance: SessionAssurance;
  authenticatedAt: Date;
  lastActiveAt: Date;
}

export type SessionCheck = { state: "none"; ended?: "idle" | "max_age" | "invalid" } | AdminSession;

/** Activity is written at most this often per session. */
const TOUCH_INTERVAL_MS = 30_000;

/**
 * Reads the request's session and applies Mashkif's policy: 12 hours from
 * sign-in, 1 hour idle, and the state its assurance allows. A session that
 * broke a rule is deleted, so it cannot be used again.
 */
export async function checkSession(
  auth: Auth,
  db: Db,
  headers: Headers,
  now = new Date(),
): Promise<SessionCheck> {
  const found = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if (found === null) {
    return { state: "none" };
  }
  const [row] = await db
    .select({
      assurance: session.assurance,
      authenticatedAt: session.authenticatedAt,
      lastActiveAt: session.lastActiveAt,
    })
    .from(session)
    .where(eq(session.id, found.session.id));
  if (row === undefined) {
    return { state: "none" };
  }
  const end = async (ended: "idle" | "max_age" | "invalid"): Promise<SessionCheck> => {
    await db.delete(session).where(eq(session.id, found.session.id));
    return { state: "none", ended };
  };
  if (now.getTime() - row.authenticatedAt.getTime() >= SESSION_MAX_AGE_SECONDS * 1000) {
    return end("max_age");
  }
  if (now.getTime() - row.lastActiveAt.getTime() >= SESSION_IDLE_SECONDS * 1000) {
    return end("idle");
  }
  const user = found.user as typeof found.user & {
    username?: string | null;
    twoFactorEnabled?: boolean | null;
  };
  const totpEnrolled = user.twoFactorEnabled === true;
  let state: AdminSession["state"];
  if (row.assurance === "password" && !totpEnrolled) {
    state = "enrollment";
  } else if (row.assurance !== "password" && totpEnrolled) {
    state = "full";
  } else {
    // A password-only session after TOTP exists, or a strong session after
    // TOTP was removed: neither may continue.
    return end("invalid");
  }
  return {
    state,
    sessionId: found.session.id,
    userId: user.id,
    username: user.username ?? user.name,
    assurance: row.assurance,
    authenticatedAt: row.authenticatedAt,
    lastActiveAt: row.lastActiveAt,
  };
}

/** Records admin activity, which restarts the idle limit. */
export async function touchSession(db: Db, current: AdminSession, now = new Date()): Promise<void> {
  if (now.getTime() - current.lastActiveAt.getTime() < TOUCH_INTERVAL_MS) {
    return;
  }
  await db
    .update(session)
    .set({ lastActiveAt: now })
    .where(and(eq(session.id, current.sessionId), lt(session.lastActiveAt, now)));
}

/** When the session ends at the latest, by either limit. */
export function sessionDeadlines(current: AdminSession): { maxAgeAt: Date; idleAt: Date } {
  return {
    maxAgeAt: new Date(current.authenticatedAt.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
    idleAt: new Date(current.lastActiveAt.getTime() + SESSION_IDLE_SECONDS * 1000),
  };
}
