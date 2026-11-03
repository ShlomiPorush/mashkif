import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runPromotion } from "../src/promotion.js";
import { fullAdmin, setSetting, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

const NOW = new Date("2026-11-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await truncateAll(database.sql);
  harness = createHarness(database);
  await setSetting(database, "promotion_days", 3);
});

/** A registered agent whose trial counters are set directly. */
async function agentWith(
  activeDays: number,
  lastSeenAgoMs: number | null,
  tier = "low",
): Promise<string> {
  const agent = await new TestAgent(harness).enroll();
  const lastSeen = lastSeenAgoMs === null ? null : new Date(NOW.getTime() - lastSeenAgoMs);
  await database.sql`update agent set active_days = ${activeDays},
    last_seen_at = ${lastSeen === null ? null : lastSeen.toISOString()}::timestamptz,
    trust_tier = ${tier} where id = ${agent.agentId ?? ""}`;
  return agent.agentId as string;
}

async function tierOf(id: string): Promise<string> {
  const [row] = await database.sql`select trust_tier from agent where id = ${id}`;
  return String(row?.trust_tier);
}

async function promotionAudits() {
  return database.sql`select actor, action, details from audit_log
    where action = 'agent.trust_tier_changed' and actor = 'system' order by id`;
}

describe("active days", () => {
  it("count the first heartbeat of each UTC day once, also for a retried heartbeat", async () => {
    const agent = await new TestAgent(harness).enroll();
    const days = async () => {
      const [row] = await database.sql`select active_days, last_active_day::text as day from agent`;
      return row;
    };
    harness.now = new Date("2026-11-03T00:10:00.000Z");
    expect((await agent.heartbeat()).status).toBe(200);
    // The same heartbeat again (a lost answer) and another one later that day.
    expect((await agent.post("/heartbeat", agent.heartbeatBody())).status).toBe(200);
    harness.now = new Date("2026-11-03T23:50:00.000Z");
    expect((await agent.heartbeat()).status).toBe(200);
    expect(await days()).toMatchObject({ active_days: 1, day: "2026-11-03" });

    harness.now = new Date("2026-11-04T00:05:00.000Z");
    expect((await agent.heartbeat()).status).toBe(200);
    expect(await days()).toMatchObject({ active_days: 2, day: "2026-11-04" });
  });
});

describe("promotion", () => {
  it("promotes low agents at the boundary only while they report, and audits each promotion", async () => {
    const short = await agentWith(2, HOUR);
    const due = await agentWith(3, HOUR);
    const silent = await agentWith(3, 25 * HOUR);
    const revoked = await agentWith(5, HOUR);
    await database.sql`update agent set revoked_at = now() where id = ${revoked}`;
    const normal = await agentWith(9, HOUR, "normal");
    const suspicious = await agentWith(9, HOUR, "suspicious");

    expect(await runPromotion(database.db, NOW)).toEqual({ promoted: 1, complete: true });
    expect(await tierOf(due)).toBe("normal");
    for (const id of [short, silent, revoked]) {
      expect(await tierOf(id)).toBe("low");
    }
    expect(await tierOf(normal)).toBe("normal");
    expect(await tierOf(suspicious)).toBe("suspicious");
    expect(await promotionAudits()).toMatchObject([
      {
        actor: "system",
        details: { agentId: due, from: "low", to: "normal", reason: "probation_complete" },
      },
    ]);

    // A second run changes nothing and writes no second entry.
    expect(await runPromotion(database.db, NOW)).toEqual({ promoted: 0, complete: true });
    expect(await promotionAudits()).toHaveLength(1);

    // A shorter trial applies on the next run.
    await setSetting(database, "promotion_days", 2);
    expect((await runPromotion(database.db, NOW)).promoted).toBe(1);
    expect(await tierOf(short)).toBe("normal");
  });

  it("stops at the batch cap and resumes on the next run", async () => {
    for (let i = 0; i < 5; i++) {
      await agentWith(3, HOUR);
    }
    expect(await runPromotion(database.db, NOW, 2, 2)).toEqual({ promoted: 4, complete: false });
    expect(await runPromotion(database.db, NOW, 2, 2)).toEqual({ promoted: 1, complete: true });
    expect(await promotionAudits()).toHaveLength(5);
  });

  it("promotes each agent once when two runs race", async () => {
    for (let i = 0; i < 6; i++) {
      await agentWith(3, HOUR);
    }
    const results = await Promise.all([
      runPromotion(database.db, NOW, 1, 10),
      runPromotion(database.db, NOW, 1, 10),
    ]);
    expect(results.reduce((sum, result) => sum + result.promoted, 0)).toBe(6);
    expect(await promotionAudits()).toHaveLength(6);
  });

  it("skips an agent that a revoke or a tier change holds, and never promotes it afterwards", async () => {
    const revoked = await agentWith(3, HOUR);
    const held = await agentWith(3, HOUR);
    const revoke = await database.sql.reserve();
    const change = await database.sql.reserve();
    try {
      await revoke`begin`;
      await revoke`update agent set revoked_at = now() where id = ${revoked}`;
      await change`begin`;
      await change`update agent set trust_tier = 'suspicious' where id = ${held}`;
      expect((await runPromotion(database.db, NOW)).promoted).toBe(0);
      await revoke`commit`;
      await change`commit`;
    } finally {
      revoke.release();
      change.release();
    }
    expect((await runPromotion(database.db, NOW)).promoted).toBe(0);
    expect(await tierOf(revoked)).toBe("low");
    expect(await tierOf(held)).toBe("suspicious");
  });
});

describe("manual tier changes", () => {
  async function counters(id: string) {
    const [row] = await database.sql`select trust_tier, active_days, last_active_day::text as day
      from agent where id = ${id}`;
    return row;
  }

  it("restart the trial only on a change from another tier to low", async () => {
    const browser = await fullAdmin(harness);
    const id = await agentWith(5, HOUR, "normal");
    await database.sql`update agent set last_active_day = '2026-11-03' where id = ${id}`;

    expect(
      (await browser.post(`/api/admin/agents/${id}`, { trustTier: "suspicious" })).status,
    ).toBe(200);
    expect(await counters(id)).toMatchObject({ trust_tier: "suspicious", active_days: 5 });

    expect((await browser.post(`/api/admin/agents/${id}`, { trustTier: "low" })).status).toBe(200);
    expect(await counters(id)).toMatchObject({ trust_tier: "low", active_days: 0, day: null });

    // Low to low keeps the count.
    await database.sql`update agent set active_days = 2 where id = ${id}`;
    expect((await browser.post(`/api/admin/agents/${id}`, { trustTier: "low" })).status).toBe(200);
    expect(await counters(id)).toMatchObject({ trust_tier: "low", active_days: 2 });
  });

  it("never reset or demote on a label-only edit, also from a form opened before a promotion", async () => {
    const browser = await fullAdmin(harness);
    const id = await agentWith(3, HOUR);
    // The admin opens the form while the agent is low; the promotion runs meanwhile.
    expect((await runPromotion(database.db, NOW)).promoted).toBe(1);
    // The form sends only what changed: the label.
    expect((await browser.post(`/api/admin/agents/${id}`, { label: "Kitchen PC" })).status).toBe(
      200,
    );
    expect(await counters(id)).toMatchObject({ trust_tier: "normal", active_days: 3 });
  });

  it("end consistent when an admin low races a promotion and a heartbeat", async () => {
    const browser = await fullAdmin(harness);
    const agent = await new TestAgent(harness).enroll();
    const id = agent.agentId as string;
    await database.sql`update agent set active_days = 3, last_seen_at = now(), trust_tier = 'normal'
      where id = ${id}`;
    harness.now = undefined;
    const [changed, , beat] = await Promise.all([
      browser.post(`/api/admin/agents/${id}`, { trustTier: "low" }),
      runPromotion(database.db, new Date()),
      agent.heartbeat(),
    ]);
    expect(changed.status).toBe(200);
    expect(beat.status).toBe(200);
    const row = await counters(id);
    // Low after the admin's change: the trial restarted, and at most today's
    // heartbeat counts. The promotion never undid it within the same run.
    expect(row?.trust_tier).toBe("low");
    expect(Number(row?.active_days)).toBeLessThanOrEqual(1);
  });
});
