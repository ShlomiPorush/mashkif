import { randomBytes } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

/**
 * PostgreSQL for integration tests. scripts/verify.sh (server area) starts a
 * throwaway PostgreSQL container and sets MASHKIF_TEST_DATABASE_URL. Without
 * it these tests fail: a missing database is an error, never a pass.
 */
export function testDatabaseUrl(): string {
  const url = process.env.MASHKIF_TEST_DATABASE_URL?.trim() ?? "";
  if (url === "") {
    throw new Error(
      "MASHKIF_TEST_DATABASE_URL is not set. These tests need PostgreSQL: run scripts/verify.sh --area server.",
    );
  }
  return url;
}

export interface TestDatabase {
  sql: Sql;
  /** Connection URL of this database. */
  url: string;
  db: Db;
  /** Drops the database. Call it in afterAll. */
  drop(): Promise<void>;
}

/**
 * A fresh database with every migration applied, private to one test file,
 * so files can run in parallel.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testDatabaseUrl();
  const name = `mashkif_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 10, onnotice: () => {} });
  await runMigrations(sql);
  return {
    sql,
    db: createDb(sql),
    url: url.toString(),
    drop: async () => {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}

/** Empties every table, keeping the schema. */
export async function truncateAll(sql: Sql): Promise<void> {
  await sql`truncate auth_user, auth_session, auth_account, auth_verification, auth_two_factor,
    auth_passkey, admin_setup_token, admin_reset_token, audit_log, enrollment_key, agent, heartbeat,
    agent_event, blocked_range, provider, provider_asn, setting, sync_anchor, agent_boot
    restart identity cascade`;
}
