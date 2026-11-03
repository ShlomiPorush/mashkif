import { readdirSync, readFileSync } from "node:fs";
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
    const agent = new TestAgent(harness);
    agent.token = String(register.token);
    const registered = await agent.post("/register", register);
    expect(registered.status).toBe(201);

    const recorded = await agent.post("/heartbeat", heartbeat);
    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({ nextIntervalSeconds: 60 });
  });
});
