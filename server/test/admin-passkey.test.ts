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

// Passkeys through Better Auth's passkey plugin, with real WebAuthn responses
// signed by a software authenticator. Registration asks for user
// verification; sign-in uses the plugin's default (preferred).

const RP_ID = new URL(ORIGIN).hostname;

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
  admin = await setUpAdmin(harness);
  await enrollTotp(admin);
});

async function register(browser: Browser, authenticator: SoftwareAuthenticator) {
  const options = await browser.get("/api/auth/passkey/generate-register-options");
  expect(options.status).toBe(200);
  return browser.post("/api/auth/passkey/verify-registration", {
    name: "Test key",
    response: authenticator.register({
      origin: ORIGIN,
      rpId: RP_ID,
      challenge: String(options.body.challenge),
      userVerified: true,
    }),
  });
}

async function authenticate(browser: Browser, authenticator: SoftwareAuthenticator) {
  const options = await browser.get("/api/auth/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  expect(options.body).toMatchObject({ rpId: RP_ID });
  return browser.post("/api/auth/passkey/verify-authentication", {
    response: authenticator.authenticate({
      origin: ORIGIN,
      rpId: RP_ID,
      challenge: String(options.body.challenge),
      userVerified: true,
    }),
  });
}

const passkeyCount = async () => (await database.sql`select 1 from auth_passkey`).length;

describe("passkeys", () => {
  it("are added from a session and audited", async () => {
    expect((await register(admin, new SoftwareAuthenticator())).status).toBe(200);
    expect(await passkeyCount()).toBe(1);
    expect((await admin.get("/api/auth/passkey/list-user-passkeys")).status).toBe(200);
    const rows = await database.sql`select 1 from audit_log where action = 'passkey.added'`;
    expect(rows).toHaveLength(1);
  });

  it("sign the admin in, and the admin API accepts that session", async () => {
    const authenticator = new SoftwareAuthenticator();
    expect((await register(admin, authenticator)).status).toBe(200);
    const browser = new Browser(harness);
    expect((await authenticate(browser, authenticator)).status).toBe(200);
    expect(await browser.sessionState()).toBe("full");
    expect((await browser.get("/api/admin/agents")).status).toBe(200);
    const [row] = await database.sql`select details from audit_log
      where action = 'sign_in.succeeded' order by id desc limit 1`;
    expect(row?.details).toEqual({ method: "passkey" });
  });

  it("refuse an unknown passkey and audit the failure", async () => {
    const browser = new Browser(harness);
    expect((await authenticate(browser, new SoftwareAuthenticator())).status).toBe(401);
    expect(await browser.sessionState()).toBe("none");
    const [row] = await database.sql`select details from audit_log
      where action = 'sign_in.failed' order by id desc limit 1`;
    expect(row?.details).toEqual({ step: "passkey" });
  });

  it("no longer sign in once removed", async () => {
    const authenticator = new SoftwareAuthenticator();
    expect((await register(admin, authenticator)).status).toBe(200);
    const [row] = await database.sql`select id from auth_passkey`;
    expect((await admin.post("/api/auth/passkey/delete-passkey", { id: row?.id })).status).toBe(
      200,
    );
    expect(await passkeyCount()).toBe(0);
    expect((await authenticate(new Browser(harness), authenticator)).status).toBe(401);
    const rows = await database.sql`select 1 from audit_log where action = 'passkey.removed'`;
    expect(rows).toHaveLength(1);
  });
});
