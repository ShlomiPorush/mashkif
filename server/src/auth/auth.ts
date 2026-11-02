import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getIP, isAPIError } from "better-auth/api";
import { twoFactor, username } from "better-auth/plugins";
import { count } from "drizzle-orm";
import { type AuditEntry, writeAudit } from "../audit.js";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { describeSafely } from "../errors.js";
import { type Mailer, MailNotConfiguredError } from "../mail/mailer.js";
import { resetPasswordMessage, verifyEmailMessage } from "../mail/messages.js";

/** Better Auth routes live under this path on the public origin. */
export const AUTH_BASE_PATH = "/api/auth";

/** Sign-in, second-factor, and reset requests: 5 per 5 minutes per client address. */
export const SIGN_IN_RATE_LIMIT = { window: 300, max: 5 } as const;

export interface AuthOptions {
  db: Db;
  /** BETTER_AUTH_SECRET. */
  secret: string;
  /** The public URL; undefined lets Better Auth infer it from each request. */
  publicUrl: string | undefined;
  /** Origins trusted besides the public URL, read for each request (admin panel). */
  trustedOrigins: () => Promise<string[]>;
  /** Reverse proxies whose X-Forwarded-For Better Auth believes. */
  trustedProxies: string[];
  sessionHours: number;
  mailer: Mailer;
}

/**
 * Sends an email for Better Auth. Better Auth answers the request with success
 * even when sending fails, so the cause goes to the server log here, once.
 */
async function deliver(mailer: Mailer, message: Parameters<Mailer["send"]>[0], what: string) {
  try {
    await mailer.send(message);
  } catch (error) {
    if (error instanceof MailNotConfiguredError) {
      console.error(`${what}: no email sent, SMTP is not configured (admin panel, Settings)`);
    } else {
      console.error(`${what}: sending the email failed: ${describeSafely(error)}`);
    }
  }
}

type AuditDraft = Omit<AuditEntry, "ipAddress" | "userAgent">;

interface AdminUser {
  name: string;
  username?: string | null;
  twoFactorEnabled?: boolean | null;
}

function actorOf(user: AdminUser | undefined): string {
  return user === undefined ? "-" : (user.username ?? user.name);
}

/**
 * Better Auth for Mashkif's single admin, configured with Better Auth's own
 * options: username and password, TOTP with backup codes, passkeys, password
 * reset and email change by email, and its rate limits.
 */
export function createAuth(options: AuthOptions) {
  const { db, mailer, publicUrl } = options;

  /** The audit entry of a finished Better Auth request, if any. */
  const auditFor = (
    path: string,
    failed: boolean,
    signedIn: AdminUser | undefined,
    created: AdminUser | undefined,
  ): AuditDraft | undefined => {
    const actor = actorOf(signedIn);
    const signInFailed = (step: string): AuditDraft => ({
      actor: "-",
      action: "sign_in.failed",
      details: { step },
    });
    const succeeded = (method: string): AuditDraft => ({
      actor: actorOf(created),
      action: "sign_in.succeeded",
      details: { method },
    });
    switch (path) {
      case "/sign-up/email":
        return failed ? undefined : { actor: actorOf(created), action: "admin.created" };
      case "/sign-in/username":
        if (failed) {
          return signInFailed("password");
        }
        // With TOTP enrolled, the TOTP step completes the sign-in.
        return created?.twoFactorEnabled === true ? undefined : succeeded("password");
      case "/two-factor/verify-totp":
        if (signedIn !== undefined) {
          return failed ? undefined : { actor, action: "totp.enrolled" };
        }
        return failed ? signInFailed("totp") : succeeded("password_totp");
      case "/two-factor/verify-backup-code":
        return failed ? signInFailed("backup_code") : succeeded("backup_code");
      case "/passkey/verify-authentication":
        return failed ? signInFailed("passkey") : succeeded("passkey");
      case "/two-factor/enable":
        return failed ? undefined : { actor, action: "totp.secret_created" };
      case "/two-factor/disable":
        return failed ? undefined : { actor, action: "totp.disabled" };
      case "/two-factor/generate-backup-codes":
        return failed ? undefined : { actor, action: "backup_codes.generated" };
      case "/passkey/verify-registration":
        return failed ? undefined : { actor, action: "passkey.added" };
      case "/passkey/delete-passkey":
        return failed ? undefined : { actor, action: "passkey.removed" };
      case "/change-password":
        return failed ? undefined : { actor, action: "password.changed" };
      case "/request-password-reset":
        return failed ? undefined : { actor: "-", action: "password_reset.requested" };
      case "/reset-password":
        return {
          actor: "-",
          action: failed ? "admin.password_reset_failed" : "admin.password_reset",
        };
      case "/change-email":
        return failed ? undefined : { actor, action: "email_change.requested" };
      case "/sign-out":
        return failed ? undefined : { actor, action: "sign_out" };
      default:
        return undefined;
    }
  };

  const audit = createAuthMiddleware(async (ctx) => {
    const returned = ctx.context.returned;
    // A redirect is an APIError too; only an error status is a failure.
    const failed = isAPIError(returned) && returned.statusCode >= 400;
    const entry = auditFor(
      ctx.path,
      failed,
      ctx.context.session?.user as AdminUser | undefined,
      ctx.context.newSession?.user as AdminUser | undefined,
    );
    if (entry === undefined) {
      return;
    }
    const source = ctx.request ?? ctx.headers;
    await writeAudit(db, {
      ...entry,
      ipAddress: (source === undefined ? null : getIP(source, ctx.context.options)) ?? undefined,
      userAgent: ctx.headers?.get("user-agent") ?? undefined,
    });
  });

  return betterAuth({
    appName: "Mashkif",
    secret: options.secret,
    ...(publicUrl === undefined ? {} : { baseURL: publicUrl }),
    basePath: AUTH_BASE_PATH,
    // Better Auth adds the public URL and BETTER_AUTH_TRUSTED_ORIGINS itself.
    trustedOrigins: () => options.trustedOrigins(),
    telemetry: { enabled: false },
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
      transaction: true,
    }),
    databaseHooks: {
      user: {
        create: {
          // Mashkif has one admin: sign-up works only while no user exists.
          // The one-row constraint on auth_user backs this up.
          before: async () => {
            const [row] = await db.select({ n: count() }).from(schema.user);
            return (row?.n ?? 0) === 0 ? undefined : false;
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await deliver(mailer, resetPasswordMessage(user.email, url), "password reset");
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await deliver(mailer, verifyEmailMessage(user.email, url), "email change");
      },
      afterEmailVerification: async (user) => {
        await writeAudit(db, { actor: actorOf(user as AdminUser), action: "email.changed" });
      },
    },
    user: { changeEmail: { enabled: true } },
    session: {
      expiresIn: options.sessionHours * 60 * 60,
      disableSessionRefresh: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "memory",
      customRules: {
        "/sign-in/username": SIGN_IN_RATE_LIMIT,
        "/two-factor/verify-totp": SIGN_IN_RATE_LIMIT,
        "/two-factor/verify-backup-code": SIGN_IN_RATE_LIMIT,
        "/request-password-reset": SIGN_IN_RATE_LIMIT,
      },
    },
    advanced: {
      // Explicit, so the origin check also runs under tests (Better Auth skips it there by default).
      disableOriginCheck: false,
      useSecureCookies: publicUrl?.startsWith("https://") ?? false,
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for"],
        trustedProxies: options.trustedProxies,
      },
    },
    hooks: { after: audit },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 30 }),
      twoFactor({ issuer: "Mashkif" }),
      passkey({
        rpName: "Mashkif",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
