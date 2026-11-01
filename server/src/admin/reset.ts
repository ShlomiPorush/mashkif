import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { Db, Tx } from "../db/client.js";
import { account, passkey, session, twoFactor, user, verification } from "../db/schema.js";

export type ResetResult = { ok: true; username: string; password: string } | { ok: false };

export interface ResetOptions {
  /** Test seam: runs inside the transaction after every change, before commit. */
  beforeCommit?: (tx: Tx) => Promise<void>;
}

/**
 * Recovery for a lost password, authenticator, or passkey. In one
 * transaction: a new random password; TOTP, passkeys, every session, and
 * every pending challenge deleted; an audit entry. Afterwards the only thing a
 * sign-in can do is enroll TOTP. The new password is returned only after the
 * commit, so an interrupted reset prints nothing and changes nothing.
 */
export async function resetAdmin(db: Db, options: ResetOptions = {}): Promise<ResetResult> {
  const password = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(password);
  const username = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mashkif:admin-setup'))`);
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
      .set({ password: passwordHash, updatedAt: now })
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
    const name = admin.username ?? admin.name;
    await writeAudit(tx, {
      actor: "cli",
      action: "admin.reset",
      details: { admin: name },
    });
    await options.beforeCommit?.(tx);
    return name;
  });
  if (username === undefined) {
    return { ok: false };
  }
  return { ok: true, username, password };
}
