import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import {
  Browser,
  createHarness,
  enrollTotp,
  type Harness,
  ORIGIN,
  setUpAdmin,
} from "./support/harness.js";
import { SoftwareAuthenticator } from "./support/webauthn.js";

// Passkeys must verify the user (PIN or biometrics). The Better Auth plugin
// verifies responses with requireUserVerification: false, so Mashkif refuses
// a response without the UV flag in the plugin's afterVerification hooks.
// These tests sign real WebAuthn responses with a software authenticator and
// flip only the UV flag: the accepted case proves the responses are valid,
// so the refused case can only be refused for missing user verification.

const RP_ID = new URL(ORIGIN).hostname;

/** A route only a full session may call. */
const FULL_ONLY = "/api/auth/passkey/list-user-passkeys";

let database: TestDatabase;
let harness: Harness;
let admin: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await truncateAll(database.sql);
  harness = createHarness(database);
  await setUpAdmin(database, harness);
  admin = new Browser(harness);
  await enrollTotp(admin);
});

async function register(
  browser: Browser,
  authenticator: SoftwareAuthenticator,
  userVerified: boolean,
) {
  const options = await browser.get("/api/auth/passkey/generate-register-options");
  expect(options.status).toBe(200);
  expect(options.body).toMatchObject({
    rp: { id: RP_ID },
    authenticatorSelection: { userVerification: "required", residentKey: "required" },
  });
  return browser.post("/api/auth/passkey/verify-registration", {
    name: "Test key",
    response: authenticator.register({
      origin: ORIGIN,
      rpId: RP_ID,
      challenge: String(options.body.challenge),
      userVerified,
    }),
  });
}

async function authenticate(
  browser: Browser,
  authenticator: SoftwareAuthenticator,
  userVerified: boolean,
) {
  const options = await browser.get("/api/auth/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  expect(options.body).toMatchObject({ rpId: RP_ID, userVerification: "required" });
  return browser.post("/api/auth/passkey/verify-authentication", {
    response: authenticator.authenticate({
      origin: ORIGIN,
      rpId: RP_ID,
      challenge: String(options.body.challenge),
      userVerified,
    }),
  });
}

const passkeyCount = async () => (await database.sql`select 1 from auth_passkey`).length;

async function lastActions(count: number): Promise<string[]> {
  const rows = await database.sql`select action from audit_log order by id desc limit ${count}`;
  return rows.map((row) => String(row.action)).reverse();
}

describe("passkey registration", () => {
  it("adds a passkey that verified the user, from a full session", async () => {
    const reply = await register(admin, new SoftwareAuthenticator(), true);
    expect(reply.status).toBe(200);
    expect(await passkeyCount()).toBe(1);
    const list = await admin.get("/api/auth/passkey/list-user-passkeys");
    expect(list.status).toBe(200);
    // The start of the change is committed before it, the outcome after it.
    expect(await lastActions(2)).toEqual(["credential_change.started", "passkey.added"]);
  });

  it("refuses a passkey that did not verify the user", async () => {
    const reply = await register(admin, new SoftwareAuthenticator(), false);
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");
    expect(await lastActions(2)).toEqual(["credential_change.started", "credential_change.failed"]);
    expect(await passkeyCount()).toBe(0);
  });

  it("refuses createSession on registration", async () => {
    const reply = await admin.post("/api/auth/passkey/verify-registration", {
      response: {},
      createSession: true,
    });
    expect(reply).toMatchObject({ status: 400, body: { error: "create_session_unsupported" } });
  });

  it("is refused to a session that has not enrolled TOTP", async () => {
    await database.sql`delete from auth_two_factor`;
    await database.sql`update auth_user set two_factor_enabled = false`;
    await database.sql`delete from auth_session`;
    const browser = new Browser(harness);
    expect((await browser.signIn()).status).toBe(200);
    expect(await browser.sessionState()).toBe("enrollment");
    expect((await browser.get("/api/auth/passkey/generate-register-options")).status).toBe(403);
    expect(
      (await browser.post("/api/auth/passkey/verify-registration", { response: {} })).status,
    ).toBe(403);
  });
});

describe("passkey sign-in", () => {
  it("signs in with user verification and gives a full session", async () => {
    const authenticator = new SoftwareAuthenticator();
    expect((await register(admin, authenticator, true)).status).toBe(200);

    const browser = new Browser(harness);
    const reply = await authenticate(browser, authenticator, true);
    expect(reply.status).toBe(200);
    expect((await browser.get("/api/admin/session")).body).toMatchObject({
      state: "full",
      method: "passkey",
    });
    expect((await browser.get(FULL_ONLY)).status).toBe(200);
    const [row] = await database.sql`select details from audit_log
      where action = 'sign_in.succeeded' order by id desc limit 1`;
    expect(row?.details).toEqual({ method: "passkey" });
  });

  it("refuses a passkey response without user verification and opens no session", async () => {
    const authenticator = new SoftwareAuthenticator();
    expect((await register(admin, authenticator, true)).status).toBe(200);
    const sessionsBefore = (await database.sql`select 1 from auth_session`).length;

    const browser = new Browser(harness);
    const reply = await authenticate(browser, authenticator, false);
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");
    expect(await browser.sessionState()).toBe("none");
    expect((await database.sql`select 1 from auth_session`).length).toBe(sessionsBefore);
    const [row] = await database.sql`select details from audit_log
      where action = 'sign_in.failed' order by id desc limit 1`;
    expect(row?.details).toMatchObject({ step: "passkey" });
  });

  it("refuses an unknown passkey", async () => {
    const reply = await authenticate(new Browser(harness), new SoftwareAuthenticator(), true);
    expect(reply.status).toBe(401);
  });

  it("a removed passkey no longer signs in", async () => {
    const authenticator = new SoftwareAuthenticator();
    expect((await register(admin, authenticator, true)).status).toBe(200);
    const [row] = await database.sql`select id from auth_passkey`;
    const removed = await admin.post("/api/auth/passkey/delete-passkey", { id: row?.id });
    expect(removed.status).toBe(200);
    expect(await passkeyCount()).toBe(0);
    expect((await authenticate(new Browser(harness), authenticator, true)).status).toBe(401);
    const actions = await database.sql`select 1 from audit_log where action = 'passkey.removed'`;
    expect(actions).toHaveLength(1);
  });
});
