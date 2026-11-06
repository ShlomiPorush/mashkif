import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { expect } from "vitest";
import type { RegisterHooks } from "../../src/agent/register.js";
import { createApp } from "../../src/app.js";
import { type Auth, createAuth } from "../../src/auth/auth.js";
import type { AsnInfo, AsnLookup, GeoipStatus } from "../../src/geoip.js";
import { clientAddressResolver } from "../../src/http/client-address.js";
import { MemoryRateLimitStore } from "../../src/http/rate-limit.js";
import { createMailer, type MailMessage } from "../../src/mail/mailer.js";
import { panelTrustedOrigins } from "../../src/settings.js";
import type { TestDatabase } from "./database.js";
import { secretFromUri, totpCode } from "./totp.js";

export const ORIGIN = "https://admin.test";
export const USERNAME = "Shlomi";
/** The admin password of this test run; Better Auth takes 12 to 128 characters. */
export const PASSWORD = randomBytes(24).toString("base64url");
export const EMAIL = "admin@example.test";

const ok = async () => {};

/** An ASN table for tests: exact addresses or prefixes ending in "." or ":". */
export class FakeAsn implements AsnLookup {
  readonly table = new Map<string, AsnInfo>();
  lookup(address: string): AsnInfo | undefined {
    for (const [prefix, info] of this.table) {
      if (
        address === prefix ||
        ((prefix.endsWith(".") || prefix.endsWith(":")) && address.startsWith(prefix))
      ) {
        return info;
      }
    }
    return undefined;
  }
  status(): GeoipStatus {
    return { state: "ok", buildDate: "2026-10-28T00:00:00.000Z", stale: false };
  }
}

export interface Harness {
  app: Hono;
  auth: Auth;
  /** BETTER_AUTH_SECRET of this harness. */
  secret: string;
  /** Every email sent, newest last. */
  mail: MailMessage[];
  /** Makes the next sends fail as an SMTP server would. */
  mailFails: boolean;
  agentRateLimits: MemoryRateLimitStore;
  registerRateLimits: MemoryRateLimitStore;
  asn: FakeAsn;
  /** The TCP peer of the next requests; a request may set its own with x-test-client. */
  address: string;
  /** The server clock of the agent API; undefined means the real time. */
  now: Date | undefined;
}

export interface HarnessOptions {
  registerHooks?: RegisterHooks;
  /** Runs in an agent request after authentication, before the write transaction. */
  beforeWrite?: () => Promise<void>;
  /** Runs in a settings update after it read the current values, under its lock. */
  afterSettingsRead?: () => Promise<void>;
  /** Trusted proxies, for the agent API and Better Auth; the peer is x-test-client or harness.address. */
  trustedProxies?: string[];
  /** Environment overrides of settings. */
  env?: NodeJS.ProcessEnv;
  /** Better Auth session length. */
  sessionHours?: number;
  /** The public URL; null leaves it unset. Defaults to ORIGIN. */
  publicUrl?: string | null;
}

export function createHarness(database: TestDatabase, options: HarnessOptions = {}): Harness {
  const agentRateLimits = new MemoryRateLimitStore();
  const registerRateLimits = new MemoryRateLimitStore();
  const asn = new FakeAsn();
  const secret = randomBytes(32).toString("base64");
  const env = options.env ?? {};
  const publicUrl = options.publicUrl === null ? undefined : (options.publicUrl ?? ORIGIN);
  const mail: MailMessage[] = [];
  const auth = createAuth({
    db: database.db,
    secret,
    publicUrl,
    trustedOrigins: () => panelTrustedOrigins(database.db, env),
    trustedProxies: options.trustedProxies ?? [],
    sessionHours: options.sessionHours ?? 12,
    mailer: createMailer(database.db, secret, async (_smtp, message) => {
      if (harness.mailFails) {
        throw new Error("550 mailbox unavailable");
      }
      mail.push(message);
    }),
  });
  const harness: Harness = {
    app: undefined as unknown as Hono,
    auth,
    secret,
    mail,
    mailFails: false,
    agentRateLimits,
    registerRateLimits,
    asn,
    address: "198.51.100.10",
    now: undefined,
  };
  // The server's resolver, with the TCP peer taken from x-test-client.
  const clientAddress = clientAddressResolver(
    options.trustedProxies ?? [],
    (c) => c.req.header("x-test-client") ?? harness.address,
  );
  harness.app = createApp({
    readiness: { database: ok, geoip: ok },
    admin: {
      db: database.db,
      auth,
      authSecret: secret,
      publicUrl,
      env,
      clientAddress,
      asn,
      ...(options.afterSettingsRead === undefined
        ? {}
        : { testHooks: { afterSettingsRead: options.afterSettingsRead } }),
    },
    agent: {
      db: database.db,
      asn,
      rateLimits: agentRateLimits,
      clientAddress,
      now: () => harness.now ?? new Date(),
      registerRateLimits: registerRateLimits,
      testHooks: {
        ...options.registerHooks,
        ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }),
      },
    },
  });
  return harness;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  setCookies: string[];
}

interface RequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
  /** Defaults to the public origin for mutations; null sends none. */
  origin?: string | null;
}

let nextAddress = 1;

/** A fresh client address, so Better Auth's rate limits of one browser never touch another. */
export function uniqueAddress(): string {
  const n = nextAddress++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/**
 * A browser with a cookie jar, talking to the app in-process. Better Auth
 * reads its client address from X-Forwarded-For, which each browser sets to
 * its own address.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  address = uniqueAddress();
  /** Every Set-Cookie header this browser received. */
  readonly seenSetCookies: string[] = [];

  constructor(private readonly harness: Harness) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      "user-agent": "vitest",
      "x-forwarded-for": this.address,
      ...options.headers,
    };
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (method !== "GET" && origin !== null) {
      headers.origin = origin;
    }
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    let body: string | undefined;
    if (options.json !== undefined && method !== "GET") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const response = await this.harness.app.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      this.seenSetCookies.push(line);
      const [pair = ""] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/;\s*max-age=0(;|$)/i.test(line) || value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return {
      status: response.status,
      body: (parsed ?? {}) as Record<string, unknown>,
      setCookies,
    };
  }

  get(path: string, options?: RequestOptions) {
    return this.request("GET", path, options);
  }

  post(path: string, json: unknown = {}, options: RequestOptions = {}) {
    return this.request("POST", path, { ...options, json });
  }

  /** Better Auth's session: none, without TOTP (enrollment), or with TOTP (full). */
  async sessionState(): Promise<"none" | "enrollment" | "full"> {
    const reply = await this.get("/api/auth/get-session");
    const user = (reply.body as { user?: { twoFactorEnabled?: boolean } } | null)?.user;
    if (user === undefined) {
      return "none";
    }
    return user.twoFactorEnabled === true ? "full" : "enrollment";
  }

  signIn(username = USERNAME, password = PASSWORD) {
    return this.post("/api/auth/sign-in/username", { username, password });
  }
}

/** Creates the admin through Better Auth sign-up, as the setup page does; returns its browser. */
export async function setUpAdmin(harness: Harness): Promise<Browser> {
  const browser = new Browser(harness);
  const reply = await browser.post("/api/auth/sign-up/email", {
    name: USERNAME,
    username: USERNAME,
    email: EMAIL,
    password: PASSWORD,
  });
  expect(reply.status).toBe(200);
  return browser;
}

export interface Enrollment {
  secret: Buffer;
  backupCodes: string[];
}

/** Enrolls TOTP in a signed-in browser (signing in with the password first when needed). */
export async function enrollTotp(browser: Browser, password = PASSWORD): Promise<Enrollment> {
  if ((await browser.sessionState()) === "none") {
    expect((await browser.signIn(USERNAME, password)).status).toBe(200);
  }
  const enable = await browser.post("/api/auth/two-factor/enable", { password });
  expect(enable.status).toBe(200);
  const secret = secretFromUri(String(enable.body.totpURI));
  const verify = await browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) });
  expect(verify.status).toBe(200);
  return { secret, backupCodes: enable.body.backupCodes as string[] };
}

/** Signs in with the password and a TOTP code. */
export async function signInWithTotp(browser: Browser, secret: Buffer): Promise<Reply> {
  const signIn = await browser.signIn();
  expect(signIn.status).toBe(200);
  expect(signIn.body.twoFactorRedirect).toBe(true);
  return browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) });
}

/** Sets the SMTP host and sender, so Better Auth's emails reach the fake transport. */
export async function configureSmtp(database: TestDatabase): Promise<void> {
  await database.sql`insert into setting (key, value, updated_by) values
    ('smtp_host', '"smtp.example.test"', 'test'),
    ('smtp_from', '"mashkif@example.test"', 'test')`;
}

/** A test seam that stops the first call until resume() and reports when it was reached. */
export function pauseOnce() {
  let armed = true;
  let reached = () => {};
  let resume = () => {};
  const atPause = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    hook: async () => {
      if (armed) {
        armed = false;
        reached();
        await released;
      }
    },
    atPause,
    resume: () => resume(),
  };
}

/** Waits up to 2 seconds until a request waits for an advisory lock in PostgreSQL. */
export async function untilLockWaiter(sql: TestDatabase["sql"]): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const [row] = await sql`select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`;
    if ((row?.n ?? 0) > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
