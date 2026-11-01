import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema> & { $client: Sql };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A Drizzle database on an existing postgres.js connection pool. */
export function createDb(sql: Sql): Db {
  return drizzle(sql, { schema });
}
