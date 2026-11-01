import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withAdminLock } from "../src/admin/lock.js";
import { resetAdmin } from "../src/admin/reset.js";
import { hashToken } from "../src/admin/setup.js";
import { runCli } from "../src/cli.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import {
  Browser,
  completeReset,
  createHarness,
  enrollTotp,
  type Harness,
  NEW_PASSWORD,
  ORIGIN,
  PASSWORD,
  setUpAdmin,
  USERNAME,
} from "./support/harness.js";
import { totpCode } from "./support/totp.js";
import { SoftwareAuthenticator } from "./support/webauthn.js";

/** A route only a full session may call. */
const FULL_ONLY = "/api/auth/passkey/list-user-passkeys";

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

interface Admin {
  secret: Buffer;
  /** A full session. */
  full: Browser;
  /** A browser between the password and the TOTP step. */
  pending: Browser;
  authenticator: SoftwareAuthenticator;
}

/** An admin with TOTP, a passkey, a full session, and a pending TOTP sign-in. */
async function establishedAdmin(): Promise<Admin> {
  await setUpAdmin(database, harness);
  const full = new Browser(harness);
  const secret = await enrollTotp(full);
  const authenticator = new SoftwareAuthenticator();
  const options = await full.get("/api/auth/passkey/generate-register-options");
  const added = await full.post("/api/auth/passkey/verify-registration", {
    response: authenticator.register({
      origin: ORIGIN,
      rpId: new URL(ORIGIN).hostname,
      challenge: String(options.body.challenge),
      userVerified: true,
    }),
  });
  expect(added.status).toBe(200);
  const pending = new Browser(harness);
  expect((await pending.signIn()).body).toMatchObject({ twoFactorRedirect: true });
  harness.rateLimits.clear();
  return { secret, full, pending, authenticator };
}

async function counts() {
  const [row] = await database.sql`select
    (select count(*) from auth_two_factor)::int as totp,
    (select count(*) from auth_passkey)::int as passkeys,
    (select count(*) from auth_session)::int as sessions,
    (select count(*) from auth_verification)::int as challenges,
    (select bool_and(two_factor_enabled) from auth_user) as "totpEnabled",
    (select password from auth_account) as "passwordHash",
    (select count(*) from admin_reset_token)::int as "resetTokens"`;
  return row;
}

async function passkeySignIn(authenticator: SoftwareAuthenticator) {
  const browser = new Browser(harness);
  const options = await browser.get("/api/auth/passkey/generate-authenticate-options");
  return browser.post("/api/auth/passkey/verify-authentication", {
    response: authenticator.authenticate({
      origin: ORIGIN,
      rpId: new URL(ORIGIN).hostname,
      challenge: String(options.body.challenge),
      userVerified: true,
    }),
  });
}

describe("reset-admin", () => {
  it("refuses when no admin exists", async () => {
    expect(await resetAdmin(database.db)).toEqual({ ok: false });
  });

  it("an interrupted reset changes nothing, so no half-reset state exists", async () => {
    const admin = await establishedAdmin();
    const before = await counts();
    expect(before).toMatchObject({ totp: 1, passkeys: 1, totpEnabled: true });
    expect(before?.sessions).toBeGreaterThan(0);
    expect(before?.challenges).toBeGreaterThan(0);

    // Fail after every change was made, just before the commit.
    await expect(
      resetAdmin(database.db, {
        beforeCommit: async () => {
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");

    expect(await counts()).toEqual(before);
    expect(await admin.full.sessionState()).toBe("full");
    const audit = await database.sql`select 1 from audit_log where action = 'admin.reset'`;
    expect(audit).toHaveLength(0);
    // The pending sign-in still completes with the old TOTP secret.
    const verify = await admin.pending.post("/api/auth/two-factor/verify-totp", {
      code: totpCode(admin.secret),
    });
    expect(verify.status).toBe(200);
  });

  it("removes every old way in and leaves only a new password and TOTP enrollment", async () => {
    const admin = await establishedAdmin();
    const before = await counts();
    const result = await resetAdmin(database.db);
    if (!result.ok) {
      throw new Error("reset refused");
    }
    expect(result.username).toBe("shlomi");
    expect(result).not.toHaveProperty("password");

    const after = await counts();
    expect(after).toMatchObject({
      totp: 0,
      passkeys: 0,
      sessions: 0,
      challenges: 0,
      totpEnabled: false,
      resetTokens: 1,
    });
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    const [stored] = await database.sql`select token_hash from admin_reset_token`;
    expect(stored?.token_hash).toBe(hashToken(result.token));
    const audit = await database.sql`select actor from audit_log where action = 'admin.reset'`;
    expect(audit).toEqual([{ actor: "cli" }]);

    // The old session, the pending TOTP step, the passkey, and the old password are gone.
    expect(await admin.full.sessionState()).toBe("none");
    const pending = await admin.pending.post("/api/auth/two-factor/verify-totp", {
      code: totpCode(admin.secret),
    });
    expect(pending.status).toBe(401);
    expect((await passkeySignIn(admin.authenticator)).status).toBe(401);
    expect((await new Browser(harness).signIn(USERNAME, PASSWORD)).status).toBe(401);

    // The token sets a new password; the old one still fails.
    const browser = new Browser(harness);
    expect(await completeReset(browser, result.token)).toMatchObject({ status: 200 });
    expect((await new Browser(harness).signIn(USERNAME, PASSWORD)).status).toBe(401);

    // The new password opens a session that may only enroll TOTP.
    const signIn = await browser.signIn(USERNAME, NEW_PASSWORD);
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBeUndefined();
    expect(await browser.sessionState()).toBe("enrollment");
    expect((await browser.get(FULL_ONLY)).status).toBe(403);
    expect((await browser.get("/api/auth/passkey/generate-register-options")).status).toBe(403);
    const secret = await enrollTotp(browser, NEW_PASSWORD);
    expect(secret.equals(admin.secret)).toBe(false);
    expect(await browser.sessionState()).toBe("full");
  });

  it("a credential change that passed its session check cannot finish after a reset", async () => {
    await setUpAdmin(database, harness);
    // A session before TOTP exists: TOTP enrollment is its credential change.
    const browser = new Browser(harness);
    expect((await browser.signIn()).status).toBe(200);

    // The reset makes every change and then waits, holding the admin lock,
    // before it commits.
    let commit = () => {};
    let ready = () => {};
    const changed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const reset = resetAdmin(database.db, {
      beforeCommit: () =>
        new Promise<void>((resolve) => {
          commit = resolve;
          ready();
        }),
    });
    await changed;

    // The request passes its session check (the reset is not committed yet)
    // and then waits for the lock.
    const request = browser.post("/api/auth/two-factor/enable", { password: PASSWORD });
    const waiting = async () => {
      const [row] = await database.sql`select count(*)::int as n from pg_locks
        where locktype = 'advisory' and not granted`;
      return row?.n === 1;
    };
    for (let i = 0; i < 40 && !(await waiting()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    commit();
    expect((await reset).ok).toBe(true);

    const reply = await request;
    expect(reply).toMatchObject({ status: 401, body: { error: "session_ended" } });
    expect(await counts()).toMatchObject({ totp: 0, sessions: 0, totpEnabled: false });
  });
});

describe("reset token", () => {
  async function newResetToken(): Promise<string> {
    const result = await resetAdmin(database.db);
    if (!result.ok) {
      throw new Error("reset refused");
    }
    return result.token;
  }

  beforeEach(async () => {
    await setUpAdmin(database, harness);
  });

  it("works once", async () => {
    const token = await newResetToken();
    expect((await completeReset(new Browser(harness), token)).status).toBe(200);
    const again = await completeReset(new Browser(harness), token, "another long passphrase");
    expect(again).toMatchObject({ status: 403, body: { error: "reset_token_used" } });
    expect((await new Browser(harness).signIn(USERNAME, NEW_PASSWORD)).status).toBe(200);
  });

  it("expires after 15 minutes", async () => {
    const token = await newResetToken();
    const [row] = await database.sql`select expires_at - created_at as ttl from admin_reset_token`;
    expect(String(row?.ttl)).toMatch(/^00:15:00/);
    await database.sql`update admin_reset_token set expires_at = now() - interval '1 second'`;
    const reply = await completeReset(new Browser(harness), token);
    expect(reply).toMatchObject({ status: 403, body: { error: "reset_token_expired" } });
  });

  it("refuses a wrong token, and a weak password before the token is used", async () => {
    const token = await newResetToken();
    const browser = new Browser(harness);
    expect(await completeReset(browser, "not-the-token")).toMatchObject({
      status: 403,
      body: { error: "reset_token_invalid" },
    });
    expect(await completeReset(browser, token, "short")).toMatchObject({
      status: 400,
      body: { error: "password_too_short" },
    });
    expect(await completeReset(browser, "")).toMatchObject({
      status: 400,
      body: { error: "reset_token_invalid" },
    });
    expect((await completeReset(browser, token)).status).toBe(200);
    const failed = await database.sql`select details from audit_log
      where action = 'admin.password_reset_failed'`;
    expect(failed).toEqual([{ details: { reason: "reset_token_invalid" } }]);
  });

  it("a newer reset makes the older token useless", async () => {
    const older = await newResetToken();
    const newer = await newResetToken();
    expect(await completeReset(new Browser(harness), older)).toMatchObject({
      status: 403,
      body: { error: "reset_token_invalid" },
    });
    expect((await completeReset(new Browser(harness), newer)).status).toBe(200);
  });

  it("limits attempts to 5 per 5 minutes per address", async () => {
    await newResetToken();
    for (let i = 0; i < 5; i++) {
      expect((await completeReset(new Browser(harness), `wrong-${i}`)).status).toBe(403);
    }
    expect((await completeReset(new Browser(harness), "wrong")).status).toBe(429);
  });

  it("waits for the admin lock, like sign-in and setup", async () => {
    const token = await newResetToken();
    let release = () => {};
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withAdminLock(
      database.db,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    await inside;
    let finished = false;
    const reply = completeReset(new Browser(harness), token).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    release();
    await holder;
    expect((await reply).status).toBe(200);
  });

  it("ends every session, so the next step is sign-in", async () => {
    const token = await newResetToken();
    // A password session that would exist only if one were opened after the reset.
    await database.sql`insert into auth_session (id, token, user_id, expires_at)
      select 'stray', 'stray-token', id, now() + interval '1 hour' from auth_user`;
    expect((await completeReset(new Browser(harness), token)).status).toBe(200);
    expect(await database.sql`select 1 from auth_session`).toHaveLength(0);
  });

  it("prints a token and never a password, and logs neither", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    try {
      expect(await runCli(["reset-admin"], { DATABASE_URL: database.url })).toBe(0);
      const output = lines.join("\n");
      const token = /^Reset token: (\S+)$/m.exec(output)?.[1] ?? "";
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(output).toContain("/admin/reset");
      expect(output).not.toMatch(/password:/i);
      lines.length = 0;
      expect((await completeReset(new Browser(harness), token)).status).toBe(200);
      const logged = lines.join("\n");
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(NEW_PASSWORD);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
