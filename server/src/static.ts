import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/** True when a built web app (index.html) exists in the directory. */
export function hasWebAssets(webRoot: string): boolean {
  return existsSync(join(webRoot, "index.html"));
}

const HASHED_ASSET = /^\/assets\//;
const FILE_LIKE = /\/[^/]+\.[A-Za-z0-9]+$/;

/**
 * Serves the built web app from webRoot on the same origin. Hashed files under
 * /assets/ are cached for a year; everything else must be revalidated. Paths
 * that look like client-side routes fall back to index.html; missing files and
 * anything under /api/ stay 404.
 */
export function mountWebApp(app: Hono, webRoot: string): void {
  app.use("*", async (c, next) => {
    await next();
    const isRead = c.req.method === "GET" || c.req.method === "HEAD";
    if (isRead && c.res.status === 200 && !c.res.headers.has("Cache-Control")) {
      c.header(
        "Cache-Control",
        HASHED_ASSET.test(c.req.path) ? "public, max-age=31536000, immutable" : "no-cache",
      );
    }
  });

  app.get("*", serveStatic({ root: webRoot }));

  const indexHtml = serveStatic({ root: webRoot, path: "index.html" });
  app.get("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api/") || HASHED_ASSET.test(path) || FILE_LIKE.test(path)) {
      return next();
    }
    return indexHtml(c, next);
  });
}
