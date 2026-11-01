import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_REQUEST } from "../src/agent/routes.js";
import { TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

const T0 = new Date("2026-11-01T08:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The shared client returns timestamps as text (Drizzle turns off date parsing). */
const iso = (value: unknown) => new Date(String(value)).toISOString();

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await truncateAll(database.sql);
  harness = createHarness(database);
  harness.now = T0;
});

async function storedEvents() {
  return database.sql`select event_id, kind, occurred_at, time_uncertain, uncertain_reason,
    agent_time from agent_event order by id`;
}

async function agentState(id: string | undefined) {
  const [row] = await database.sql`select last_event_kind, last_event_at, last_seen_at,
    dropped_events from agent where id = ${id ?? ""}`;
  return row;
}

/** An enrolled agent whose first heartbeat was received at T0. */
async function syncedAgent(): Promise<TestAgent> {
  const agent = await new TestAgent(harness).enroll(database);
  expect((await agent.heartbeat()).status).toBe(200);
  return agent;
}

describe("events", () => {
  it("computes the time from the recorded sync time plus the monotonic elapsed time", async () => {
    const agent = await syncedAgent();
    harness.now = at(10 * MINUTE);
    const lost = agent.event("connectivity_lost", 2 * MINUTE);
    const restored = agent.event("connectivity_restored", 7 * MINUTE);
    const reply = await agent.events([lost, restored]);
    expect(reply.status).toBe(200);
    expect(reply.body.results).toEqual([
      { id: lost.id, status: "accepted", timeUncertain: false },
      { id: restored.id, status: "accepted", timeUncertain: false },
    ]);
    const rows = await storedEvents();
    expect(rows.map((row) => [row.kind, iso(row.occurred_at)])).toEqual([
      ["connectivity_lost", at(2 * MINUTE).toISOString()],
      ["connectivity_restored", at(7 * MINUTE).toISOString()],
    ]);
  });

  it("ignores wall-clock jumps on the PC", async () => {
    const agent = await syncedAgent();
    harness.now = at(10 * MINUTE);
    // The PC clock jumped a year back and a day forward; only the monotonic time counts.
    const reply = await agent.events([
      agent.event("sleep", 3 * MINUTE, { agentTime: "2025-11-01T08:03:00.000Z" }),
      agent.event("resume", 4 * MINUTE, { agentTime: "2026-11-02T08:04:00.000Z" }),
    ]);
    expect(reply.status).toBe(200);
    const rows = await storedEvents();
    expect(rows.map((row) => iso(row.occurred_at))).toEqual([
      at(3 * MINUTE).toISOString(),
      at(4 * MINUTE).toISOString(),
    ]);
    expect(iso(rows[0]?.agent_time)).toBe("2025-11-01T08:03:00.000Z");
    expect(rows.every((row) => row.time_uncertain === false)).toBe(true);
  });

  it("marks an event later than its receipt as time uncertain (a future time)", async () => {
    const agent = await syncedAgent();
    harness.now = at(5 * MINUTE);
    const reply = await agent.events([agent.event("connectivity_lost", 6 * MINUTE)]);
    expect((reply.body.results as unknown[])[0]).toMatchObject({ timeUncertain: true });
    expect((await storedEvents())[0]).toMatchObject({
      time_uncertain: true,
      uncertain_reason: "in_future",
    });
  });

  it("marks an event older than 7 days as time uncertain", async () => {
    const agent = await syncedAgent();
    harness.now = at(8 * DAY);
    await agent.events([agent.event("connectivity_lost", 30 * MINUTE)]);
    expect((await storedEvents())[0]).toMatchObject({
      time_uncertain: true,
      uncertain_reason: "too_old",
    });
  });

  it("marks events after a reboot while offline (no sync in this boot) as time uncertain", async () => {
    const agent = await syncedAgent();
    harness.now = at(30 * MINUTE);
    const shutdown = agent.event("shutdown", 5 * MINUTE);
    agent.reboot();
    const lost = agent.event("connectivity_lost", null);
    // A sync from the previous boot is no good either: the monotonic clock restarted.
    const stale = { ...agent.event("connectivity_restored", 60_000), syncId: "x" };
    const fromOldBoot = { ...agent.event("connectivity_restored", 1000) };
    const [row] = await database.sql`select sync_id from heartbeat`;
    fromOldBoot.syncId = String(row?.sync_id);
    const reply = await agent.events([shutdown, lost, stale, fromOldBoot]);
    expect(
      (reply.body.results as { timeUncertain: boolean }[]).map((r) => r.timeUncertain),
    ).toEqual([false, true, true, true]);
    const rows = await storedEvents();
    expect(rows.map((item) => item.uncertain_reason)).toEqual([
      null,
      "no_sync",
      "sync_unknown",
      "other_boot",
    ]);
    expect(rows.slice(1).map((item) => item.occurred_at)).toEqual([null, null, null]);
  });

  it("answers a mixed batch per event, so bad events never block good ones", async () => {
    const agent = await syncedAgent();
    harness.now = at(10 * MINUTE);
    const good = agent.event("sleep", MINUTE);
    const repeated = { ...good };
    const unknownKind = agent.event("teleport", MINUTE);
    const noId = { ...agent.event("resume", MINUTE), id: "nope" };
    const halfSync = { ...agent.event("resume", MINUTE), elapsedMs: null };
    const reply = await agent.events([good, repeated, unknownKind, noId, halfSync, 42]);
    expect(reply.status).toBe(200);
    expect(reply.body.results).toEqual([
      { id: good.id, status: "accepted", timeUncertain: false },
      { id: good.id, status: "duplicate" },
      { id: unknownKind.id, status: "rejected", error: "event_kind_unknown" },
      { id: null, status: "rejected", error: "event_invalid" },
      { id: halfSync.id, status: "rejected", error: "event_invalid" },
      { id: null, status: "rejected", error: "event_invalid" },
    ]);
    // A resend of the whole batch: the accepted event is now a duplicate.
    const again = await agent.events([good]);
    expect(again.body.results).toEqual([{ id: good.id, status: "duplicate" }]);
    expect(await storedEvents()).toHaveLength(1);
  });

  it(`refuses more than ${MAX_EVENTS_PER_REQUEST} events and a body over 64 KB`, async () => {
    const agent = await syncedAgent();
    const many = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => ({ id: randomUUID() }));
    expect(await agent.events(many)).toMatchObject({
      status: 413,
      body: { error: "too_many_events" },
    });
    // 300 events of about 400 bytes: within the count limit, over the size limit.
    const big = Array.from({ length: 300 }, () => ({
      ...agent.event("sleep", MINUTE),
      padding: "x".repeat(250),
    }));
    expect(await agent.events(big)).toMatchObject({
      status: 413,
      body: { error: "payload_too_large" },
    });
    expect(await storedEvents()).toHaveLength(0);
  });

  it("accepts a batch that fills the 64 KB limit", async () => {
    const agent = await syncedAgent();
    harness.now = at(10 * MINUTE);
    // 64 KB binds before 500 events: 350 events with sync IDs fit.
    const events = Array.from({ length: 350 }, (_, i) =>
      agent.event(i % 2 === 0 ? "connectivity_lost" : "connectivity_restored", i * 10),
    );
    expect(JSON.stringify({ events }).length).toBeLessThan(64 * 1024);
    const reply = await agent.events(events);
    expect(reply.status).toBe(200);
    expect(reply.body.results).toHaveLength(350);
    expect(await storedEvents()).toHaveLength(350);
  });

  it("never lets a late event change the state of an agent with a newer heartbeat", async () => {
    const agent = await syncedAgent();
    harness.now = at(10 * MINUTE);
    // A heartbeat at minute 10 arrives before the backlog from minute 3.
    await agent.heartbeat();
    const first = agent.syncId;
    harness.now = at(11 * MINUTE);
    const late = { ...agent.event("sleep", 0), syncId: null as string | null, elapsedMs: 0 };
    const [initial] = await database.sql`select sync_id from heartbeat order by id limit 1`;
    late.syncId = String(initial?.sync_id);
    late.elapsedMs = 3 * MINUTE;
    expect((await agent.events([late])).status).toBe(200);
    expect((await agentState(agent.agentId))?.last_event_kind).toBeNull();

    // An event after the latest heartbeat becomes the current state.
    agent.syncId = first;
    harness.now = at(20 * MINUTE);
    await agent.events([agent.event("shutdown", 5 * MINUTE)]);
    const state = await agentState(agent.agentId);
    expect(state?.last_event_kind).toBe("shutdown");
    expect(iso(state?.last_event_at)).toBe(at(15 * MINUTE).toISOString());

    // An older event than the current one does not replace it.
    await agent.events([agent.event("sleep", 2 * MINUTE)]);
    expect((await agentState(agent.agentId))?.last_event_kind).toBe("shutdown");
  });

  it("adds up the events the agent reports it dropped", async () => {
    const agent = await syncedAgent();
    await agent.events([], 3);
    await agent.events([], 4);
    expect(Number((await agentState(agent.agentId))?.dropped_events)).toBe(7);
    expect((await agent.events([], -1)).body).toMatchObject({
      error: "request_invalid",
      field: "droppedEvents",
    });
  });

  it("refuses a body without an events array, and a revoked or blocked agent", async () => {
    const agent = await syncedAgent();
    expect((await agent.post("/events", { events: "no" })).body).toMatchObject({
      error: "request_invalid",
      field: "events",
    });
    await database.sql`update agent set trust_tier = 'blocked'`;
    expect((await agent.events([agent.event("sleep", 1)])).body.error).toBe("agent_blocked");
    await database.sql`update agent set revoked_at = now()`;
    expect((await agent.events([agent.event("sleep", 1)])).body.error).toBe("agent_revoked");
    expect(await storedEvents()).toHaveLength(0);
  });
});
