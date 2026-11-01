import type { Context } from "hono";
import { Hono } from "hono";
import { type AdminDeps, requestMeta } from "../admin/context.js";
import { withAdminLock } from "../admin/lock.js";
import { type AuditEntry, writeAudit } from "../audit.js";
import { fromOwnOrigin, isMutation } from "../http/request-guards.js";
import { AUTH_BASE_PATH, CLIENT_ADDRESS_HEADER, priorSession } from "./auth.js";
import {
  type AdminSession,
  checkSession,
  repairInterruptedEnrollment,
  type SessionCheck,
  touchSession,
} from "./session-policy.js";

/**
 * Which sessions may call a Better Auth route:
 * - public: anyone (sign-in steps).
 * - sign-in-or-enrollment: no session, or one that may only enroll TOTP.
 * - enrollment: a session that may only enroll TOTP.
 * - full: password plus TOTP, or a passkey with user verification.
 * - any: with or without a session.
 */
type Access = "public" | "sign-in-or-enrollment" | "enrollment" | "full" | "any";

interface RouteRule {
  method: "GET" | "POST";
  access: Access;
}

/**
 * The only Better Auth routes Mashkif exposes. Every other route, including
 * sign-up, e-mail sign-in, disabling TOTP, backup codes, and account changes,
 * answers 404 before it reaches Better Auth.
 */
export const AUTH_ROUTES: Readonly<Record<string, RouteRule>> = {
  "/sign-in/username": { method: "POST", access: "public" },
  "/two-factor/verify-totp": { method: "POST", access: "sign-in-or-enrollment" },
  "/two-factor/enable": { method: "POST", access: "enrollment" },
  "/passkey/generate-authenticate-options": { method: "GET", access: "public" },
  "/passkey/verify-authentication": { method: "POST", access: "public" },
  "/passkey/generate-register-options": { method: "GET", access: "full" },
  "/passkey/verify-registration": { method: "POST", access: "full" },
  "/passkey/list-user-passkeys": { method: "GET", access: "full" },
  "/passkey/delete-passkey": { method: "POST", access: "full" },
  "/get-session": { method: "GET", access: "any" },
  "/sign-out": { method: "POST", access: "any" },
};

/** Body fields that would weaken the policy. */
const REFUSED_BODY_FIELDS: Readonly<Record<string, string>> = {
  // Skipping TOTP on later sign-ins from this browser.
  "/two-factor/verify-totp": "trustDevice",
  // A new session from a passkey registration, outside the policy.
  "/passkey/verify-registration": "createSession",
};

/** A refusal in the shape the Better Auth client reads (code, message) plus Mashkif's error. */
function refuse(c: Context, status: 400 | 401 | 403 | 404, error: string) {
  return c.json({ error, code: error.toUpperCase(), message: error }, status);
}

function allowed(access: Access, check: SessionCheck): boolean {
  switch (access) {
    case "public":
    case "any":
      return true;
    case "sign-in-or-enrollment":
      return check.state !== "full";
    case "enrollment":
      return check.state === "enrollment";
    case "full":
      return check.state === "full";
  }
}

function refusalFor(access: Access, check: SessionCheck): string {
  if (check.state === "none") {
    return check.ended === undefined ? "session_required" : "session_ended";
  }
  if (access === "full") {
    return "totp_required";
  }
  return "not_allowed";
}

/** The JSON object in a request or response body, without consuming it. */
async function readJson(message: Request | Response): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await message
    .clone()
    .json()
    .catch(() => undefined);
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The username in a Better Auth success body ({ user: { username } }), if any. */
async function usernameIn(response: Response): Promise<string | undefined> {
  const body = await readJson(response);
  const user = body?.user as { username?: unknown } | undefined;
  return typeof user?.username === "string" ? user.username : undefined;
}

/** The audit entry a finished auth request produces, if any. */
async function auditFor(
  path: string,
  response: Response,
  before: SessionCheck,
): Promise<Omit<AuditEntry, "ipAddress" | "userAgent"> | undefined> {
  const ok = response.status === 200;
  const actor = before.state === "none" ? "-" : before.username;
  const failure = (step: string) =>
    response.status === 429
      ? { actor: "-", action: "sign_in.rate_limited" as const, details: { step } }
      : {
          actor: "-",
          action: "sign_in.failed" as const,
          details: { step, status: response.status },
        };
  // The outcome of a credential change whose start was audited.
  const changeFailed = () => ({
    actor,
    action: "credential_change.failed" as const,
    details: { route: path, status: response.status },
  });
  switch (path) {
    case "/sign-in/username": {
      if (!ok) {
        return failure("password");
      }
      const body = await readJson(response);
      if (body?.twoFactorRedirect === true) {
        return undefined; // The TOTP step decides.
      }
      return {
        actor: (await usernameIn(response)) ?? "-",
        action: "sign_in.succeeded",
        details: { method: "password", scope: "totp_enrollment_only" },
      };
    }
    case "/two-factor/verify-totp":
      if (before.state === "enrollment") {
        return ok ? { actor, action: "totp.enrolled" } : changeFailed();
      }
      if (!ok) {
        return failure("totp");
      }
      return {
        actor: (await usernameIn(response)) ?? "-",
        action: "sign_in.succeeded",
        details: { method: "password_totp" },
      };
    case "/passkey/verify-authentication": {
      if (!ok) {
        return failure("passkey");
      }
      return {
        actor: (await usernameIn(response)) ?? "-",
        action: "sign_in.succeeded",
        details: { method: "passkey" },
      };
    }
    case "/passkey/verify-registration":
      return ok ? { actor, action: "passkey.added" } : changeFailed();
    case "/passkey/delete-passkey":
      return ok ? { actor, action: "passkey.removed" } : changeFailed();
    case "/sign-out":
      return ok && before.state !== "none" ? { actor, action: "sign_out" } : undefined;
    default:
      return undefined;
  }
}

/** Asks the browser for user verification too; the server refuses a passkey without it anyway. */
async function requireUserVerification(response: Response): Promise<Response> {
  if (response.status !== 200) {
    return response;
  }
  const options = (await response.clone().json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...options, userVerification: "required" }), {
    status: response.status,
    headers,
  });
}

/**
 * Whether the request changes the admin's credentials. Such requests run under
 * the admin lock, with their session checked again inside it, so reset-admin
 * and setup cannot interleave with them.
 */
function changesCredentials(path: string, before: SessionCheck): boolean {
  return (
    path === "/two-factor/enable" ||
    path === "/passkey/verify-registration" ||
    path === "/passkey/delete-passkey" ||
    (path === "/two-factor/verify-totp" && before.state === "enrollment")
  );
}

/**
 * The single entry to Better Auth (/api/auth/*): the route allowlist, the
 * origin check on every mutation, Mashkif's session policy, the admin lock
 * for credential changes, the client address Better Auth sees, and the audit
 * log.
 */
export function authRoutes(deps: AdminDeps): Hono {
  const app = new Hono();

  app.all("*", async (c) => {
    c.header("Cache-Control", "no-store");
    const path = c.req.path.slice(AUTH_BASE_PATH.length);
    const rule = AUTH_ROUTES[path];
    if (rule === undefined || rule.method !== c.req.method) {
      return refuse(c, 404, "not_found");
    }
    if (isMutation(c.req.method) && !fromOwnOrigin(c, deps.publicOrigin)) {
      return refuse(c, 403, "origin_rejected");
    }
    const refusedField = REFUSED_BODY_FIELDS[path];
    if (refusedField !== undefined) {
      const body = await readJson(c.req.raw);
      if (body !== undefined && body[refusedField] !== undefined && body[refusedField] !== false) {
        return refuse(
          c,
          400,
          `${refusedField.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)}_unsupported`,
        );
      }
    }
    if (path === "/sign-in/username") {
      // Otherwise Better Auth would ask for a TOTP code that cannot be verified.
      await repairInterruptedEnrollment(deps.db);
    }

    // Signing in starts over; any old session is left to its own limits.
    const before: SessionCheck =
      rule.access === "public"
        ? { state: "none" }
        : await checkSession(deps.auth, deps.db, c.req.raw.headers);
    if (!allowed(rule.access, before)) {
      return refuse(c, before.state === "none" ? 401 : 403, refusalFor(rule.access, before));
    }

    const meta = requestMeta(deps, c);
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_ADDRESS_HEADER);
    if (meta.ipAddress !== undefined) {
      headers.set(CLIENT_ADDRESS_HEADER, meta.ipAddress);
    }
    const request = new Request(c.req.raw, { headers });
    const prior =
      before.state === "none"
        ? undefined
        : { assurance: before.assurance, authenticatedAt: before.authenticatedAt };
    const run = () => priorSession.run(prior, () => deps.auth.handler(request));

    let response: Response;
    if (before.state !== "none" && changesCredentials(path, before)) {
      const locked = await withAdminLock(deps.db, async () => {
        // The session may have ended while this request waited, for example
        // by reset-admin.
        const again = await checkSession(deps.auth, deps.db, c.req.raw.headers);
        if (
          again.state === "none" ||
          again.sessionId !== before.sessionId ||
          !allowed(rule.access, again)
        ) {
          return undefined;
        }
        if (path === "/two-factor/enable") {
          await repairInterruptedEnrollment(deps.db, true);
        } else {
          // Committed before the change, so an interrupted change stays visible.
          await writeAudit(deps.db, {
            actor: before.username,
            action: "credential_change.started",
            details: { route: path },
            ...meta,
          });
        }
        return run();
      });
      if (locked === undefined) {
        return refuse(c, 401, "session_ended");
      }
      response = locked;
    } else {
      response = await run();
    }

    if (
      before.state !== "none" &&
      response.status === 200 &&
      path !== "/get-session" &&
      path !== "/sign-out"
    ) {
      await touchSession(deps.db, before as AdminSession);
    }
    const entry = await auditFor(path, response, before);
    if (entry !== undefined) {
      await writeAudit(deps.db, { ...entry, ...meta });
    }
    if (path === "/passkey/generate-authenticate-options") {
      response = await requireUserVerification(response);
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  return app;
}
