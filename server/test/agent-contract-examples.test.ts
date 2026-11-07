import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness } from "./support/harness.js";

// contracts/examples/agent-<version>/ holds the requests of every agent build
// that was ever installed. The server must keep accepting all of them.
const examplesRoot = fileURLToPath(new URL("../../contracts/examples/", import.meta.url));

type Example = { value: Record<string, unknown> };

function readExample(dir: string, name: string): Record<string, unknown> {
  const example = JSON.parse(readFileSync(`${examplesRoot}${dir}/${name}`, "utf8")) as Example;
  return example.value;
}

const agentBuilds = readdirSync(examplesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("agent-"))
  .map((entry) => entry.name)
  .sort();

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
});

describe("request examples of every agent build", () => {
  it("has at least one agent build", () => {
    expect(agentBuilds.length).toBeGreaterThan(0);
  });

  it.each(agentBuilds)("accepts the register and heartbeat requests of %s", async (build) => {
    const register = readExample(build, "register-request.json");
    const heartbeat = readExample(build, "heartbeat-request.json");
    // The example holds a placeholder that never authenticates; every run
    // registers a token of its own from the random TestAgent.
    const agent = new TestAgent(harness);
    const registered = await agent.post("/register", { ...register, token: agent.token });
    expect(registered.status).toBe(201);

    const recorded = await agent.post("/heartbeat", heartbeat);
    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({ nextIntervalSeconds: 60 });
  });

  const buildsWithEvents = agentBuilds.filter((build) =>
    existsSync(`${examplesRoot}${build}/events-request.json`),
  );

  it.each(buildsWithEvents)("accepts the events request of %s", async (build) => {
    const register = readExample(build, "register-request.json");
    const events = readExample(build, "events-request.json");
    const agent = new TestAgent(harness);
    expect((await agent.post("/register", { ...register, token: agent.token })).status).toBe(201);
    expect(
      (await agent.post("/heartbeat", readExample(build, "heartbeat-request.json"))).status,
    ).toBe(200);

    const reply = await agent.post("/events", events);
    expect(reply.status).toBe(200);
    const sent = events.events as { id: string }[];
    // The example's sync IDs are unknown to this server: every event is
    // stored, as time uncertain.
    expect(reply.body.results).toEqual(
      sent.map((event) => ({ id: event.id, status: "accepted", timeUncertain: true })),
    );
    const dropped = events.droppedEvents as { bootId: string; count: number };
    const [row] = await database.sql`select dropped_events from agent_boot
      where boot_id = ${dropped.bootId}`;
    expect(Number(row?.dropped_events)).toBe(dropped.count);
  });
});
