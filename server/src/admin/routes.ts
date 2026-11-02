import { count } from "drizzle-orm";
import { Hono } from "hono";
import { user } from "../db/schema.js";
import { fromOwnOrigin, isMutation } from "../http/request-guards.js";
import type { AdminDeps, AdminEnv } from "./context.js";
import { requireAdmin } from "./guard.js";
import { mountManagementRoutes } from "./manage.js";

/**
 * The admin API (/api/admin/*). Every mutation must come from Mashkif's own
 * origin. Everything but /status needs a Better Auth session of an admin with
 * TOTP enabled.
 */
export function adminRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (isMutation(c.req.method) && !fromOwnOrigin(c, deps.publicUrl)) {
      return c.json({ error: "origin_rejected" }, 403);
    }
    return next();
  });

  /** Public: whether the first admin still has to be created. */
  app.get("/status", async (c) => {
    const [row] = await deps.db.select({ n: count() }).from(user);
    return c.json({ setupRequired: (row?.n ?? 0) === 0 });
  });

  app.use("*", requireAdmin(deps));
  mountManagementRoutes(app, deps);

  app.all("*", (c) => c.json({ error: "not_found" }, 404));

  return app;
}
