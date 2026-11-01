import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AdminDeps } from "./admin/context.js";
import { adminRoutes } from "./admin/routes.js";
import { AUTH_BASE_PATH } from "./auth/auth.js";
import { authRoutes } from "./auth/routes.js";
import { describeSafely } from "./errors.js";
import { agentRoutes } from "./protocol.js";
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  type ReadinessCheckName,
  type ReadinessChecks,
  runReadiness,
} from "./readiness.js";
import { mountWebApp } from "./static.js";

export interface AppOptions {
  readiness: ReadinessChecks;
  readinessTimeoutMs?: number;
  /** Directory with the built web app. When undefined, only the API is served. */
  webRoot?: string;
  /** Called when a readiness check fails. The reason must not contain secrets. */
  onReadinessFailure?: (name: ReadinessCheckName, reason: string) => void;
  /** Admin sign-in and the admin API. When undefined, those routes are 404. */
  admin?: AdminDeps;
}

/** Largest request body the admin and auth routes accept. */
export const ADMIN_BODY_LIMIT_BYTES = 16 * 1024;

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    }),
  );

  // Liveness: the process is up and serving HTTP.
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ status: "ok" }, 200);
  });

  // Readiness: PostgreSQL answers a query and the GeoLite2-ASN file is readable.
  app.get("/readyz", async (c) => {
    c.header("Cache-Control", "no-store");
    const report = await runReadiness(
      options.readiness,
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      options.onReadinessFailure,
    );
    return c.json(report, report.status === "ready" ? 200 : 503);
  });

  app.route("/api/agent", agentRoutes());
  if (options.admin !== undefined) {
    // Read with a byte limit before anything parses the body, also without a
    // Content-Length. The largest legitimate body, a passkey registration,
    // is about 2 KB.
    const limit = bodyLimit({
      maxSize: ADMIN_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    });
    app.use(`${AUTH_BASE_PATH}/*`, limit);
    app.use("/api/admin/*", limit);
    app.route(AUTH_BASE_PATH, authRoutes(options.admin));
    app.route("/api/admin", adminRoutes(options.admin));
  }
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  if (options.webRoot !== undefined) {
    mountWebApp(app, options.webRoot);
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    console.error(`request failed: ${c.req.method} ${c.req.path}: ${describeSafely(error)}`);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
