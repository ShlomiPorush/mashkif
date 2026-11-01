import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { type Auth, logAuthEvent } from "../src/auth/auth.js";
import { session } from "../src/db/schema.js";
import { describeSafely } from "../src/errors.js";
import { createTestDatabase, type TestDatabase } from "./support/database.js";
import { ORIGIN } from "./support/harness.js";

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
      "[Better Auth] ERROR: DrizzleQueryError (DrizzleQueryError (SQLSTATE 23503))",
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
});
