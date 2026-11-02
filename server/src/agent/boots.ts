import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agent, agentBoot, MAX_BOOTS_PER_AGENT } from "../db/schema.js";
import type { DroppedEvents } from "./parse.js";

// biome-ignore lint/suspicious/noExplicitAny: any Drizzle PostgreSQL database or transaction.
type Database = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Stores the cumulative dropped-events count of a boot, keeping the largest
 * one seen. A new boot row evicts the agent's oldest rows by creation
 * beyond MAX_BOOTS_PER_AGENT, never the agent's current boot (the boot of
 * its latest heartbeat). Runs under the agent row lock the write holds.
 */
export async function recordDroppedEvents(
  tx: Database,
  agentId: string,
  dropped: DroppedEvents,
  now: Date,
): Promise<void> {
  const [row] = await tx
    .insert(agentBoot)
    .values({ agentId, bootId: dropped.bootId, createdAt: now, droppedEvents: dropped.count })
    .onConflictDoUpdate({
      target: [agentBoot.agentId, agentBoot.bootId],
      set: { droppedEvents: sql`greatest(${agentBoot.droppedEvents}, excluded.dropped_events)` },
    })
    // xmax is 0 only for a row this statement inserted.
    .returning({ created: sql<boolean>`(xmax = 0)` });
  if (row?.created !== true) {
    return;
  }
  const [owner] = await tx
    .select({ currentBoot: agent.lastBootId })
    .from(agent)
    .where(eq(agent.id, agentId));
  const current = owner?.currentBoot ?? null;
  const currentKept = sql`(select count(*) from ${agentBoot} c
    where c.agent_id = ${agentId} and c.boot_id is not distinct from ${current}::uuid)`;
  await tx.delete(agentBoot).where(
    and(
      eq(agentBoot.agentId, agentId),
      sql`${agentBoot.bootId} is distinct from ${current}::uuid`,
      sql`${agentBoot.bootId} not in (
        select o.boot_id from ${agentBoot} o
        where o.agent_id = ${agentId} and o.boot_id is distinct from ${current}::uuid
        order by o.created_at desc, o.boot_id
        limit ${MAX_BOOTS_PER_AGENT} - ${currentKept})`,
    ),
  );
}
