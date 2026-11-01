import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUTH_ROUTES } from "../src/auth/routes.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import {
  Browser,
  createHarness,
  enrollTotp,
  type Harness,
  ORIGIN,
  PASSWORD,
  setUpAdmin,
  signInWithTotp,
  USERNAME,
} from "./support/harness.js";
import { secretFromUri, totpCode } from "./support/totp.js";

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
  await setUpAdmin(database, harness);
});

async function auditActions(): Promise<string[]> {
  const rows = await database.sql`select action from audit_log order by id`;
  return rows.map((row) => String(row.action));
}

async function sessionRows() {
  return database.sql`select id, assurance from auth_session order by created_at`;
}

describe("blocked Better Auth routes", () => {
  it.each([
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/change-password"],
    ["POST", "/api/auth/two-factor/disable"],
    ["POST", "/api/auth/two-factor/verify-backup-code"],
    ["POST", "/api/auth/two-factor/generate-backup-codes"],
    ["POST", "/api/auth/two-factor/get-totp-uri"],
    ["POST", "/api/auth/two-factor/send-otp"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/delete-user"],
    ["POST", "/api/auth/change-email"],
    ["POST", "/api/auth/request-password-reset"],
    ["POST", "/api/auth/reset-password"],
    ["GET", "/api/auth/reset-password/some-token"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/revoke-sessions"],
    ["POST", "/api/auth/passkey/update-passkey"],
    ["GET", "/api/auth/sign-in/username"],
    ["GET", "/api/auth/ok"],
  ])("%s %s is 404", async (method, path) => {
    const browser = new Browser(harness);
    await signInWithTotp(browser, await enrollTotp(browser));
    const reply = await browser.request(method, path, {
      json: { email: "x@example.com", password: PASSWORD, name: "x" },
    });
    expect(reply).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("sign-up never creates a user", async () => {
    await database.sql`delete from auth_user`;
    const reply = await new Browser(harness).post("/api/auth/sign-up/email", {
      email: "x@example.com",
      password: PASSWORD,
      name: "x",
    });
    expect(reply.status).toBe(404);
    expect(await database.sql`select 1 from auth_user`).toHaveLength(0);
    // Even past the route allowlist, Better Auth itself refuses sign-up.
    await expect(
      harness.auth.api.signUpEmail({
        body: { email: "x@example.com", password: PASSWORD, name: "x" },
      }),
    ).rejects.toThrow();
    expect(await database.sql`select 1 from auth_user`).toHaveLength(0);
  });
});

describe("session states", () => {
  it("without a session, nothing but sign-in is allowed", async () => {
    const browser = new Browser(harness);
    expect(await browser.sessionState()).toBe("none");
    expect((await browser.get(FULL_ONLY)).body).toMatchObject({ error: "session_required" });
    expect((await browser.post("/api/auth/two-factor/enable", { password: PASSWORD })).status).toBe(
      401,
    );
    expect((await browser.get("/api/auth/passkey/generate-register-options")).status).toBe(401);
    expect((await browser.get("/api/auth/passkey/list-user-passkeys")).status).toBe(401);
  });

  it("before TOTP is enrolled, a password session may only enroll TOTP", async () => {
    const browser = new Browser(harness);
    const signIn = await browser.signIn();
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBeUndefined();
    expect(await browser.sessionState()).toBe("enrollment");
    expect((await browser.get(FULL_ONLY)).body).toMatchObject({ error: "totp_required" });
    expect((await browser.get("/api/auth/passkey/generate-register-options")).body).toMatchObject({
      error: "totp_required",
    });
    expect((await browser.get("/api/auth/passkey/list-user-passkeys")).status).toBe(403);
    expect(await auditActions()).toContain("sign_in.succeeded");

    const enable = await browser.post("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status).toBe(200);
    expect(String(enable.body.totpURI)).toMatch(/^otpauth:\/\/totp\/Mashkif:/);
    // Audited like every credential change, and the secret is never logged.
    const rows = await database.sql`select action, details from audit_log order by id`;
    expect(rows.slice(-2).map((row) => row.action)).toEqual([
      "credential_change.started",
      "totp.secret_created",
    ]);
    const secret = new URL(String(enable.body.totpURI)).searchParams.get("secret") ?? "";
    expect(secret.length).toBeGreaterThan(10);
    expect(JSON.stringify(rows)).not.toContain(secret);
    // Still enrollment until a code is verified.
    expect(await browser.sessionState()).toBe("enrollment");
  });

  it("enrolling TOTP turns the session into a full one and ends other password sessions", async () => {
    const other = new Browser(harness);
    expect((await other.signIn()).status).toBe(200);
    expect(await other.sessionState()).toBe("enrollment");

    const browser = new Browser(harness);
    await enrollTotp(browser);
    expect(await browser.sessionState()).toBe("full");
    expect((await browser.get(FULL_ONLY)).status).toBe(200);
    expect(await sessionRows()).toEqual([expect.objectContaining({ assurance: "totp" })]);
    // The password-only session from the other browser is gone.
    expect(await other.sessionState()).toBe("none");
    expect((await other.post("/api/auth/two-factor/enable", { password: PASSWORD })).status).toBe(
      401,
    );
    expect(await auditActions()).toContain("totp.enrolled");
  });

  it("after enrollment, the password alone gives no session, and TOTP completes the sign-in", async () => {
    const secret = await enrollTotp(new Browser(harness));
    const browser = new Browser(harness);
    const signIn = await browser.signIn();
    expect(signIn.body).toMatchObject({ twoFactorRedirect: true });
    expect([...browser.cookies.keys()]).toEqual(["__Host-mashkif.two_factor"]);
    expect(await browser.sessionState()).toBe("none");
    expect((await browser.get(FULL_ONLY)).status).toBe(401);

    const wrong = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totpCode(secret, Date.now(), 10),
    });
    expect(wrong.status).toBe(401);
    expect(await browser.sessionState()).toBe("none");

    const right = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totpCode(secret),
    });
    expect(right.status).toBe(200);
    expect(await browser.sessionState()).toBe("full");
    const actions = await auditActions();
    expect(actions).toContain("sign_in.failed");
    expect(actions.at(-1)).toBe("sign_in.succeeded");
  });

  it("an enrollment-only route is refused to a full session", async () => {
    const browser = new Browser(harness);
    await enrollTotp(browser);
    const reply = await browser.post("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(reply).toMatchObject({ status: 403, body: { error: "not_allowed" } });
  });

  it("a wrong password is refused and audited without the typed username", async () => {
    const browser = new Browser(harness);
    const reply = await browser.signIn(USERNAME, "wrong password!");
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("INVALID_USERNAME_OR_PASSWORD");
    const [row] = await database.sql`select actor, action, details from audit_log
      where action = 'sign_in.failed'`;
    expect(row).toMatchObject({ actor: "-", details: { step: "password", status: 401 } });
  });

  it("refuses trustDevice, so TOTP is never skipped", async () => {
    const secret = await enrollTotp(new Browser(harness));
    const browser = new Browser(harness);
    await browser.signIn();
    const reply = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totpCode(secret),
      trustDevice: true,
    });
    expect(reply).toMatchObject({ status: 400, body: { error: "trust_device_unsupported" } });
  });

  it("sign-out ends the session", async () => {
    const browser = new Browser(harness);
    await enrollTotp(browser);
    const reply = await browser.post("/api/auth/sign-out");
    expect(reply.status).toBe(200);
    expect(await browser.sessionState()).toBe("none");
    expect(await sessionRows()).toHaveLength(0);
    expect(await auditActions()).toContain("sign_out");
  });
});

describe("session limits", () => {
  it("ends a session after 1 hour without activity", async () => {
    const browser = new Browser(harness);
    await enrollTotp(browser);
    await database.sql`update auth_session set last_active_at = now() - interval '59 minutes'`;
    expect(await browser.sessionState()).toBe("full");
    await database.sql`update auth_session set last_active_at = now() - interval '61 minutes'`;
    const reply = await browser.get("/api/admin/session");
    expect(reply.body).toEqual({ state: "none", ended: "idle" });
    expect(await sessionRows()).toHaveLength(0);
  });

  it("ends a session 12 hours after sign-in, even when active", async () => {
    const browser = new Browser(harness);
    await enrollTotp(browser);
    await database.sql`update auth_session set authenticated_at = now() - interval '12 hours 1 minute'`;
    expect((await browser.get("/api/admin/session")).body).toEqual({
      state: "none",
      ended: "max_age",
    });
    expect((await browser.get(FULL_ONLY)).status).toBe(401);
  });

  it("Better Auth's own expiry is 12 hours and is never extended", async () => {
    const browser = new Browser(harness);
    await enrollTotp(browser);
    const [row] = await database.sql`select expires_at, created_at from auth_session`;
    const lifetime =
      new Date(String(row?.expires_at)).getTime() - new Date(String(row?.created_at)).getTime();
    expect(Math.abs(lifetime - 12 * 3600 * 1000)).toBeLessThan(5000);
  });

  it("activity restarts the idle limit", async () => {
    const browser = new Browser(harness);
    await enrollTotp(browser);
    await database.sql`update auth_session set last_active_at = now() - interval '50 minutes'`;
    expect((await browser.get(FULL_ONLY)).status).toBe(200);
    const [row] =
      await database.sql`select now() - last_active_at < interval '1 minute' as fresh from auth_session`;
    expect(row?.fresh).toBe(true);
  });

  it("TOTP enrollment replaces the session but keeps its sign-in time", async () => {
    const browser = new Browser(harness);
    expect((await browser.signIn()).status).toBe(200);
    await database.sql`update auth_session set authenticated_at = now() - interval '3 hours'`;
    const enable = await browser.post("/api/auth/two-factor/enable", { password: PASSWORD });
    const secret = secretFromUri(String(enable.body.totpURI));
    const verify = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totpCode(secret),
    });
    expect(verify.status).toBe(200);
    expect(await browser.sessionState()).toBe("full");
    const [row] = await database.sql`select assurance,
      now() - authenticated_at > interval '2 hours' as kept from auth_session`;
    expect(row).toMatchObject({ assurance: "totp", kept: true });
  });
});

describe("cookies", () => {
  it("every auth cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/, without Domain", async () => {
    const browser = new Browser(harness);
    const secret = await enrollTotp(browser);
    await browser.post("/api/auth/sign-out");
    await signInWithTotp(browser, secret);
    await browser.get("/api/auth/passkey/generate-register-options");
    await new Browser(harness).get("/api/auth/passkey/generate-authenticate-options");
    await browser.post("/api/auth/sign-out");

    const names = new Set<string>();
    for (const line of browser.seenSetCookies) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      names.add(pair.slice(0, pair.indexOf("=")));
      const lower = attributes.map((attribute) => attribute.toLowerCase());
      expect(pair, line).toMatch(/^__Host-mashkif\./);
      expect(lower, line).toContain("secure");
      expect(lower, line).toContain("httponly");
      expect(lower, line).toContain("samesite=strict");
      expect(lower, line).toContain("path=/");
      expect(
        lower.some((attribute) => attribute.startsWith("domain=")),
        line,
      ).toBe(false);
    }
    expect(names).toEqual(
      new Set([
        "__Host-mashkif.session_token",
        "__Host-mashkif.two_factor",
        "__Host-mashkif.better-auth-passkey",
        // Expired by sign-out.
        "__Host-mashkif.session_data",
        "__Host-mashkif.dont_remember",
      ]),
    );
  });
});

describe("origin check", () => {
  const mutations = Object.entries(AUTH_ROUTES)
    .filter(([, rule]) => rule.method === "POST")
    .map(([path]) => path);

  it.each(mutations)("POST /api/auth%s from another origin is refused", async (path) => {
    const browser = new Browser(harness);
    await enrollTotp(browser);
    for (const origin of ["https://evil.example", "http://admin.test", null]) {
      const reply = await browser.post(`/api/auth${path}`, {}, { origin });
      expect(reply).toMatchObject({ status: 403, body: { error: "origin_rejected" } });
    }
    const crossSite = await browser.post(
      `/api/auth${path}`,
      {},
      {
        headers: { "sec-fetch-site": "cross-site" },
      },
    );
    expect(crossSite.status).toBe(403);
    expect(await browser.sessionState()).toBe("full");
  });

  it("a cross-origin sign-in never reaches the password check", async () => {
    const reply = await new Browser(harness).post(
      "/api/auth/sign-in/username",
      { username: USERNAME, password: PASSWORD },
      { origin: "https://evil.example" },
    );
    expect(reply.status).toBe(403);
    expect(reply.setCookies).toEqual([]);
  });
});

describe("rate limits", () => {
  it("locks sign-in after 5 attempts in 5 minutes, even with the right password", async () => {
    const browser = new Browser(harness);
    for (let i = 0; i < 5; i++) {
      expect((await browser.signIn(USERNAME, `wrong password ${i}`)).status).toBe(401);
    }
    const locked = await browser.signIn();
    expect(locked.status).toBe(429);
    expect(await auditActions()).toContain("sign_in.rate_limited");
    // Another address is not affected.
    harness.address = "203.0.113.20";
    expect((await new Browser(harness).signIn()).status).toBe(200);
  });

  it("locks TOTP verification after 5 attempts in 5 minutes", async () => {
    const secret = await enrollTotp(new Browser(harness));
    harness.rateLimits.clear();
    const browser = new Browser(harness);
    await browser.signIn();
    for (let i = 0; i < 5; i++) {
      const reply = await browser.post("/api/auth/two-factor/verify-totp", { code: "000000" });
      expect(reply.status).toBe(401);
    }
    const locked = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totpCode(secret),
    });
    expect(locked.status).toBe(429);
    expect(await browser.sessionState()).toBe("none");
  });

  it("ignores a client-supplied address header", async () => {
    const browser = new Browser(harness);
    for (let i = 0; i < 5; i++) {
      await browser.signIn(USERNAME, "wrong password!");
    }
    const spoofed = await browser.request("POST", "/api/auth/sign-in/username", {
      json: { username: USERNAME, password: PASSWORD },
      headers: { "x-mashkif-client-address": "192.0.2.99", "x-forwarded-for": "192.0.2.98" },
    });
    expect(spoofed.status).toBe(429);
  });
});

describe("interrupted TOTP enrollment", () => {
  // Better Auth sets two_factor_enabled before it marks the secret verified,
  // without a transaction. These tests stop in between.
  async function interruptedEnrollment(): Promise<Browser> {
    const browser = new Browser(harness);
    expect((await browser.signIn()).status).toBe(200);
    expect((await browser.post("/api/auth/two-factor/enable", { password: PASSWORD })).status).toBe(
      200,
    );
    await database.sql`update auth_user set two_factor_enabled = true`;
    return browser;
  }

  it("does not lock the admin out at the next sign-in", async () => {
    const stale = await interruptedEnrollment();
    expect(await stale.sessionState()).toBe("enrollment");

    const browser = new Browser(harness);
    const signIn = await browser.signIn();
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBeUndefined();
    const [row] = await database.sql`select two_factor_enabled,
      (select count(*)::int from auth_two_factor) as secrets from auth_user`;
    expect(row).toEqual({ two_factor_enabled: false, secrets: 0 });
    expect(await browser.sessionState()).toBe("enrollment");

    const enable = await browser.post("/api/auth/two-factor/enable", { password: PASSWORD });
    const secret = secretFromUri(String(enable.body.totpURI));
    expect(
      (await browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) })).status,
    ).toBe(200);
    expect(await browser.sessionState()).toBe("full");
  });

  it("lets the same session enroll again", async () => {
    const browser = await interruptedEnrollment();
    const enable = await browser.post("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status).toBe(200);
    const secret = secretFromUri(String(enable.body.totpURI));
    expect(
      (await browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) })).status,
    ).toBe(200);
    expect(await browser.sessionState()).toBe("full");
  });
});

describe("request size", () => {
  const oversized = JSON.stringify({ username: USERNAME, password: "x".repeat(20 * 1024) });
  const headers = { origin: ORIGIN, "content-type": "application/json" };
  const stream = (text: string) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  const send = (path: string, init: RequestInit & { duplex?: "half" }) =>
    harness.app.request(`${ORIGIN}${path}`, { method: "POST", ...init });

  it.each(["/api/auth/sign-in/username", "/api/auth/two-factor/verify-totp", "/api/admin/setup"])(
    "refuses an oversized body to %s, with and without Content-Length",
    async (path) => {
      const declared = await send(path, {
        headers: { ...headers, "content-length": String(oversized.length) },
        body: oversized,
      });
      expect(declared.status).toBe(413);
      const streamed = await send(path, { headers, body: stream(oversized), duplex: "half" });
      expect(streamed.status).toBe(413);
      expect(await streamed.json()).toEqual({ error: "payload_too_large" });
    },
  );

  it("accepts a streamed body under the limit", async () => {
    const reply = await send("/api/auth/sign-in/username", {
      headers,
      body: stream(JSON.stringify({ username: USERNAME, password: PASSWORD })),
      duplex: "half",
    });
    expect(reply.status).toBe(200);
  });
});
