import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.js";
import { parseSettingsUpdate, readSettings } from "../src/settings.js";
import { TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

const NOW = new Date("2026-11-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await truncateAll(database.sql);
  harness = createHarness(database);
});

/** One agent with a heartbeat and an event on each of the given days before NOW. */
async function seed(daysAgo: number[]): Promise<void> {
  const agent = await new TestAgent(harness).enroll(database);
  for (const days of daysAgo) {
    harness.now = new Date(NOW.getTime() - days * DAY);
    expect((await agent.heartbeat()).status).toBe(200);
    expect((await agent.events([agent.event("sleep", 1000)])).status).toBe(200);
  }
}

async function counts() {
  const [row] = await database.sql`select
    (select count(*)::int from heartbeat) as heartbeats,
    (select count(*)::int from agent_event) as events,
    (select count(*)::int from agent) as agents`;
  return row;
}

describe("retention", () => {
  it("deletes raw heartbeats and events older than the setting, in batches, and keeps the rest", async () => {
    await seed([40, 35, 31, 29, 2]);
    const result = await runRetention(database.db, NOW, 2);
    expect(result).toMatchObject({ heartbeats: 3, events: 3, complete: true });
    expect(result.cutoff.toISOString()).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
    expect(await counts()).toEqual({ heartbeats: 2, events: 2, agents: 1 });
  });

  it("continues where an interrupted run stopped", async () => {
    await seed([50, 45, 40, 35, 1]);
    // One batch of one row per table, then the run stops as if interrupted.
    const partial = await runRetention(database.db, NOW, 1, 1);
    expect(partial).toMatchObject({ heartbeats: 1, events: 1, complete: false });
    expect(await counts()).toMatchObject({ heartbeats: 4, events: 4 });

    const rest = await runRetention(database.db, NOW, 1, 100);
    expect(rest).toMatchObject({ heartbeats: 3, events: 3, complete: true });
    expect(await counts()).toMatchObject({ heartbeats: 1, events: 1 });
  });

  it("follows the admin setting, which cannot go below 8 days", async () => {
    await seed([12, 9, 7]);
    await database.sql`insert into setting (key, value, updated_by)
      values ('retention_days', '8'::jsonb, 'shlomi')`;
    await runRetention(database.db, NOW);
    expect(await counts()).toMatchObject({ heartbeats: 1, events: 1 });

    expect(parseSettingsUpdate({ retentionDays: 7 }, [])).toEqual({
      ok: false,
      field: "retentionDays",
      locked: false,
    });
    // A value stored out of range falls back to the default instead of deleting too much.
    await database.sql`update setting set value = '1'::jsonb where key = 'retention_days'`;
    expect((await readSettings(database.db)).retentionDays).toBe(30);
  });

  it("does nothing when nothing is old", async () => {
    await seed([1]);
    expect(await runRetention(database.db, NOW)).toMatchObject({
      heartbeats: 0,
      events: 0,
      complete: true,
    });
  });
});
