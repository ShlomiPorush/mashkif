import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { Db, Tx } from "../db/client.js";
import { account, adminSetupToken, user } from "../db/schema.js";

/** How long a setup token printed by the CLI stays valid. */
export const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
const USERNAME_PATTERN = /^[A-Za-z0-9_.]+$/;

/** Domain of the synthetic e-mail address Better Auth requires. It is never used for mail. */
export const ADMIN_EMAIL_DOMAIN = "admin.mashkif.invalid";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Serializes setup-token creation and admin creation across processes. */
async function lockSetup(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mashkif:admin-setup'))`);
}

async function adminExists(tx: Tx): Promise<boolean> {
  const [row] = await tx.select({ n: count() }).from(user);
  return (row?.n ?? 0) > 0;
}

export type SetupTokenResult = { ok: true; token: string; expiresAt: Date } | { ok: false };

/**
 * Creates a single-use setup token valid for 15 minutes, or refuses when an
 * admin exists. Earlier unused tokens stop working. Only the hash is stored.
 */
export async function createSetupToken(db: Db, now = new Date()): Promise<SetupTokenResult> {
  return db.transaction(async (tx) => {
    await lockSetup(tx);
    if (await adminExists(tx)) {
      return { ok: false };
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_MS);
    await tx.delete(adminSetupToken).where(isNull(adminSetupToken.usedAt));
    await tx.insert(adminSetupToken).values({
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt,
    });
    await writeAudit(tx, {
      actor: "cli",
      action: "admin.setup_token_created",
      details: { expiresAt: expiresAt.toISOString() },
    });
    return { ok: true, token, expiresAt };
  });
}

export interface SetupInput {
  token: string;
  username: string;
  password: string;
}

export type SetupInputError = "username_invalid" | "password_too_short" | "password_too_long";

/** Validates the setup form. Returns the problems found, empty when valid. */
export function validateSetupInput(input: SetupInput): SetupInputError[] {
  const problems: SetupInputError[] = [];
  const name = input.username;
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX || !USERNAME_PATTERN.test(name)) {
    problems.push("username_invalid");
  }
  if (input.password.length < PASSWORD_MIN) {
    problems.push("password_too_short");
  } else if (input.password.length > PASSWORD_MAX) {
    problems.push("password_too_long");
  }
  return problems;
}

export type SetupResult =
  | { ok: true; username: string }
  | { ok: false; error: "already_set_up" | "setup_token_invalid" };

export interface RequestInfo {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Creates the one admin in a single transaction: checks that no admin exists,
 * consumes a valid setup token, and inserts the user, its password, and the
 * audit entry. The unique singleton column refuses a second admin even if
 * two transactions got past the check at once.
 */
export async function completeSetup(
  db: Db,
  input: SetupInput,
  request: RequestInfo = {},
  now = new Date(),
): Promise<SetupResult> {
  // Hash outside the transaction: scrypt is slow and the lock is shared.
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    await lockSetup(tx);
    if (await adminExists(tx)) {
      return { ok: false, error: "already_set_up" };
    }
    const used = await tx
      .update(adminSetupToken)
      .set({ usedAt: now })
      .where(
        and(
          eq(adminSetupToken.tokenHash, hashToken(input.token)),
          isNull(adminSetupToken.usedAt),
          gt(adminSetupToken.expiresAt, now),
        ),
      )
      .returning({ id: adminSetupToken.id });
    if (used.length !== 1) {
      return { ok: false, error: "setup_token_invalid" };
    }
    const userId = randomUUID();
    const username = input.username.toLowerCase();
    await tx.insert(user).values({
      id: userId,
      name: input.username,
      email: `${username}@${ADMIN_EMAIL_DOMAIN}`,
      username,
      displayUsername: input.username,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(tx, {
      actor: username,
      action: "admin.created",
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });
    return { ok: true, username };
  });
}
