import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_SYNC_ANCHORS_PER_AGENT } from "../src/db/schema.js";
import { setSetting, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness } from "./support/harness.js";

// The order of a sleep or shutdown event and the heartbeats around it, as
// step 2c of docs/mvp-stage-1.md defines it, and the limitations of
// decision 12 that the owner accepted on 2026-11-06.

let database: TestDatabase;
let harness: Harness;

const T = new Date("2026-11-05T08:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);
const SECOND = 1000;
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
  harness.now = T;
});

async function agentState(agent: TestAgent) {
  const [row] = await database.sql`select last_event_kind, last_event_at, last_seen_at
    from agent where id = ${agent.agentId ?? ""}`;
  return row;
}

async function storedEvent(id: string) {
  const [row] = await database.sql`select time_uncertain, uncertain_reason, occurred_at
    from agent_event where event_id = ${id}`;
  return row;
}

describe("a lifecycle event right after a heartbeat answer", () => {
  it("does not become the state at 0 ms after the anchor (strictly later is required)", async () => {
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).status).toBe(200);
    harness.now = at(SECOND);
    const sleep = agent.event("sleep", 0);
    const reply = await agent.events([sleep]);
    expect(reply.body.results).toEqual([
      { id: sleep.id, status: "accepted", timeUncertain: false },
    ]);
    expect((await agentState(agent))?.last_event_kind).toBeNull();
  });

  it("becomes the state at 1 ms after the anchor, which is why the agent waits for 1 ms", async () => {
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).status).toBe(200);
    harness.now = at(SECOND);
    const reply = await agent.events([agent.event("sleep", 1)]);
    expect(reply.status).toBe(200);
    const state = await agentState(agent);
    expect(state?.last_event_kind).toBe("sleep");
    expect(iso(state?.last_event_at)).toBe(at(1).toISOString());
  });

  it("decision 12 (a): a heartbeat received at or after the event time keeps the agent up", async () => {
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).status).toBe(200);
    harness.now = at(SECOND);
    await agent.events([agent.event("shutdown", SECOND)]);
    expect((await agentState(agent))?.last_event_kind).toBe("shutdown");

    // A heartbeat the agent had given up on arrives at the event time.
    harness.now = at(SECOND);
    expect((await agent.heartbeat({}, { lose: true })).status).toBe(200);
    const state = await agentState(agent);
    // The event is no longer later than the last heartbeat.
    expect(new Date(String(state?.last_event_at)).getTime()).toBeLessThanOrEqual(
      new Date(String(state?.last_seen_at)).getTime(),
    );
  });
});

describe("a server clock that steps back", () => {
  it("decision 12 (b): an event not later than the kept last-seen time leaves the state", async () => {
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).status).toBe(200); // last seen at T
    harness.now = at(-10 * SECOND); // the clock stepped back 10 s
    expect((await agent.heartbeat()).status).toBe(200); // anchor at T - 10 s
    expect(iso((await agentState(agent))?.last_seen_at)).toBe(T.toISOString());

    // The receive clock moves on, so the event is not in the future.
    harness.now = at(SECOND);
    const early = agent.event("sleep", 1); // T - 10 s + 1 ms
    const reply = await agent.events([early]);
    expect(reply.body.results).toEqual([
      { id: early.id, status: "accepted", timeUncertain: false },
    ]);
    expect((await agentState(agent))?.last_event_kind).toBeNull();

    const late = agent.event("sleep", 10 * SECOND + 1); // T + 1 ms
    await agent.events([late]);
    const state = await agentState(agent);
    expect(state?.last_event_kind).toBe("sleep");
    expect(iso(state?.last_event_at)).toBe(at(1).toISOString());
  });

  it("decision 12 (c): an event sent right away after the step is in the future and never takes part in state", async () => {
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).status).toBe(200); // anchor at T
    harness.now = at(-10 * SECOND); // stepped back, and not advanced
    const sleep = agent.event("sleep", 1);
    const reply = await agent.events([sleep]);
    expect(reply.body.results).toEqual([{ id: sleep.id, status: "accepted", timeUncertain: true }]);
    expect((await storedEvent(sleep.id))?.uncertain_reason).toBe("in_future");
    expect((await agentState(agent))?.last_event_kind).toBeNull();
  });
});

describe("the backfill guarantee (decision 10)", () => {
  it("a deferred event retried after its anchor was pruned is stored as time uncertain", async () => {
    await setSetting(database, "events_per_low_agent_hour", 10);
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).status).toBe(200);
    const held = agent.syncId as string;
    harness.now = at(SECOND);
    // The budget is used up; the eleventh event is deferred.
    const first = Array.from({ length: 10 }, (_, i) => agent.event("connectivity_lost", i + 1));
    const deferred = agent.event("connectivity_restored", 20);
    const reply = await agent.events([...first, deferred]);
    expect((reply.body.results as { status: string }[]).at(-1)?.status).toBe("deferred");

    // More than the kept number of newer anchors, then the retry after the window.
    await database.sql`insert into sync_anchor (sync_id, agent_id, boot_id, server_time)
      select 'filler-' || g, ${agent.agentId ?? ""}, ${agent.bootId}, ${at(2 * SECOND).toISOString()}::timestamptz
      from generate_series(1, ${MAX_SYNC_ANCHORS_PER_AGENT - 1}) g`;
    harness.now = at(2 * SECOND);
    expect((await agent.heartbeat({}, { lose: true })).status).toBe(200);
    expect(await database.sql`select 1 from sync_anchor where sync_id = ${held}`).toHaveLength(0);

    // The budget window runs on the database clock; move it into the past so it renews.
    await database.sql`update agent set event_window_start = event_window_start - interval '2 hours'
      where id = ${agent.agentId ?? ""}`;
    harness.now = at(3 * SECOND);
    agent.syncId = held;
    const retried = await agent.events([deferred]);
    expect(retried.body.results).toEqual([
      { id: deferred.id, status: "accepted", timeUncertain: true },
    ]);
    expect((await storedEvent(deferred.id))?.uncertain_reason).toBe("sync_unknown");
  });
});
