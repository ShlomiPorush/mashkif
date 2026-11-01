import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { type Auth, logAuthEvent } from "../src/auth/auth.js";
import { session } from "../src/db/schema.js";
import { describeSafely } from "../src/errors.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import {
  Browser,
  createHarness,
  enrollTotp,
  ORIGIN,
  PASSWORD,
  setUpAdmin,
  USERNAME,
} from "./support/harness.js";
import { SoftwareAuthenticator } from "./support/webauthn.js";

// Database errors carry SQL parameters (password hashes, session tokens) in
// their message. None of them may reach a log line.
const SECRET = "dummy-secret-session-token-4f9a";

let database: TestDatabase;
let queryError: unknown;

beforeAll(async () => {
  database = await createTestDatabase();
  // A real query error whose parameters hold the secret: the user does not exist.
  queryError = await database.db
    .insert(session)
    .values({ id: "s1", token: SECRET, userId: "missing", expiresAt: new Date() })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await database?.drop();
});

function captureConsole() {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

describe("error logging", () => {
  it("the injected failure really carries the secret", () => {
    expect(queryError).toBeInstanceOf(Error);
    expect(String((queryError as Error).message)).toContain(SECRET);
  });

  it("describes a query error by name and SQLSTATE only (CLI and server start)", () => {
    expect(describeSafely(queryError)).toBe("DrizzleQueryError (SQLSTATE 23503)");
  });

  it("keeps the message of other errors", () => {
    expect(describeSafely(new Error("the admin has no password account"))).toBe(
      "Error: the admin has no password account",
    );
  });

  it("Better Auth's log lines leave out query details", () => {
    const lines = captureConsole();
    logAuthEvent("error", "DrizzleQueryError", queryError, { token: SECRET });
    expect(lines).toEqual([
      "[Better Auth] ERROR: message withheld (DrizzleQueryError (SQLSTATE 23503))",
    ]);
  });

  it("a request that fails with a query error logs no parameters", async () => {
    const lines = captureConsole();
    const failing = {
      handler: async () => {
        throw queryError;
      },
    } as unknown as Auth;
    const app = createApp({
      readiness: { database: async () => {}, geoip: async () => {} },
      admin: {
        db: database.db,
        auth: failing,
        publicOrigin: ORIGIN,
        clientAddress: () => "198.51.100.1",
      },
    });
    const response = await app.request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`);
    expect(response.status).toBe(500);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).toContain("DrizzleQueryError (SQLSTATE 23503)");
  });

  it("a sign-in whose session insert fails logs no query parameters (real Better Auth path)", async () => {
    const harness = createHarness(database);
    await setUpAdmin(database, harness);
    // Break the session insert. The User-Agent goes into its parameters.
    await database.sql`alter table auth_session rename column user_agent to user_agent_moved`;
    try {
      const lines = captureConsole();
      const reply = await new Browser(harness).request("POST", "/api/auth/sign-in/username", {
        json: { username: USERNAME, password: PASSWORD },
        headers: { "user-agent": SECRET },
      });
      vi.restoreAllMocks();
      const output = lines.join("\n");
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(output).toContain("DrizzleQueryError (SQLSTATE 42703)");
      expect(output).not.toContain(SECRET);
      expect(output).not.toMatch(/params:|failed query/i);
    } finally {
      await database.sql`alter table auth_session rename column user_agent_moved to user_agent`;
    }
  });

  it("writes only allowlisted messages, never a message built from request data", () => {
    const lines = captureConsole();
    logAuthEvent("error", `Invalid callbackURL: https://evil.example/${SECRET}`);
    logAuthEvent("warn", "Invalid password");
    expect(lines).toEqual([
      "[Better Auth] ERROR: message withheld",
      "[Better Auth] WARN: Invalid password",
    ]);
  });

  it("refuses a callbackURL on sign-in, which Better Auth would echo as a redirect", async () => {
    const harness = createHarness(database);
    const reply = await new Browser(harness).post("/api/auth/sign-in/username", {
      username: USERNAME,
      password: PASSWORD,
      callbackURL: `https://evil.example/${SECRET}`,
    });
    expect(reply).toMatchObject({ status: 400, body: { error: "callback_url_unsupported" } });
  });

  it("a passkey error that quotes request data is logged by name only (real Better Auth path)", async () => {
    await truncateAll(database.sql);
    const harness = createHarness(database);
    await setUpAdmin(database, harness);
    const owner = new Browser(harness);
    await enrollTotp(owner);
    const authenticator = new SoftwareAuthenticator();
    const rpId = new URL(ORIGIN).hostname;
    const register = await owner.get("/api/auth/passkey/generate-register-options");
    const added = await owner.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register({
        origin: ORIGIN,
        rpId,
        challenge: String(register.body.challenge),
        userVerified: true,
      }),
    });
    expect(added.status).toBe(200);

    // The client data names an origin that carries the secret; the WebAuthn
    // library quotes it in its error message.
    const browser = new Browser(harness);
    const options = await browser.get("/api/auth/passkey/generate-authenticate-options");
    const lines = captureConsole();
    const reply = await browser.post("/api/auth/passkey/verify-authentication", {
      response: authenticator.authenticate({
        origin: `https://evil.example/${SECRET}`,
        rpId,
        challenge: String(options.body.challenge),
        userVerified: true,
      }),
    });
    vi.restoreAllMocks();
    const output = lines.join("\n");
    expect(reply.status).toBe(400);
    expect(output).toContain("[Better Auth] ERROR: Failed to verify authentication (Error)");
    expect(output).not.toContain(SECRET);
  });
});
