import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import {
  Browser,
  configureSmtp,
  createHarness,
  EMAIL,
  enrollTotp,
  type Harness,
  ORIGIN,
  PASSWORD,
  setUpAdmin,
  signInWithTotp,
  USERNAME,
} from "./support/harness.js";
import { totpCode } from "./support/totp.js";

// Admin sign-in is Better Auth as is. These tests drive Better Auth's own
// routes through the app and check the few things Mashkif adds: the first
// admin only, the admin API middleware, the configuration, and the audit log.

const NEW_PASSWORD = randomBytes(24).toString("base64url");

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

afterEach(() => {
  vi.restoreAllMocks();
});

/** Collects console.error lines. */
function captureErrors(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

async function actions(): Promise<string[]> {
  const rows = await database.sql`select action from audit_log order by id`;
  return rows.map((row) => String(row.action));
}

/** The link in the newest email. */
function linkInMail(): string {
  const text = harness.mail.at(-1)?.text ?? "";
  const match = /https:\/\/\S+/.exec(text);
  if (match === null) {
    throw new Error("no link in the email");
  }
  return match[0];
}

/** Follows Better Auth's reset link to the page, as the browser would, and returns the token. */
async function resetTokenFromMail(browser: Browser): Promise<string> {
  const link = new URL(linkInMail());
  const reply = await harness.app.request(`${ORIGIN}${link.pathname}${link.search}`, {
    headers: { "x-forwarded-for": browser.address },
  });
  expect(reply.status).toBe(302);
  const target = new URL(reply.headers.get("location") ?? "");
  expect(target.pathname).toBe("/admin/reset-password");
  return target.searchParams.get("token") ?? "";
}

describe("first admin", () => {
  it("setup is required until sign-up creates the admin, which then needs TOTP", async () => {
    const anonymous = new Browser(harness);
    expect((await anonymous.get("/api/admin/status")).body).toEqual({ setupRequired: true });
    const admin = await setUpAdmin(harness);
    expect((await anonymous.get("/api/admin/status")).body).toEqual({ setupRequired: false });
    expect(await admin.sessionState()).toBe("enrollment");
    const [row] = await database.sql`select username, email, email_verified from auth_user`;
    expect(row).toEqual({ username: USERNAME.toLowerCase(), email: EMAIL, email_verified: false });
    expect(await actions()).toEqual(["admin.created"]);
  });

  it("refuses a second sign-up through the hook", async () => {
    await setUpAdmin(harness);
    const reply = await new Browser(harness).post("/api/auth/sign-up/email", {
      name: "intruder",
      username: "intruder",
      email: "intruder@example.test",
      password: randomBytes(24).toString("base64url"),
    });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("FAILED_TO_CREATE_USER");
    expect(await database.sql`select 1 from auth_user`).toHaveLength(1);
  });

  it("the one-row constraint backs up the hook", async () => {
    await setUpAdmin(harness);
    await expect(
      database.sql`insert into auth_user (id, name, email) values (${randomUUID()}, 'x', 'x@example.test')`,
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("sign-in", () => {
  it("TOTP is required after the password once it is enrolled", async () => {
    const admin = await setUpAdmin(harness);
    const { secret } = await enrollTotp(admin);
    const browser = new Browser(harness);
    const password = await browser.signIn();
    expect(password.body.twoFactorRedirect).toBe(true);
    expect(await browser.sessionState()).toBe("none");
    expect((await browser.get("/api/admin/agents")).status).toBe(401);
    const totp = await browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) });
    expect(totp.status).toBe(200);
    expect(await browser.sessionState()).toBe("full");
    expect((await browser.get("/api/admin/agents")).status).toBe(200);
  });

  it("a backup code completes the sign-in once", async () => {
    const admin = await setUpAdmin(harness);
    const { backupCodes } = await enrollTotp(admin);
    expect(backupCodes).toHaveLength(10);
    const code = backupCodes[0] ?? "";
    const first = new Browser(harness);
    expect((await first.signIn()).body.twoFactorRedirect).toBe(true);
    expect((await first.post("/api/auth/two-factor/verify-backup-code", { code })).status).toBe(
      200,
    );
    expect(await first.sessionState()).toBe("full");
    const again = new Browser(harness);
    expect((await again.signIn()).body.twoFactorRedirect).toBe(true);
    const reused = await again.post("/api/auth/two-factor/verify-backup-code", { code });
    expect(reused.status).toBe(401);
    expect(await again.sessionState()).toBe("none");
    const regenerated = await first.post("/api/auth/two-factor/generate-backup-codes", {
      password: PASSWORD,
    });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.backupCodes).toHaveLength(10);
    const audit = await actions();
    expect(audit).toContain("backup_codes.generated");
    expect(audit.filter((action) => action === "sign_in.failed")).toHaveLength(1);
  });

  it("audits sign-ins, failures, and sign-out", async () => {
    const admin = await setUpAdmin(harness);
    const { secret } = await enrollTotp(admin);
    const browser = new Browser(harness);
    expect((await browser.signIn(USERNAME, "wrong password here")).status).toBe(401);
    expect((await signInWithTotp(browser, secret)).status).toBe(200);
    expect((await browser.post("/api/auth/sign-out")).status).toBe(200);
    expect(await browser.sessionState()).toBe("none");
    const rows = await database.sql`select actor, action, details from audit_log
      where action like 'sign_%' order by id`;
    expect(rows).toEqual([
      { actor: "-", action: "sign_in.failed", details: { step: "password" } },
      {
        actor: USERNAME.toLowerCase(),
        action: "sign_in.succeeded",
        details: { method: "password_totp" },
      },
      expect.objectContaining({ action: "sign_out" }),
    ]);
  });

  it("limits sign-in attempts to 5 per 5 minutes per client address", async () => {
    await setUpAdmin(harness);
    const browser = new Browser(harness);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await browser.signIn(USERNAME, "wrong password here")).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // Another address is counted on its own.
    expect((await new Browser(harness).signIn()).status).toBe(200);
  });

  it("with trusted proxies, Better Auth counts the address the proxy saw, not what the client wrote", async () => {
    harness = createHarness(database, { trustedProxies: ["10.0.0.0/8"] });
    await setUpAdmin(harness);
    const browser = new Browser(harness);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // The client wrote the first address itself; the trusted proxy appended the real one.
      const reply = await browser.request("POST", "/api/auth/sign-in/username", {
        json: { username: USERNAME, password: "wrong password here" },
        headers: { "x-forwarded-for": `192.0.2.${i}, 198.51.100.40, 10.0.0.2` },
      });
      statuses.push(reply.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("uses the configured session length and never extends it", async () => {
    harness = createHarness(database, { sessionHours: 3 });
    const admin = await setUpAdmin(harness);
    await enrollTotp(admin);
    const read = async () => {
      const [row] =
        await database.sql`select extract(epoch from expires_at - created_at)::float as seconds,
        expires_at::text as expires from auth_session`;
      return row;
    };
    const before = await read();
    expect(Number(before?.seconds) / 3600).toBeCloseTo(3, 2);
    await admin.get("/api/auth/get-session");
    expect((await read())?.expires).toBe(before?.expires);
  });
});

describe("sign-in by email", () => {
  it("is audited like username sign-in, failed and successful", async () => {
    await setUpAdmin(harness);
    const browser = new Browser(harness);
    const wrong = await browser.post("/api/auth/sign-in/email", {
      email: EMAIL,
      password: "wrong password here",
    });
    expect(wrong.status).toBe(401);
    const right = await browser.post("/api/auth/sign-in/email", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(right.status).toBe(200);
    const rows = await database.sql`select actor, action, details from audit_log
      where action like 'sign_in.%' order by id`;
    expect(rows).toEqual([
      { actor: "-", action: "sign_in.failed", details: { step: "password" } },
      {
        actor: USERNAME.toLowerCase(),
        action: "sign_in.succeeded",
        details: { method: "password" },
      },
    ]);
  });

  it("with TOTP enrolled, leaves the audit to the TOTP step", async () => {
    const admin = await setUpAdmin(harness);
    const { secret } = await enrollTotp(admin);
    const browser = new Browser(harness);
    const password = await browser.post("/api/auth/sign-in/email", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(password.body.twoFactorRedirect).toBe(true);
    expect(
      (await browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) })).status,
    ).toBe(200);
    const rows = await database.sql`select details from audit_log
      where action = 'sign_in.succeeded' order by id`;
    expect(rows.map((row) => row.details)).toEqual([{ method: "password_totp" }]);
  });

  it("has the same limit of 5 attempts per 5 minutes", async () => {
    await setUpAdmin(harness);
    const browser = new Browser(harness);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const reply = await browser.post("/api/auth/sign-in/email", {
        email: EMAIL,
        password: "wrong password here",
      });
      statuses.push(reply.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe("secure cookies", () => {
  it("follow the scheme of a public URL that is set", async () => {
    const browser = await setUpAdmin(harness);
    expect(harness.auth.options.advanced?.useSecureCookies).toBe(true);
    const cookie = browser.seenSetCookies.find((line) => line.includes("session_token"));
    expect(cookie).toMatch(/^__Secure-/);
    expect(cookie).toMatch(/;\s*Secure/i);
    const http = createHarness(database, { publicUrl: "http://localhost:8180" });
    expect(http.auth.options.advanced?.useSecureCookies).toBe(false);
  });

  it("are left to Better Auth when no public URL is set", async () => {
    harness = createHarness(database, { publicUrl: null });
    expect(harness.auth.options.advanced).not.toHaveProperty("useSecureCookies");
    // Under tests Better Auth's own default is not secure; in production it is.
    const browser = await setUpAdmin(harness);
    const cookie = browser.seenSetCookies.find((line) => line.includes("session_token"));
    expect(cookie).toBeDefined();
    expect(cookie).not.toMatch(/^__Secure-/);
  });
});

describe("admin API", () => {
  it("is refused without a session and before TOTP is enabled, and /status stays public", async () => {
    const admin = await setUpAdmin(harness);
    expect((await new Browser(harness).get("/api/admin/settings")).body).toEqual({
      error: "session_required",
    });
    expect((await admin.get("/api/admin/settings")).body).toEqual({ error: "totp_required" });
    await enrollTotp(admin);
    expect((await admin.get("/api/admin/settings")).status).toBe(200);
  });

  it("a session without TOTP may still enroll TOTP through Better Auth", async () => {
    const admin = await setUpAdmin(harness);
    const enable = await admin.post("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status).toBe(200);
    expect(await actions()).toContain("totp.secret_created");
  });
});

describe("passkeys", () => {
  it("registration needs a session", async () => {
    await setUpAdmin(harness);
    const reply = await new Browser(harness).get("/api/auth/passkey/generate-register-options");
    expect(reply.status).toBe(401);
  });

  it("registration asks the authenticator to verify the user", async () => {
    const admin = await setUpAdmin(harness);
    await enrollTotp(admin);
    const reply = await admin.get("/api/auth/passkey/generate-register-options");
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      rp: { id: new URL(ORIGIN).hostname, name: "Mashkif" },
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
    });
  });
});

describe("password reset by email", () => {
  it("without SMTP, Better Auth still answers success; only the server log says why", async () => {
    await setUpAdmin(harness);
    const errors = captureErrors();
    const reply = await new Browser(harness).post("/api/auth/request-password-reset", {
      email: EMAIL,
      redirectTo: `${ORIGIN}/admin/reset-password`,
    });
    expect(reply.status).toBe(200);
    expect(harness.mail).toHaveLength(0);
    expect(errors).toContain(
      "password reset: no email sent, SMTP is not configured (admin panel, Settings)",
    );
  });

  it("logs a failed send, which Better Auth still answers with success", async () => {
    await configureSmtp(database);
    await setUpAdmin(harness);
    harness.mailFails = true;
    const errors = captureErrors();
    const reply = await new Browser(harness).post("/api/auth/request-password-reset", {
      email: EMAIL,
      redirectTo: `${ORIGIN}/admin/reset-password`,
    });
    expect(reply.status).toBe(200);
    expect(errors.join(" ")).toContain("password reset: sending the email failed: Error: 550");
  });

  it("emails a link that sets a new password, ends every session, and works once", async () => {
    await configureSmtp(database);
    const admin = await setUpAdmin(harness);
    const { secret } = await enrollTotp(admin);
    const visitor = new Browser(harness);
    const request = await visitor.post("/api/auth/request-password-reset", {
      email: EMAIL,
      redirectTo: `${ORIGIN}/admin/reset-password`,
    });
    expect(request.status).toBe(200);
    expect(harness.mail).toHaveLength(1);
    expect(harness.mail[0]).toMatchObject({ to: EMAIL });
    expect(harness.mail[0]?.subject).toContain("Mashkif: reset your password");
    const token = await resetTokenFromMail(visitor);
    const reset = await visitor.post("/api/auth/reset-password", {
      token,
      newPassword: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);
    expect(await admin.sessionState()).toBe("none");
    expect(await database.sql`select 1 from auth_session`).toHaveLength(0);
    // The old password no longer works; the new one does, still with TOTP.
    expect((await new Browser(harness).signIn(USERNAME, PASSWORD)).status).toBe(401);
    const browser = new Browser(harness);
    const signIn = await browser.signIn(USERNAME, NEW_PASSWORD);
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect(
      (await browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) })).status,
    ).toBe(200);
    // The link works once.
    const again = await visitor.post("/api/auth/reset-password", {
      token,
      newPassword: randomBytes(24).toString("base64url"),
    });
    expect(again.body.code).toBe("INVALID_TOKEN");
    expect(await actions()).toEqual(
      expect.arrayContaining([
        "password_reset.requested",
        "admin.password_reset",
        "admin.password_reset_failed",
      ]),
    );
  });

  it("an unknown address gets the same answer and no email", async () => {
    await configureSmtp(database);
    await setUpAdmin(harness);
    const reply = await new Browser(harness).post("/api/auth/request-password-reset", {
      email: "someone@example.test",
      redirectTo: `${ORIGIN}/admin/reset-password`,
    });
    expect(reply.status).toBe(200);
    expect(harness.mail).toHaveLength(0);
  });

  it("refuses a redirect to another origin", async () => {
    await configureSmtp(database);
    await setUpAdmin(harness);
    const reply = await new Browser(harness).post("/api/auth/request-password-reset", {
      email: EMAIL,
      redirectTo: "https://evil.test/admin/reset-password",
    });
    expect(reply.status).toBe(403);
    expect(harness.mail).toHaveLength(0);
  });

  it("rolls back when the password write fails: the token, the sessions, and the old password stay", async () => {
    await configureSmtp(database);
    const admin = await setUpAdmin(harness);
    await enrollTotp(admin);
    const visitor = new Browser(harness);
    await visitor.post("/api/auth/request-password-reset", {
      email: EMAIL,
      redirectTo: `${ORIGIN}/admin/reset-password`,
    });
    const token = await resetTokenFromMail(visitor);
    await database.sql.unsafe(`
      create function mashkif_test_fail() returns trigger language plpgsql as
        $$ begin raise exception 'password write failed'; end $$;
      create trigger mashkif_test_fail before update of password on auth_account
        for each row execute function mashkif_test_fail();`);
    try {
      const errors = captureErrors();
      const failed = await visitor.post("/api/auth/reset-password", {
        token,
        newPassword: NEW_PASSWORD,
      });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      // The failed query carries the new password hash; only its name and SQLSTATE are logged.
      expect(errors).toEqual([
        "request failed: POST /api/auth/reset-password: DrizzleQueryError (SQLSTATE P0001)",
      ]);
      expect(await admin.sessionState()).toBe("full");
      expect(
        await database.sql`select 1 from auth_verification where identifier = ${`reset-password:${token}`}`,
      ).toHaveLength(1);
    } finally {
      await database.sql.unsafe(`
        drop trigger mashkif_test_fail on auth_account;
        drop function mashkif_test_fail();`);
    }
    expect((await new Browser(harness).signIn(USERNAME, PASSWORD)).body.twoFactorRedirect).toBe(
      true,
    );
    // The same link works once the database accepts the write.
    const reset = await visitor.post("/api/auth/reset-password", {
      token,
      newPassword: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);
  });
});

describe("email change", () => {
  it("without SMTP, nothing changes and only the server log says why", async () => {
    const admin = await setUpAdmin(harness);
    await enrollTotp(admin);
    const errors = captureErrors();
    const reply = await admin.post("/api/auth/change-email", {
      newEmail: "new@example.test",
      callbackURL: "/admin",
    });
    expect(reply.status).toBe(200);
    expect(errors).toContain(
      "email change: no email sent, SMTP is not configured (admin panel, Settings)",
    );
    expect(String((await database.sql`select email from auth_user`)[0]?.email)).toBe(EMAIL);
  });

  it("takes effect only after the link sent to the new address is opened", async () => {
    await configureSmtp(database);
    const admin = await setUpAdmin(harness);
    await enrollTotp(admin);
    const request = await admin.post("/api/auth/change-email", {
      newEmail: "new@example.test",
      callbackURL: "/admin",
    });
    expect(request.status).toBe(200);
    expect(harness.mail.at(-1)?.to).toBe("new@example.test");
    const emailNow = async () =>
      String((await database.sql`select email from auth_user`)[0]?.email);
    expect(await emailNow()).toBe(EMAIL);
    const link = new URL(linkInMail());
    const opened = await admin.get(`${link.pathname}${link.search}`);
    expect(opened.status).toBe(302);
    expect(await emailNow()).toBe("new@example.test");
    expect(await actions()).toEqual(
      expect.arrayContaining(["email_change.requested", "email.changed"]),
    );
  });
});
