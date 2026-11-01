import { count, desc } from "drizzle-orm";
import { Hono } from "hono";
import { SIGN_IN_RATE_LIMIT } from "../auth/auth.js";
import {
  type AdminSession,
  checkSession,
  sessionDeadlines,
  touchSession,
} from "../auth/session-policy.js";
import { auditLog, user } from "../db/schema.js";
import { fromOwnOrigin, isMutation } from "../http/request-guards.js";
import { type AdminDeps, requestMeta } from "./context.js";
import { completeSetup, validateSetupInput } from "./setup.js";

type AdminEnv = { Variables: { admin: AdminSession } };

const AUDIT_PAGE_SIZE = 50;

/**
 * The admin API (/api/admin/*). Every mutation must come from Mashkif's own
 * origin. Routes other than status, setup, and session need a full session:
 * password plus TOTP, or a passkey with user verification.
 */
export function adminRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (isMutation(c.req.method) && !fromOwnOrigin(c, deps.publicOrigin)) {
      return c.json({ error: "origin_rejected" }, 403);
    }
    return next();
  });

  /** Public: whether the first admin still has to be created. */
  app.get("/status", async (c) => {
    const [row] = await deps.db.select({ n: count() }).from(user);
    return c.json({ setupRequired: (row?.n ?? 0) === 0 });
  });

  /** Public, but needs a setup token from `node server/dist/cli.js setup-token`. */
  app.post("/setup", async (c) => {
    const meta = requestMeta(deps, c);
    const limit = await deps.auth.rateLimitStore.consume(
      `setup:${meta.ipAddress ?? "unknown"}`,
      SIGN_IN_RATE_LIMIT,
    );
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfter ?? SIGN_IN_RATE_LIMIT.window));
      return c.json({ error: "too_many_attempts" }, 429);
    }
    const body: unknown = await c.req.json().catch(() => undefined);
    const fields =
      body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const input = {
      token: typeof fields.token === "string" ? fields.token.trim() : "",
      username: typeof fields.username === "string" ? fields.username.trim() : "",
      password: typeof fields.password === "string" ? fields.password : "",
    };
    const problems: string[] = input.token === "" ? ["setup_token_invalid"] : [];
    problems.push(...validateSetupInput(input));
    if (problems.length > 0) {
      return c.json({ error: problems[0], problems }, 400);
    }
    const result = await completeSetup(deps.db, input, meta);
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "already_set_up" ? 409 : 403);
    }
    return c.json({ username: result.username }, 201);
  });

  /** The current session's state, so the web app knows which page to show. */
  app.get("/session", async (c) => {
    const check = await checkSession(deps.auth, deps.db, c.req.raw.headers);
    if (check.state === "none") {
      return c.json({
        state: "none",
        ...(check.ended === undefined ? {} : { ended: check.ended }),
      });
    }
    await touchSession(deps.db, check);
    const deadlines = sessionDeadlines({ ...check, lastActiveAt: new Date() });
    return c.json({
      state: check.state,
      username: check.username,
      method: check.assurance,
      maxAgeAt: deadlines.maxAgeAt.toISOString(),
      idleAt: deadlines.idleAt.toISOString(),
    });
  });

  // Everything below needs a full session.
  app.use("*", async (c, next) => {
    const check = await checkSession(deps.auth, deps.db, c.req.raw.headers);
    if (check.state === "none") {
      return c.json(
        { error: check.ended === undefined ? "session_required" : "session_ended" },
        401,
      );
    }
    if (check.state !== "full") {
      return c.json({ error: "totp_required" }, 403);
    }
    await touchSession(deps.db, check);
    c.set("admin", check);
    return next();
  });

  /** Recent security events, newest first. */
  app.get("/audit", async (c) => {
    const rows = await deps.db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        actor: auditLog.actor,
        action: auditLog.action,
        ipAddress: auditLog.ipAddress,
        details: auditLog.details,
      })
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE);
    return c.json({ entries: rows.map((row) => ({ ...row, at: row.at.toISOString() })) });
  });

  app.all("*", (c) => c.json({ error: "not_found" }, 404));

  return app;
}
