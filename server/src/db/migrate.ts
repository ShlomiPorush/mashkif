import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";

/** Schema and table where Drizzle records applied migrations. */
export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

/** server/drizzle, resolved from this file in both src/db and dist/db. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Applies pending forward-only migrations. A PostgreSQL advisory lock keeps
 * two server processes from migrating at the same time.
 */
export async function runMigrations(sql: Sql, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
  const lock = await sql.reserve();
  try {
    await lock`select pg_advisory_lock(hashtext('mashkif:migrations'))`;
    try {
      await migrate(drizzle(sql), {
        migrationsFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } finally {
      await lock`select pg_advisory_unlock(hashtext('mashkif:migrations'))`;
    }
  } finally {
    lock.release();
  }
}
