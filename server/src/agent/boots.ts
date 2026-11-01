import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agentBoot, syncAnchor } from "../db/schema.js";

// biome-ignore lint/suspicious/noExplicitAny: any Drizzle PostgreSQL database or transaction.
type Database = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Boots kept per agent, most recently active first. An agent that sends a
 * new boot ID on every request cannot grow its anchors and counts beyond
 * this; its most recent boot is never the one removed.
 */
export const MAX_BOOTS_PER_AGENT = 10;

/**
 * Records activity of a boot. When the boot is new, the agent's boots beyond
 * the MAX_BOOTS_PER_AGENT most recently active ones are deleted with their
 * anchors.
 */
export async function touchBoot(
  tx: Database,
  agentId: string,
  bootId: string,
  now: Date,
): Promise<void> {
  const [row] = await tx
    .insert(agentBoot)
    .values({ agentId, bootId, lastActivityAt: now })
    .onConflictDoUpdate({
      target: [agentBoot.agentId, agentBoot.bootId],
      set: {
        lastActivityAt: sql`greatest(${agentBoot.lastActivityAt}, excluded.last_activity_at)`,
      },
    })
    // xmax is 0 only for a row this statement inserted.
    .returning({ created: sql<boolean>`(xmax = 0)` });
  if (row?.created === true) {
    await tx.execute(sql`delete from ${agentBoot}
      where ${agentBoot.agentId} = ${agentId}
        and ${agentBoot.bootId} not in (
          select b.boot_id from ${agentBoot} b where b.agent_id = ${agentId}
          order by b.last_activity_at desc, b.boot_id limit ${MAX_BOOTS_PER_AGENT})`);
  }
}

/**
 * Records that the agent received these sync IDs: per boot, the newest of
 * them becomes the boot's confirmed anchor unless a newer one is confirmed
 * already. Retention keeps that anchor and every newer one of the boot.
 */
export async function confirmAnchors(
  tx: Database,
  agentId: string,
  syncIds: readonly string[],
): Promise<void> {
  if (syncIds.length === 0) {
    return;
  }
  const newest = await tx
    .select({ bootId: syncAnchor.bootId, id: sql<number>`max(${syncAnchor.id})`.mapWith(Number) })
    .from(syncAnchor)
    .where(and(eq(syncAnchor.agentId, agentId), inArray(syncAnchor.syncId, [...syncIds])))
    .groupBy(syncAnchor.bootId);
  for (const { bootId, id } of newest) {
    await tx
      .update(agentBoot)
      .set({ confirmedAnchorId: sql`greatest(coalesce(${agentBoot.confirmedAnchorId}, 0), ${id})` })
      .where(and(eq(agentBoot.agentId, agentId), eq(agentBoot.bootId, bootId)));
  }
}
