import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, runMigrations } from "../src/db/migrate.js";
import { testDatabaseUrl } from "./support/database.js";

// The open enrollment migrations (0004 drops the enrollment keys, 0005 adds
// the tier low, the active days, and the event window) run on a database
// that has data at schema 0003: keys, an active and a revoked agent, and
// their dependent rows.

let admin: Sql;
const databases: string[] = [];
let partialFolder: string;

/** A copy of the migrations folder whose journal ends at the given index. */
function migrationsUpTo(lastIndex: number): string {
  const folder = mkdtempSync(join(tmpdir(), "mashkif-migrations-"));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

async function freshDatabase(): Promise<{ sql: Sql; name: string }> {
  const name = `mashkif_migration_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`create database ${name}`);
  databases.push(name);
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  return { sql: postgres(url.toString(), { max: 4, onnotice: () => {} }), name };
}

const ACTIVE = randomUUID();
const REVOKED = randomUUID();

async function seedAt0003(sql: Sql): Promise<void> {
  const [keyA] =
    await sql`insert into enrollment_key (label, key_hash, created_by, expires_at, used_at)
    values ('Office PC', 'hash-a', 'shlomi', now() + interval '1 day', now()) returning id`;
  const [keyB] =
    await sql`insert into enrollment_key (label, key_hash, created_by, expires_at, used_at)
    values ('Old PC', 'hash-b', 'shlomi', now() + interval '1 day', now()) returning id`;
  await sql`insert into enrollment_key (label, key_hash, created_by, expires_at)
    values ('Unused', 'hash-c', 'shlomi', now() + interval '1 day')`;
  await sql`insert into agent (id, install_id, token_hash, enrollment_key_id, label, agent_version)
    values (${ACTIVE}, ${randomUUID()}, 'token-a', ${keyA?.id}, 'Office PC', '0.1.0'),
           (${REVOKED}, ${randomUUID()}, 'token-b', ${keyB?.id}, 'Old PC', '0.1.0')`;
  await sql`update agent set revoked_at = now() where id = ${REVOKED}`;
  const boot = randomUUID();
  await sql`insert into heartbeat (agent_id, received_at, boot_id, sequence, address, site_key,
      infrastructure, interval_reported_seconds, interval_sent_seconds)
    values (${ACTIVE}, now(), ${boot}, 1, '203.0.113.5', '203.0.113.5', 'unknown', 60, 60)`;
  await sql`insert into agent_event (agent_id, event_id, kind, boot_id, time_uncertain, received_at)
    values (${ACTIVE}, ${randomUUID()}, 'sleep', ${boot}, true, now())`;
  await sql`insert into sync_anchor (sync_id, agent_id, boot_id, server_time)
    values ('sync-1', ${ACTIVE}, ${boot}, now())`;
  await sql`insert into agent_boot (agent_id, boot_id, created_at, dropped_events)
    values (${ACTIVE}, ${boot}, now(), 3)`;
}

beforeAll(() => {
  admin = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} });
  partialFolder = migrationsUpTo(3);
});

afterAll(async () => {
  for (const name of databases) {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
  }
  await admin.end({ timeout: 5 });
  rmSync(partialFolder, { recursive: true, force: true });
});

describe("migrations 0004 and 0005 from data at 0003", () => {
  it("drop the keys, keep every other row, keep revoked agents revoked, and add the new columns", async () => {
    const { sql } = await freshDatabase();
    try {
      await runMigrations(sql, partialFolder);
      await seedAt0003(sql);
      await runMigrations(sql);

      const [table] = await sql`select to_regclass('public.enrollment_key') as name`;
      expect(table?.name).toBeNull();
      const columns =
        await sql`select column_name, column_default, is_nullable from information_schema.columns
        where table_name = 'agent' and column_name in
          ('enrollment_key_id', 'active_days', 'last_active_day', 'event_window_start', 'event_window_count')
        order by column_name`;
      expect(columns.map((column) => column.column_name)).toEqual([
        "active_days",
        "event_window_count",
        "event_window_start",
        "last_active_day",
      ]);

      const agents = await sql`select id, label, trust_tier, revoked_at is not null as revoked,
        active_days, last_active_day, event_window_start, event_window_count from agent order by label`;
      expect(agents).toMatchObject([
        { id: ACTIVE, label: "Office PC", trust_tier: "normal", revoked: false, active_days: 0 },
        { id: REVOKED, label: "Old PC", trust_tier: "normal", revoked: true, active_days: 0 },
      ]);
      for (const row of agents) {
        expect(row.last_active_day).toBeNull();
        expect(row.event_window_start).toBeNull();
        expect(row.event_window_count).toBe(0);
      }
      const [counts] = await sql`select
        (select count(*)::int from heartbeat) as heartbeats,
        (select count(*)::int from agent_event) as events,
        (select count(*)::int from sync_anchor) as anchors,
        (select count(*)::int from agent_boot) as boots`;
      expect(counts).toEqual({ heartbeats: 1, events: 1, anchors: 1, boots: 1 });

      // The tier low exists; an unknown tier is still refused.
      await sql`update agent set trust_tier = 'low' where id = ${ACTIVE}`;
      await expect(
        sql`update agent set trust_tier = 'gold' where id = ${ACTIVE}`,
      ).rejects.toThrow();
      // The install ID stays unique over all rows, revoked ones included.
      const [revoked] = await sql`select install_id from agent where id = ${REVOKED}`;
      await expect(
        sql`insert into agent (id, install_id, token_hash, agent_version)
          values (${randomUUID()}, ${revoked?.install_id}, 'token-c', '0.1.0')`,
      ).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("finish on a second run after a run was interrupted", async () => {
    const { sql, name } = await freshDatabase();
    const blocker = await sql.reserve();
    // A client whose statements give up after waiting 500 ms for a lock.
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${name}`;
    const impatient = postgres(url.toString(), {
      max: 2,
      onnotice: () => {},
      connection: { lock_timeout: 500 },
    });
    try {
      await runMigrations(sql, partialFolder);
      await seedAt0003(sql);

      // Another session holds the agent table, so the migration stops in the
      // middle of 0004, as a crashed or killed run would.
      await blocker`begin`;
      await blocker`lock table agent in access exclusive mode`;
      await expect(runMigrations(impatient)).rejects.toThrow();
      await blocker`rollback`;

      // Drizzle runs the pending migrations in one transaction: nothing of
      // 0004 stayed behind, and a second run completes.
      const [still] = await sql`select to_regclass('public.enrollment_key') as name`;
      expect(still?.name).not.toBeNull();
      await runMigrations(sql);
      const [gone] = await sql`select to_regclass('public.enrollment_key') as name`;
      expect(gone?.name).toBeNull();
      const [count] = await sql`select count(*)::int as agents from agent`;
      expect(count?.agents).toBe(2);
    } finally {
      blocker.release();
      await impatient.end({ timeout: 5 });
      await sql.end({ timeout: 5 });
    }
  }, 30_000);
});
