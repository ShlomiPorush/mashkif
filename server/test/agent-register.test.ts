import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/admin/setup.js";
import { REGISTER_RATE_LIMIT } from "../src/agent/routes.js";
import { insertKey, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness, pauseOnce } from "./support/harness.js";

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

async function agentRows() {
  return database.sql`select id, install_id, token_hash, enrollment_key_id, label, agent_version,
    os_version from agent order by registered_at`;
}

async function keyRow() {
  const [row] = await database.sql`select used_at, revoked_at from enrollment_key`;
  return row;
}

describe("register", () => {
  it("uses the key and creates the agent, storing only the token hash", async () => {
    const agent = new TestAgent(harness);
    const key = await insertKey(database, { label: "Office PC" });
    const reply = await agent.register(key);
    expect(reply.status).toBe(201);
    expect(reply.headers.get("mashkif-protocol-version")).toBe("1");
    expect(reply.body).toMatchObject({ heartbeatIntervalSeconds: 60 });
    expect(Date.parse(String(reply.body.serverTime))).not.toBeNaN();

    const [row] = await agentRows();
    expect(row).toMatchObject({
      id: reply.body.agentId,
      install_id: agent.installId,
      token_hash: hashToken(agent.token),
      label: "Office PC",
      agent_version: "0.1.0",
      os_version: "10.0.26100",
    });
    // The token itself is stored nowhere.
    const dump = await database.sql`select row_to_json(a)::text as json from agent a`;
    expect(dump[0]?.json).not.toContain(agent.token);
    expect((await keyRow())?.used_at).not.toBeNull();
    const [audit] = await database.sql`select actor, action, ip_address, details from audit_log`;
    expect(audit).toMatchObject({
      actor: "agent",
      action: "agent.registered",
      ip_address: agent.address,
      details: { agentId: reply.body.agentId },
    });
  });

  it("answers a retry after a lost response with the same agent, also after the key expired", async () => {
    const agent = new TestAgent(harness);
    const key = await insertKey(database);
    const first = await agent.register(key);
    expect(first.status).toBe(201);

    const again = await agent.register(key);
    expect(again).toMatchObject({ status: 200, body: { agentId: first.body.agentId } });

    harness.now = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const late = await agent.register(key);
    expect(late).toMatchObject({ status: 200, body: { agentId: first.body.agentId } });
    expect(await agentRows()).toHaveLength(1);
  });

  it("refuses another install or another token on a used key", async () => {
    const agent = new TestAgent(harness);
    const key = await insertKey(database);
    expect((await agent.register(key)).status).toBe(201);

    const other = new TestAgent(harness);
    expect(await other.register(key)).toMatchObject({
      status: 403,
      body: { error: "enrollment_key_used" },
    });
    const sameInstallOtherToken = new TestAgent(harness);
    sameInstallOtherToken.installId = agent.installId;
    expect((await sameInstallOtherToken.register(key)).body.error).toBe("enrollment_key_used");
  });

  it("gives the last use of a key to exactly one of two racing registrations", async () => {
    const key = await insertKey(database);
    const racers = [new TestAgent(harness), new TestAgent(harness), new TestAgent(harness)];
    const replies = await Promise.all(racers.map((agent) => agent.register(key)));
    const statuses = replies.map((reply) => reply.status).sort();
    expect(statuses).toEqual([201, 403, 403]);
    for (const reply of replies.filter((item) => item.status === 403)) {
      expect(reply.body.error).toBe("enrollment_key_used");
    }
    expect(await agentRows()).toHaveLength(1);
  });

  it("answers both copies of a registration sent twice at once with the same agent", async () => {
    const agent = new TestAgent(harness);
    const key = await insertKey(database);
    const [a, b] = await Promise.all([agent.register(key), agent.register(key)]);
    expect([a?.status, b?.status].sort()).toEqual([200, 201]);
    expect(a?.body.agentId).toBe(b?.body.agentId);
    expect(await agentRows()).toHaveLength(1);
  });

  it("leaves the key unused when a registration is interrupted after using it", async () => {
    let fail = true;
    harness = createHarness(database, undefined, undefined, {
      registerHooks: {
        afterKeyUse: async () => {
          if (fail) {
            throw new Error("process killed");
          }
        },
      },
    });
    const agent = new TestAgent(harness);
    const key = await insertKey(database);
    expect((await agent.register(key)).status).toBe(500);
    expect((await keyRow())?.used_at).toBeNull();
    expect(await agentRows()).toHaveLength(0);
    expect(await database.sql`select 1 from audit_log`).toHaveLength(0);

    fail = false;
    expect((await agent.register(key)).status).toBe(201);
  });

  it("makes a second registration wait while the first holds the key", async () => {
    const pause = pauseOnce();
    harness = createHarness(database, undefined, undefined, {
      registerHooks: { afterKeyUse: pause.hook },
    });
    const key = await insertKey(database);
    const first = new TestAgent(harness);
    const second = new TestAgent(harness);
    const firstReply = first.register(key);
    await pause.atPause;
    const secondReply = second.register(key);
    await new Promise((resolve) => setTimeout(resolve, 200));
    pause.resume();
    expect((await firstReply).status).toBe(201);
    expect((await secondReply).body.error).toBe("enrollment_key_used");
  });

  it.each([
    ["unknown", async () => "x".repeat(32), "enrollment_key_invalid"],
    [
      "expired",
      async () => insertKey(database, { expiresAt: new Date(Date.now() - 1000) }),
      "enrollment_key_expired",
    ],
    [
      "revoked",
      async () => insertKey(database, { revokedAt: new Date() }),
      "enrollment_key_revoked",
    ],
  ])("refuses an %s key", async (_, makeKey, error) => {
    const reply = await new TestAgent(harness).register(await makeKey());
    expect(reply).toMatchObject({ status: 403, body: { error } });
    expect(await agentRows()).toHaveLength(0);
  });

  it("refuses an install ID that another agent uses, keeping the key unused", async () => {
    const first = new TestAgent(harness);
    await first.enroll(database);
    const second = new TestAgent(harness);
    second.installId = first.installId;
    const key = await insertKey(database);
    expect(await second.register(key)).toMatchObject({
      status: 409,
      body: { error: "install_id_conflict" },
    });
    const [row] = await database.sql`select used_at from enrollment_key where used_at is null`;
    expect(row).toBeDefined();
  });

  it("answers a repeat of a revoked agent's registration with agent_revoked", async () => {
    const agent = new TestAgent(harness);
    const key = await insertKey(database);
    expect((await agent.register(key)).status).toBe(201);
    await database.sql`update agent set revoked_at = now()`;
    expect((await agent.register(key)).body.error).toBe("agent_revoked");
  });

  it.each([
    ["enrollmentKey", { enrollmentKey: "short" }],
    ["installId", { installId: "not-a-uuid" }],
    ["token", { token: "too-short" }],
    ["agentVersion", { agentVersion: "" }],
    ["osVersion", { osVersion: "<script>" }],
  ])("refuses an invalid %s", async (field, overrides) => {
    const reply = await new TestAgent(harness).register(await insertKey(database), overrides);
    expect(reply).toMatchObject({ status: 400, body: { error: "request_invalid", field } });
  });

  it("refuses a body that is not JSON", async () => {
    const reply = await new TestAgent(harness).post("/register", "{not json");
    expect(reply).toMatchObject({ status: 400, body: { error: "request_invalid", field: "body" } });
  });

  it("limits registrations per client address with 429 and Retry-After", async () => {
    const replies = [];
    for (let i = 0; i < REGISTER_RATE_LIMIT.max + 1; i++) {
      replies.push(await new TestAgent(harness, "203.0.113.77").register("x".repeat(32)));
    }
    const last = replies.at(-1);
    expect(last?.status).toBe(429);
    expect(last?.body.error).toBe("rate_limited");
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address is not affected.
    expect((await new TestAgent(harness, "203.0.113.78").register("x".repeat(32))).status).toBe(
      403,
    );
  });

  it("refuses registration from a blocked address or range", async () => {
    await database.sql`insert into blocked_range (range, created_by) values ('203.0.113.0/24', 'shlomi')`;
    const reply = await new TestAgent(harness, "203.0.113.9").register(await insertKey(database));
    expect(reply).toMatchObject({ status: 403, body: { error: "address_blocked" } });
    expect((await keyRow())?.used_at).toBeNull();
  });

  it("refuses a body over 64 KB", async () => {
    const reply = await new TestAgent(harness).register(await insertKey(database), {
      padding: "x".repeat(70 * 1024),
    });
    expect(reply).toMatchObject({ status: 413, body: { error: "payload_too_large" } });
    expect(reply.headers.get("mashkif-protocol-version")).toBe("1");
  });

  it("needs the protocol version header", async () => {
    const reply = await new TestAgent(harness).post(
      "/register",
      {},
      { "mashkif-protocol-version": "" },
    );
    expect(reply).toMatchObject({ status: 400, body: { error: "protocol_version_missing" } });
  });
});
