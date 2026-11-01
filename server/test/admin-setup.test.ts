import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  completeSetup,
  createSetupToken,
  hashToken,
  SETUP_TOKEN_TTL_MS,
} from "../src/admin/setup.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { Browser, createHarness, type Harness, PASSWORD, USERNAME } from "./support/harness.js";

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

async function newToken(now?: Date): Promise<string> {
  const result = await createSetupToken(database.db, now);
  if (!result.ok) {
    throw new Error("setup token refused");
  }
  return result.token;
}

const setup = (browser: Browser, token: string, username = USERNAME, password = PASSWORD) =>
  browser.post("/api/admin/setup", { token, username, password });

describe("setup token", () => {
  it("is stored only as a SHA-256 hash and is valid for 15 minutes", async () => {
    const before = Date.now();
    const token = await newToken();
    const rows = await database.sql`select token_hash, expires_at from admin_setup_token`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    const expires = new Date(String(rows[0]?.expires_at)).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(SETUP_TOKEN_TTL_MS - 1000);
    expect(expires - before).toBeLessThanOrEqual(SETUP_TOKEN_TTL_MS + 5000);
    expect(SETUP_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("is refused once an admin exists", async () => {
    expect((await setup(new Browser(harness), await newToken())).status).toBe(201);
    expect(await createSetupToken(database.db)).toEqual({ ok: false });
  });

  it("a new token replaces an unused one", async () => {
    const first = await newToken();
    const second = await newToken();
    const browser = new Browser(harness);
    expect((await setup(browser, first)).body).toEqual({ error: "setup_token_invalid" });
    expect((await setup(browser, second)).status).toBe(201);
  });
});

describe("setup route", () => {
  it("reports whether setup is required", async () => {
    const browser = new Browser(harness);
    expect((await browser.get("/api/admin/status")).body).toEqual({ setupRequired: true });
    expect((await setup(browser, await newToken())).status).toBe(201);
    expect((await browser.get("/api/admin/status")).body).toEqual({ setupRequired: false });
  });

  it("creates the admin with a valid token, in lower case, with an audit entry", async () => {
    const reply = await setup(new Browser(harness), await newToken());
    expect(reply).toMatchObject({ status: 201, body: { username: "shlomi" } });
    const users =
      await database.sql`select username, display_username, two_factor_enabled from auth_user`;
    expect(users).toEqual([
      { username: "shlomi", display_username: USERNAME, two_factor_enabled: false },
    ]);
    const audit = await database.sql`select actor, action, ip_address from audit_log order by id`;
    expect(audit.map((row) => row.action)).toEqual(["admin.setup_token_created", "admin.created"]);
    expect(audit[1]).toMatchObject({ actor: "shlomi", ip_address: harness.address });
  });

  it("requires a token", async () => {
    const reply = await setup(new Browser(harness), "");
    expect(reply).toMatchObject({ status: 400, body: { error: "setup_token_invalid" } });
    expect(await database.sql`select 1 from auth_user`).toHaveLength(0);
  });

  it("refuses a wrong token", async () => {
    await newToken();
    const reply = await setup(new Browser(harness), "not-the-token");
    expect(reply).toMatchObject({ status: 403, body: { error: "setup_token_invalid" } });
  });

  it("refuses an expired token", async () => {
    const token = await newToken(new Date(Date.now() - SETUP_TOKEN_TTL_MS - 1000));
    const reply = await setup(new Browser(harness), token);
    expect(reply).toMatchObject({ status: 403, body: { error: "setup_token_invalid" } });
    expect(await database.sql`select 1 from auth_user`).toHaveLength(0);
  });

  it("refuses a token that was already used", async () => {
    const token = await newToken();
    expect((await setup(new Browser(harness), token)).status).toBe(201);
    const again = await setup(new Browser(harness), token, "another");
    expect(again).toMatchObject({ status: 409, body: { error: "already_set_up" } });
    // Even with the admin gone, the used token stays used.
    await database.sql`delete from auth_user`;
    const result = await completeSetup(database.db, {
      token,
      username: "another",
      password: PASSWORD,
    });
    expect(result).toEqual({ ok: false, error: "setup_token_invalid" });
  });

  it("validates the username and password", async () => {
    const token = await newToken();
    const browser = new Browser(harness);
    expect((await setup(browser, token, "a b")).body).toMatchObject({ error: "username_invalid" });
    expect((await setup(browser, token, "ab")).body).toMatchObject({ error: "username_invalid" });
    expect((await setup(browser, token, USERNAME, "short")).body).toMatchObject({
      error: "password_too_short",
    });
    expect((await setup(browser, token, USERNAME, "x".repeat(129))).body).toMatchObject({
      error: "password_too_long",
    });
    // Validation failures do not consume the token.
    expect((await setup(browser, token)).status).toBe(201);
  });

  it("refuses a cross-origin setup request", async () => {
    const token = await newToken();
    const browser = new Browser(harness);
    for (const origin of ["https://evil.example", null]) {
      const reply = await browser.post(
        "/api/admin/setup",
        { token, username: USERNAME, password: PASSWORD },
        { origin },
      );
      expect(reply).toMatchObject({ status: 403, body: { error: "origin_rejected" } });
    }
    expect(await database.sql`select 1 from auth_user`).toHaveLength(0);
  });

  it("limits setup attempts to 5 per 5 minutes per address", async () => {
    await newToken();
    const browser = new Browser(harness);
    for (let i = 0; i < 5; i++) {
      expect((await setup(browser, "wrong")).status).toBe(403);
    }
    expect((await setup(browser, "wrong")).status).toBe(429);
  });
});

describe("one admin only", () => {
  it("two concurrent setups with the same token create one admin", async () => {
    const token = await newToken();
    const replies = await Promise.all([
      setup(new Browser(harness), token, "first"),
      setup(new Browser(harness), token, "second"),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect(await database.sql`select 1 from auth_user`).toHaveLength(1);
  });

  it("two concurrent setups with two valid tokens create one admin", async () => {
    // Two tokens can only both be valid if inserted directly: the CLI keeps one.
    const first = await newToken();
    await database.sql`insert into admin_setup_token (token_hash, expires_at)
      values (${hashToken("second-token")}, now() + interval '10 minutes')`;
    const results = await Promise.all([
      completeSetup(database.db, { token: first, username: "first", password: PASSWORD }),
      completeSetup(database.db, { token: "second-token", username: "second", password: PASSWORD }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: "already_set_up" },
    ]);
    expect(await database.sql`select 1 from auth_user`).toHaveLength(1);
  });

  it("the database refuses a second admin row", async () => {
    expect((await setup(new Browser(harness), await newToken())).status).toBe(201);
    await expect(
      database.sql`insert into auth_user (id, name, email, username)
        values ('second', 'second', 'second@admin.mashkif.invalid', 'second')`,
    ).rejects.toMatchObject({ code: "23505", constraint_name: "auth_user_one_admin" });
    await expect(
      database.sql`insert into auth_user (id, name, email, username, singleton)
        values ('second', 'second', 'second@admin.mashkif.invalid', 'second', false)`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "auth_user_singleton_true" });
  });
});
