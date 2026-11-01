import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "../admin/setup.js";
import { writeAudit } from "../audit.js";
import type { Db } from "../db/client.js";
import { agent, enrollmentKey } from "../db/schema.js";
import type { RegisterRequest } from "./parse.js";
import { addressBlocked, lockBlocklistShared } from "./write-guard.js";

export type RegisterError =
  | "enrollment_key_invalid"
  | "enrollment_key_expired"
  | "enrollment_key_revoked"
  | "enrollment_key_used"
  | "agent_revoked"
  | "address_blocked"
  | "install_id_conflict";

export type RegisterOutcome =
  | { ok: true; created: boolean; agentId: string }
  | { ok: false; error: RegisterError };

function uniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
  }
  return false;
}

export interface RegisterHooks {
  /** Runs after the key was used, before the agent exists, inside the transaction. */
  afterKeyUse?: () => Promise<void>;
}

/**
 * Uses a single-use enrollment key and creates the agent in one
 * transaction, so an interrupted registration leaves the key unused. A
 * repeat of a completed registration (same key, install ID, and token)
 * answers with the same agent, also after the key expired: the agent may
 * have lost the first answer. Two registrations racing for one key are
 * serialized by the key row's lock; the second sees the key used.
 */
export async function registerAgent(
  db: Db,
  input: RegisterRequest,
  ipAddress: string,
  now: Date,
  hooks: RegisterHooks = {},
): Promise<RegisterOutcome> {
  const keyHash = hashToken(input.enrollmentKey);
  const tokenHash = hashToken(input.token);
  try {
    return await db.transaction(async (tx): Promise<RegisterOutcome> => {
      // Checked again under the shared blocklist lock, like agent writes.
      await lockBlocklistShared(tx);
      if (await addressBlocked(tx, ipAddress)) {
        return { ok: false, error: "address_blocked" };
      }
      const [used] = await tx
        .update(enrollmentKey)
        .set({ usedAt: now })
        .where(
          and(
            eq(enrollmentKey.keyHash, keyHash),
            isNull(enrollmentKey.usedAt),
            isNull(enrollmentKey.revokedAt),
            gt(enrollmentKey.expiresAt, now),
          ),
        )
        .returning({ id: enrollmentKey.id, label: enrollmentKey.label });
      if (used !== undefined) {
        await hooks.afterKeyUse?.();
        const agentId = randomUUID();
        await tx.insert(agent).values({
          id: agentId,
          installId: input.installId,
          tokenHash,
          enrollmentKeyId: used.id,
          label: used.label,
          agentVersion: input.agentVersion,
          osVersion: input.osVersion ?? null,
          registeredAt: now,
        });
        await writeAudit(tx, {
          actor: "agent",
          action: "agent.registered",
          ipAddress,
          details: { agentId, enrollmentKeyId: used.id, agentVersion: input.agentVersion },
        });
        return { ok: true, created: true, agentId };
      }

      const [key] = await tx
        .select({
          id: enrollmentKey.id,
          usedAt: enrollmentKey.usedAt,
          revokedAt: enrollmentKey.revokedAt,
        })
        .from(enrollmentKey)
        .where(eq(enrollmentKey.keyHash, keyHash));
      if (key === undefined) {
        return { ok: false, error: "enrollment_key_invalid" };
      }
      if (key.usedAt !== null) {
        const [owner] = await tx
          .select({
            id: agent.id,
            installId: agent.installId,
            tokenHash: agent.tokenHash,
            revokedAt: agent.revokedAt,
          })
          .from(agent)
          .where(eq(agent.enrollmentKeyId, key.id));
        if (owner?.installId === input.installId && owner.tokenHash === tokenHash) {
          return owner.revokedAt === null
            ? { ok: true, created: false, agentId: owner.id }
            : { ok: false, error: "agent_revoked" };
        }
        return { ok: false, error: "enrollment_key_used" };
      }
      if (key.revokedAt !== null) {
        return { ok: false, error: "enrollment_key_revoked" };
      }
      return { ok: false, error: "enrollment_key_expired" };
    });
  } catch (error) {
    // The install ID or the token belongs to another agent: the transaction
    // rolled back, so the key stays unused.
    if (uniqueViolation(error)) {
      return { ok: false, error: "install_id_conflict" };
    }
    throw error;
  }
}
