import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSetting, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await truncateAll(database.sql);
  harness = createHarness(database);
  // A new agent is low: its budget is the low one.
  await setSetting(database, "events_per_low_agent_hour", 10);
  await setSetting(database, "events_per_agent_hour", 100);
});

type Result = { id: string | null; status: string };

function statuses(results: unknown): string[] {
  return (results as Result[]).map((result) => result.status);
}

async function stored(): Promise<number> {
  const [row] = await database.sql`select count(*)::int as n from agent_event`;
  return Number(row?.n);
}

async function windowOf(agent: TestAgent) {
  const [row] = await database.sql`select event_window_start, event_window_count from agent
    where id = ${agent.agentId ?? ""}`;
  return row;
}

/** Events without a sync: accepted with an uncertain time, which is enough here. */
function batch(agent: TestAgent, n: number) {
  return Array.from({ length: n }, () => agent.event("sleep", null));
}

describe("event budget", () => {
  it("initializes the window of a new agent, stores up to the budget, and defers the rest", async () => {
    const agent = await new TestAgent(harness).enroll();
    expect((await windowOf(agent))?.event_window_start).toBeNull();

    const first = await agent.events(batch(agent, 5));
    expect(statuses(first.body.results)).toEqual(new Array(5).fill("accepted"));
    expect(first.body.retryAfterSeconds).toBeUndefined();

    const second = await agent.events(batch(agent, 8));
    expect(statuses(second.body.results)).toEqual([
      ...new Array(5).fill("accepted"),
      ...new Array(3).fill("deferred"),
    ]);
    const retry = Number(second.body.retryAfterSeconds);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(await stored()).toBe(10);
    expect((await windowOf(agent))?.event_window_count).toBe(10);
  });

  it("charges nothing for stored duplicates, repeats within a batch, and invalid events", async () => {
    const agent = await new TestAgent(harness).enroll();
    const kept = batch(agent, 4);
    await agent.events(kept);

    const fresh = agent.event("resume", null);
    const reply = await agent.events([
      ...kept,
      fresh,
      { ...fresh },
      agent.event("teleport", null),
      { ...agent.event("sleep", null), id: "nope" },
    ]);
    expect(statuses(reply.body.results)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "accepted",
      "duplicate",
      "rejected",
      "rejected",
    ]);
    expect((await windowOf(agent))?.event_window_count).toBe(5);
  });

  it("gives a repeat within a batch the result of its first occurrence, also when deferred", async () => {
    const agent = await new TestAgent(harness).enroll();
    await agent.events(batch(agent, 10));
    const late = agent.event("sleep", null);
    const reply = await agent.events([late, { ...late }]);
    expect(statuses(reply.body.results)).toEqual(["deferred", "deferred"]);
  });

  it("lets a first occurrence that failed parsing decide for the later ones of its ID", async () => {
    const agent = await new TestAgent(harness).enroll();
    const good = agent.event("sleep", null);
    const bad = { ...good, kind: "teleport" };
    const reply = await agent.events([bad, good, { ...good }]);
    expect(reply.body.results).toEqual([
      { id: good.id, status: "rejected", error: "event_kind_unknown" },
      { id: good.id, status: "rejected", error: "event_kind_unknown" },
      { id: good.id, status: "rejected", error: "event_kind_unknown" },
    ]);
    expect(await stored()).toBe(0);
    expect((await windowOf(agent))?.event_window_count).toBe(0);
  });

  it("answers a malformed later occurrence of a stored first one as a duplicate", async () => {
    const agent = await new TestAgent(harness).enroll();
    const good = agent.event("sleep", null);
    const reply = await agent.events([
      good,
      { ...good, kind: "teleport" },
      { ...good, bootId: "x" },
    ]);
    expect(reply.body.results).toEqual([
      { id: good.id, status: "accepted", timeUncertain: true },
      { id: good.id, status: "duplicate" },
      { id: good.id, status: "duplicate" },
    ]);
    expect(await stored()).toBe(1);
    expect((await windowOf(agent))?.event_window_count).toBe(1);
  });

  it("never stores more than the budget across concurrent requests of one agent", async () => {
    const agent = await new TestAgent(harness).enroll();
    const replies = await Promise.all([
      agent.events(batch(agent, 8)),
      agent.events(batch(agent, 8)),
      agent.events(batch(agent, 8)),
    ]);
    const accepted = replies
      .flatMap((reply) => statuses(reply.body.results))
      .filter((s) => s === "accepted");
    expect(accepted).toHaveLength(10);
    expect(await stored()).toBe(10);
  });

  it("renews the budget when the window moves to a later hour", async () => {
    const agent = await new TestAgent(harness).enroll();
    await agent.events(batch(agent, 10));
    await database.sql`update agent set event_window_start = date_trunc('hour', now()) - interval '1 hour'
      where id = ${agent.agentId ?? ""}`;
    const reply = await agent.events(batch(agent, 10));
    expect(statuses(reply.body.results)).toEqual(new Array(10).fill("accepted"));
  });

  it("never moves the window back: a later stored window counts, and the retry time runs to its end", async () => {
    const agent = await new TestAgent(harness).enroll();
    // The clock moved back: it is 12:30 and the stored window starts at 14:00,
    // so the budget renews at 15:00, two and a half hours from now.
    await database.sql`update agent set event_window_start = now() + interval '90 minutes',
      event_window_count = 9 where id = ${agent.agentId ?? ""}`;
    const reply = await agent.events(batch(agent, 2));
    expect(statuses(reply.body.results)).toEqual(["accepted", "deferred"]);
    const retry = Number(reply.body.retryAfterSeconds);
    expect(retry).toBeGreaterThan(9000 - 5);
    expect(retry).toBeLessThanOrEqual(9000);
    const [row] = await database.sql`select event_window_start > now() as later, event_window_count
      from agent where id = ${agent.agentId ?? ""}`;
    expect(row).toMatchObject({ later: true, event_window_count: 10 });
  });

  it("initializes a migrated row without a window, reaches the budget, and gets it back in the next window", async () => {
    const agent = await new TestAgent(harness).enroll();
    // A row from before the migration: no window, count 0.
    await database.sql`update agent set event_window_start = null, event_window_count = 0
      where id = ${agent.agentId ?? ""}`;
    const full = await agent.events(batch(agent, 12));
    expect(statuses(full.body.results).filter((s) => s === "deferred")).toHaveLength(2);
    expect(Number(full.body.retryAfterSeconds)).toBeGreaterThanOrEqual(1);
    expect((await windowOf(agent))?.event_window_start).not.toBeNull();
    await database.sql`update agent set event_window_start = event_window_start - interval '1 hour'
      where id = ${agent.agentId ?? ""}`;
    const next = await agent.events(batch(agent, 10));
    expect(statuses(next.body.results)).toEqual(new Array(10).fill("accepted"));
  });

  it("uses the normal budget once the agent is no longer low", async () => {
    const agent = await new TestAgent(harness).enroll();
    await agent.events(batch(agent, 10));
    await database.sql`update agent set trust_tier = 'normal' where id = ${agent.agentId ?? ""}`;
    const reply = await agent.events(batch(agent, 20));
    expect(statuses(reply.body.results)).toEqual(new Array(20).fill("accepted"));
  });
});
