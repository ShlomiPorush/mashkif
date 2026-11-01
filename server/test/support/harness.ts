import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { expect } from "vitest";
import { createSetupToken } from "../../src/admin/setup.js";
import { createApp } from "../../src/app.js";
import { type Auth, type AuthOptions, createAuth } from "../../src/auth/auth.js";
import { MemoryRateLimitStore } from "../../src/auth/rate-limit.js";
import type { TestDatabase } from "./database.js";
import { secretFromUri, totpCode } from "./totp.js";

export const ORIGIN = "https://admin.test";
export const USERNAME = "Shlomi";
export const PASSWORD = "correct horse battery";

const ok = async () => {};

export interface Harness {
  app: Hono;
  auth: Auth;
  rateLimits: MemoryRateLimitStore;
  /** The client address the next requests come from. */
  address: string;
}

export function createHarness(
  database: TestDatabase,
  testHooks?: AuthOptions["testHooks"],
  bodyTimeoutMs?: number,
): Harness {
  const rateLimits = new MemoryRateLimitStore();
  const auth = createAuth({
    db: database.db,
    appKey: randomBytes(32),
    publicOrigin: ORIGIN,
    rateLimitStore: rateLimits,
    ...(testHooks === undefined ? {} : { testHooks }),
  });
  const harness: Harness = {
    app: undefined as unknown as Hono,
    auth,
    rateLimits,
    address: "198.51.100.10",
  };
  harness.app = createApp({
    readiness: { database: ok, geoip: ok },
    admin: {
      db: database.db,
      auth,
      publicOrigin: ORIGIN,
      // A test may give a request its own address with this header.
      clientAddress: (c) => c.req.header("x-test-client") ?? harness.address,
      ...(bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs }),
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

/** A browser with a cookie jar, talking to the app in-process. */
export class Browser {
  readonly cookies = new Map<string, string>();
  /** Every Set-Cookie header this browser received. */
  readonly seenSetCookies: string[] = [];

  constructor(private readonly harness: Harness) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { "user-agent": "vitest", ...options.headers };
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

  async sessionState(): Promise<string> {
    const reply = await this.get("/api/admin/session");
    return String(reply.body.state);
  }

  signIn(username = USERNAME, password = PASSWORD) {
    return this.post("/api/auth/sign-in/username", { username, password });
  }
}

/** Creates the admin through the setup route. */
export async function setUpAdmin(database: TestDatabase, harness: Harness): Promise<void> {
  const token = await createSetupToken(database.db);
  if (!token.ok) {
    throw new Error("an admin exists already");
  }
  const reply = await new Browser(harness).post("/api/admin/setup", {
    token: token.token,
    username: USERNAME,
    password: PASSWORD,
  });
  expect(reply.status).toBe(201);
}

/** Signs in with the password and enrolls TOTP; returns the TOTP secret. */
export async function enrollTotp(browser: Browser, password = PASSWORD): Promise<Buffer> {
  const signIn = await browser.signIn(USERNAME, password);
  expect(signIn.status).toBe(200);
  const enable = await browser.post("/api/auth/two-factor/enable", { password });
  expect(enable.status).toBe(200);
  const secret = secretFromUri(String(enable.body.totpURI));
  const verify = await browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) });
  expect(verify.status).toBe(200);
  return secret;
}

/** Signs in with the password and a TOTP code. */
export async function signInWithTotp(browser: Browser, secret: Buffer): Promise<Reply> {
  const signIn = await browser.signIn();
  expect(signIn.status).toBe(200);
  expect(signIn.body.twoFactorRedirect).toBe(true);
  return browser.post("/api/auth/two-factor/verify-totp", { code: totpCode(secret) });
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

/** Waits up to 2 seconds until a request waits for the admin lock in PostgreSQL. */
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
