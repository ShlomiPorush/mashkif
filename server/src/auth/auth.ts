import { AsyncLocalStorage } from "node:async_hooks";
import { hkdfSync } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { verifyPassword } from "better-auth/crypto";
import { twoFactor, username } from "better-auth/plugins";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { SessionAssurance } from "../db/schema.js";
import * as schema from "../db/schema.js";
import { describeSafely } from "../errors.js";
import { MemoryRateLimitStore } from "./rate-limit.js";

/** Better Auth routes live under this path on the public origin. */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * Request header carrying the client address that Mashkif determined itself
 * (src/http/client-address.ts). Any value a client sends is replaced, so
 * Better Auth's rate limits and session records cannot be fed a forged address.
 */
export const CLIENT_ADDRESS_HEADER = "x-mashkif-client-address";

/** Absolute session limit: 12 hours from sign-in. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
/** Idle session limit: 1 hour without an admin request. */
export const SESSION_IDLE_SECONDS = 60 * 60;

/** Sign-in and second-factor attempts: 5 per 5 minutes per client address. */
export const SIGN_IN_RATE_LIMIT = { window: 300, max: 5 } as const;

/** Prefix of every auth cookie: host-only, Secure, Path=/ (RFC 6265bis). */
export const COOKIE_PREFIX = "__Host-mashkif";

export const PASSKEY_USER_VERIFICATION_REQUIRED = "PASSKEY_USER_VERIFICATION_REQUIRED";

/** The previous session when Better Auth replaces one, set by the auth routes. */
export interface PriorSession {
  assurance: SessionAssurance;
  authenticatedAt: Date;
}
export const priorSession = new AsyncLocalStorage<PriorSession | undefined>();

export interface AuthOptions {
  db: Db;
  appKey: Buffer;
  /** Origin of the web app, for example https://mashkif.co.il. */
  publicOrigin: string;
  /** Test seams: run inside a sign-in after its check passed, before the session exists. */
  testHooks?: { afterPasswordCheck?: () => Promise<void>; afterPasskeyCheck?: () => Promise<void> };
  rateLimitStore?: MemoryRateLimitStore;
}

/** Derives the Better Auth secret from MASHKIF_APP_KEY, so the key itself is never used directly. */
export function deriveAuthSecret(appKey: Buffer): string {
  return Buffer.from(hkdfSync("sha256", appKey, "mashkif", "better-auth", 32)).toString("base64");
}

/**
 * Better Auth's log lines. Database errors carry SQL parameters such as
 * session tokens and password hashes, and Better Auth logs some of them as a
 * plain message ("Failed query: ... params: ..."). Such a message is replaced
 * by a fixed text, and errors passed along are reduced by describeSafely.
 */
export function logAuthEvent(level: string, message: unknown, ...args: unknown[]): void {
  const text = String(message);
  const safe = /failed query|params:|column|relation|table/i.test(text) ? "database error" : text;
  const errors = args.filter((arg) => arg instanceof Error).map(describeSafely);
  const line = `[Better Auth] ${level.toUpperCase()}: ${safe}${errors.length > 0 ? ` (${errors.join("; ")})` : ""}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function userVerificationRequired(): APIError {
  return APIError.from("UNAUTHORIZED", {
    code: PASSKEY_USER_VERIFICATION_REQUIRED,
    message: "The passkey did not verify the user (PIN or biometrics).",
  });
}

/**
 * Better Auth for Mashkif's single admin: username and password, mandatory
 * TOTP, and passkeys with user verification. Which session may do what is
 * decided in src/auth/session-policy.ts and src/auth/routes.ts.
 */
export function createAuth(options: AuthOptions) {
  const { db, publicOrigin } = options;
  const rateLimitStore = options.rateLimitStore ?? new MemoryRateLimitStore();

  /**
   * Records how a new session was established. TOTP and passkey sign-ins are
   * full sessions. A session that replaces another one (TOTP enrollment)
   * keeps the sign-in time, so the absolute limit is not
   * reset, and keeps its assurance unless the request itself verified TOTP.
   */
  const recordAssurance = createAuthMiddleware(async (ctx) => {
    const created = ctx.context.newSession;
    if (!created || ctx.path.startsWith("/sign-in/")) {
      return;
    }
    const prior = priorSession.getStore();
    let assurance: SessionAssurance = prior?.assurance ?? "password";
    if (ctx.path === "/two-factor/verify-totp") {
      assurance = "totp";
    } else if (ctx.path === "/passkey/verify-authentication") {
      assurance = "passkey";
    }
    await db
      .update(schema.session)
      .set({
        assurance,
        ...(prior === undefined ? {} : { authenticatedAt: prior.authenticatedAt }),
      })
      .where(eq(schema.session.id, created.session.id));
    if (ctx.path === "/two-factor/verify-totp" && prior !== undefined) {
      // TOTP was just enrolled. Every other session of the admin ends, also a
      // strong one that a sign-in under way before a reset might have left.
      await db
        .delete(schema.session)
        .where(
          and(
            eq(schema.session.userId, created.user.id),
            ne(schema.session.id, created.session.id),
          ),
        );
    }
  });

  const auth = betterAuth({
    appName: "Mashkif",
    secret: deriveAuthSecret(options.appKey),
    baseURL: publicOrigin,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [publicOrigin],
    telemetry: { enabled: false },
    logger: { log: logAuthEvent },
    // Errors other than API errors go to the app's error handler, which logs them
    // without query parameters; otherwise the router prints them whole.
    onAPIError: { throw: true },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        passkey: schema.passkey,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // The admin is created by the setup route, never by sign-up.
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        verify: async (data) => {
          const valid = await verifyPassword(data);
          if (valid) {
            await options.testHooks?.afterPasswordCheck?.();
          }
          return valid;
        },
      },
    },
    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      // The expiry is fixed at sign-in; the idle limit is Mashkif's own.
      disableSessionRefresh: true,
      freshAge: SESSION_MAX_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: rateLimitStore,
      customRules: {
        "/sign-in/username": SIGN_IN_RATE_LIMIT,
        "/two-factor/verify-totp": SIGN_IN_RATE_LIMIT,
        "/passkey/verify-authentication": SIGN_IN_RATE_LIMIT,
      },
    },
    advanced: {
      // No __Secure- prefix: the prefix below is __Host-, which needs Secure,
      // Path=/, and no Domain, set explicitly for every cookie.
      useSecureCookies: false,
      cookiePrefix: COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, sameSite: "strict", path: "/", httpOnly: true },
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
    },
    hooks: { after: recordAssurance },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 30 }),
      twoFactor({ issuer: "Mashkif" }),
      passkey({
        rpID: new URL(publicOrigin).hostname,
        rpName: "Mashkif",
        origin: publicOrigin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        // The plugin verifies with requireUserVerification: false. These
        // hooks run after the signature check and before the passkey or the
        // session is stored, and refuse a response without the UV flag.
        registration: {
          afterVerification: ({ verification }) => {
            if (verification.registrationInfo?.userVerified !== true) {
              throw userVerificationRequired();
            }
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (verification.authenticationInfo.userVerified !== true) {
              throw userVerificationRequired();
            }
            await options.testHooks?.afterPasskeyCheck?.();
          },
        },
      }),
    ],
  });
  return Object.assign(auth, { rateLimitStore });
}

export type Auth = ReturnType<typeof createAuth>;
