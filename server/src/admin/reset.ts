import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, isNull } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { Db, Tx } from "../db/client.js";
import {
  account,
  adminResetToken,
  passkey,
  session,
  twoFactor,
  user,
  verification,
} from "../db/schema.js";
import { lockAdminInTransaction } from "./lock.js";
import { hashToken, PASSWORD_MAX, PASSWORD_MIN, type RequestInfo } from "./setup.js";

/** How long a reset token printed by the CLI stays valid. */
export const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

export type ResetResult =
  | { ok: true; username: string; token: string; expiresAt: Date }
  | { ok: false };

export interface ResetOptions {
  /** Test seam: runs inside the transaction after every change, before commit. */
  beforeCommit?: (tx: Tx) => Promise<void>;
}

/**
 * Recovery for a lost password, authenticator, or passkey (`cli.js
 * reset-admin`). In one transaction: TOTP, passkeys, every session, and every
 * pending challenge deleted; the password replaced by the hash of a random
 * value that is never shown or kept, so no password works; a single-use reset
 * token valid for 15 minutes, stored hashed, replacing any unused one; an
 * audit entry. The token is returned only after the commit. No password is
 * ever printed: the admin sets a new one at /admin/reset with the token.
 */
export async function resetAdmin(db: Db, options: ResetOptions = {}): Promise<ResetResult> {
  const unusable = await hashPassword(randomBytes(32).toString("base64url"));
  const token = randomBytes(24).toString("base64url");
  const result = await db.transaction(async (tx) => {
    await lockAdminInTransaction(tx);
    const [admin] = await tx
      .select({ id: user.id, username: user.username, name: user.name })
      .from(user)
      .for("update");
    if (admin === undefined) {
      return undefined;
    }
    const now = new Date();
    const updated = await tx
      .update(account)
      .set({ password: unusable, updatedAt: now })
      .where(and(eq(account.userId, admin.id), eq(account.providerId, "credential")))
      .returning({ id: account.id });
    if (updated.length !== 1) {
      throw new Error("the admin has no password account");
    }
    await tx.delete(twoFactor).where(eq(twoFactor.userId, admin.id));
    await tx.delete(passkey).where(eq(passkey.userId, admin.id));
    await tx.delete(session).where(eq(session.userId, admin.id));
    // Pending TOTP sign-in steps and passkey challenges. With one admin,
    // every pending challenge belongs to it.
    await tx.delete(verification);
    await tx
      .update(user)
      .set({ twoFactorEnabled: false, updatedAt: now })
      .where(eq(user.id, admin.id));
    const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);
    await tx.delete(adminResetToken).where(isNull(adminResetToken.usedAt));
    await tx
      .insert(adminResetToken)
      .values({ tokenHash: hashToken(token), createdAt: now, expiresAt });
    const name = admin.username ?? admin.name;
    await writeAudit(tx, {
      actor: "cli",
      action: "admin.reset",
      details: { admin: name, tokenExpiresAt: expiresAt.toISOString() },
    });
    await options.beforeCommit?.(tx);
    return { username: name, expiresAt };
  });
  if (result === undefined) {
    return { ok: false };
  }
  return { ok: true, token, ...result };
}

export type ResetTokenError = "reset_token_invalid" | "reset_token_expired" | "reset_token_used";

export type CompleteResetResult = { ok: true } | { ok: false; error: ResetTokenError };

/** Validates the reset form. Returns the first problem, or undefined. */
export function validateResetInput(input: {
  token: string;
  password: string;
}): "reset_token_invalid" | "password_too_short" | "password_too_long" | undefined {
  if (input.token === "") {
    return "reset_token_invalid";
  }
  if (input.password.length < PASSWORD_MIN) {
    return "password_too_short";
  }
  if (input.password.length > PASSWORD_MAX) {
    return "password_too_long";
  }
  return undefined;
}

/**
 * Sets the new password with a reset token, in one transaction: the token is
 * consumed, the password replaced, every session of the admin deleted, and
 * the outcome audited. The token is looked up by its SHA-256 hash, so the
 * time a lookup takes says nothing about the token. Afterwards the admin
 * signs in with the new password and must enroll TOTP.
 */
export async function completeReset(
  db: Db,
  input: { token: string; password: string },
  request: RequestInfo = {},
  now = new Date(),
  // True when the caller holds the admin lock already (withAdminLock).
  lockHeld = false,
): Promise<CompleteResetResult> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    if (!lockHeld) {
      await lockAdminInTransaction(tx);
    }
    const [row] = await tx
      .select()
      .from(adminResetToken)
      .where(eq(adminResetToken.tokenHash, hashToken(input.token)))
      .for("update");
    let error: ResetTokenError | undefined;
    if (row === undefined) {
      error = "reset_token_invalid";
    } else if (row.usedAt !== null) {
      error = "reset_token_used";
    } else if (row.expiresAt.getTime() <= now.getTime()) {
      error = "reset_token_expired";
    }
    const [admin] = await tx.select({ id: user.id, username: user.username }).from(user);
    if (error !== undefined || row === undefined || admin === undefined) {
      await writeAudit(tx, {
        actor: "-",
        action: "admin.password_reset_failed",
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        details: { reason: error ?? "reset_token_invalid" },
      });
      return { ok: false, error: error ?? "reset_token_invalid" };
    }
    await tx.update(adminResetToken).set({ usedAt: now }).where(eq(adminResetToken.id, row.id));
    await tx
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(and(eq(account.userId, admin.id), eq(account.providerId, "credential")));
    await tx.delete(session).where(eq(session.userId, admin.id));
    await writeAudit(tx, {
      actor: admin.username ?? "-",
      action: "admin.password_reset",
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });
    return { ok: true };
  });
}
