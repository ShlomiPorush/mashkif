import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { agent, type TrustTier } from "../db/schema.js";
import { hashToken } from "../http/token-hash.js";
import type { RegisterRequest } from "./parse.js";
import { addressBlocked, lockBlocklistShared } from "./write-guard.js";

export type RegisterError =
  | "registration_closed"
  | "rate_limited"
  | "agent_revoked"
  | "address_blocked"
  | "install_id_conflict";

export type RegisterOutcome =
  | { ok: true; created: boolean; agentId: string }
  | { ok: false; error: RegisterError; retryAfter?: number };

export interface RegisterPolicy {
  /** The registration switch of the admin panel. */
  open: boolean;
  /** The tier a new agent starts at. */
  tier: TrustTier;
  /**
   * Counts one new registration against the per-site and the global limit;
   * returns the seconds to wait when one of them is used up. Runs only for a registration
   * that would create an agent, so a repeat of an existing agent never waits.
   */
  admit: () => Promise<number | undefined>;
}

export interface RegisterHooks {
  /** Runs after classification found no agent, before the insert, inside the transaction. */
  beforeInsert?: () => Promise<void>;
}

type Classification =
  | { kind: "match"; agentId: string }
  | { kind: "revoked" }
  | { kind: "conflict" }
  | { kind: "none" };

type Database = Db | Tx;

/**
 * Compares a registration with the committed agents. The token hash and the
 * install ID are each unique over all rows, revoked ones included, so any
 * existing row with either value decides the answer: both match and not
 * revoked is the same registration again, both match and revoked is a revoked
 * identity, and anything else is a conflict.
 */
async function classify(
  db: Database,
  installId: string,
  tokenHash: string,
): Promise<Classification> {
  const rows = await db
    .select({
      id: agent.id,
      installId: agent.installId,
      tokenHash: agent.tokenHash,
      revokedAt: agent.revokedAt,
    })
    .from(agent)
    .where(or(eq(agent.tokenHash, tokenHash), eq(agent.installId, installId)));
  if (rows.length === 0) {
    return { kind: "none" };
  }
  const [row] = rows;
  if (
    rows.length === 1 &&
    row !== undefined &&
    row.installId === installId &&
    row.tokenHash === tokenHash
  ) {
    return row.revokedAt === null ? { kind: "match", agentId: row.id } : { kind: "revoked" };
  }
  return { kind: "conflict" };
}

function answer(found: Exclude<Classification, { kind: "none" }>): RegisterOutcome {
  switch (found.kind) {
    case "match":
      return { ok: true, created: false, agentId: found.agentId };
    case "revoked":
      return { ok: false, error: "agent_revoked" };
    default:
      return { ok: false, error: "install_id_conflict" };
  }
}

/**
 * Open registration (decision of 2026-11-03). One transaction classifies the
 * request against the existing agents first, so the same registration
 * repeated (a lost answer, a crash) answers again with the same agent, also
 * while registration is closed or a creation limit is used up. Only a
 * request that matches no agent passes the switch and the per-site and global
 * limits and creates one. When a concurrent request inserted a conflicting row first, the
 * request is classified again against the committed rows: because no row is
 * ever deleted while it could conflict (revoked agents are kept), the
 * conflicting row is always found. No audit entry is written for a public
 * registration; the agent row records when it was created.
 */
export async function registerAgent(
  db: Db,
  input: RegisterRequest,
  ipAddress: string,
  now: Date,
  policy: RegisterPolicy,
  hooks: RegisterHooks = {},
): Promise<RegisterOutcome> {
  const tokenHash = hashToken(input.token);
  const first = await db.transaction(async (tx): Promise<RegisterOutcome | "conflict"> => {
    // Checked again under the shared blocklist lock, like agent writes.
    await lockBlocklistShared(tx);
    if (await addressBlocked(tx, ipAddress)) {
      return { ok: false, error: "address_blocked" };
    }
    const found = await classify(tx, input.installId, tokenHash);
    if (found.kind !== "none") {
      return answer(found);
    }
    if (!policy.open) {
      return { ok: false, error: "registration_closed" };
    }
    const wait = await policy.admit();
    if (wait !== undefined) {
      return { ok: false, error: "rate_limited", retryAfter: wait };
    }
    await hooks.beforeInsert?.();
    const agentId = randomUUID();
    const inserted = await tx
      .insert(agent)
      .values({
        id: agentId,
        installId: input.installId,
        tokenHash,
        trustTier: policy.tier,
        agentVersion: input.agentVersion,
        osVersion: input.osVersion ?? null,
        registeredAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: agent.id });
    return inserted.length === 1 ? { ok: true, created: true, agentId } : "conflict";
  });
  if (first !== "conflict") {
    return first;
  }
  // A concurrent registration committed a row with this install ID or token.
  const found = await classify(db, input.installId, tokenHash);
  if (found.kind === "none") {
    // Not reachable while conflicting rows are never deleted; fail safe.
    throw new Error("registration conflict without a conflicting agent");
  }
  return answer(found);
}
