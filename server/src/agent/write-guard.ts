import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agent, blockedRange } from "../db/schema.js";

// biome-ignore lint/suspicious/noExplicitAny: any Drizzle PostgreSQL database or transaction.
type Database = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Agent writes hold this advisory lock shared while they check the blocked
 * ranges; adding a range holds it exclusively. So a range that was added
 * and reported to the admin is seen by every later write, and a write under
 * way finishes before the range is added.
 */
const BLOCKLIST_LOCK = sql`hashtext('mashkif:blocklist')`;

export async function lockBlocklistShared(db: Database): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock_shared(${BLOCKLIST_LOCK})`);
}

export async function lockBlocklistExclusive(db: Database): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${BLOCKLIST_LOCK})`);
}

/** Whether a canonical address is in a blocked address or range. */
export async function addressBlocked(db: Database, address: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(blockedRange)
    .where(sql`${address}::inet <<= ${blockedRange.range}`)
    .limit(1);
  return rows.length > 0;
}

export type WriteRefusal = "agent_revoked" | "agent_blocked" | "address_blocked";

/**
 * Checks, inside a write transaction, that the agent may still write: it
 * locks the agent row (revoking an agent or changing its tier updates that
 * row, so either the change waits for this write or this write sees the
 * change) and then checks the blocked ranges under the shared lock. A
 * revoke or block that returned to the admin is never followed by a write.
 */
export async function guardAgentWrite(
  tx: Database,
  agentId: string,
  address: string,
): Promise<WriteRefusal | undefined> {
  const [row] = await tx
    .select({ revokedAt: agent.revokedAt, trustTier: agent.trustTier })
    .from(agent)
    .where(eq(agent.id, agentId))
    .for("update");
  if (row === undefined || row.revokedAt !== null) {
    return "agent_revoked";
  }
  if (row.trustTier === "blocked") {
    return "agent_blocked";
  }
  await lockBlocklistShared(tx);
  return (await addressBlocked(tx, address)) ? "address_blocked" : undefined;
}
