import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { ConfigError, loadConfig, passkeysSupported, type ServerConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { databaseCheck, readableFileCheck } from "./readiness.js";
import { hasWebAssets } from "./static.js";

/** web/dist, resolved from server/dist/main.js. */
const WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function readConfig(): ServerConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const sql = postgres(config.databaseUrl, {
    max: 10,
    connect_timeout: 5,
    idle_timeout: 60,
    onnotice: () => {},
  });

  try {
    await runMigrations(sql);
  } catch (error) {
    console.error(`database migration failed: ${describe(error)}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  console.log("database migrations are up to date");

  const webRoot = hasWebAssets(WEB_ROOT) ? WEB_ROOT : undefined;
  if (webRoot === undefined) {
    console.warn(`web assets not found at ${WEB_ROOT}; serving the API only`);
  }

  if (!passkeysSupported(config.publicOrigin)) {
    console.warn(
      "MASHKIF_PUBLIC_URL uses an IP address, so passkeys cannot work (browsers need a host name); use http://localhost:<port> in development",
    );
  }
  const db = createDb(sql);
  const auth = createAuth({ db, appKey: config.appKey, publicOrigin: config.publicOrigin });

  const app = createApp({
    readiness: {
      database: databaseCheck(sql),
      geoip: readableFileCheck(config.geoipAsnPath),
    },
    admin: { db, auth, publicOrigin: config.publicOrigin },
    ...(webRoot === undefined ? {} : { webRoot }),
    onReadinessFailure: (name, reason) => console.warn(`readiness check ${name} failed: ${reason}`),
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`listening on port ${info.port}`);
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`received ${signal}, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      sql.end({ timeout: 5 }).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
  console.error(`server failed to start: ${describe(error)}`);
  process.exit(1);
});
