import { inArray, lt, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { agentEvent, heartbeat } from "./db/schema.js";
import { describeSafely } from "./errors.js";
import { readSettings } from "./settings.js";

/** Rows deleted per statement. Each batch commits on its own. */
export const RETENTION_BATCH_SIZE = 5_000;
/** Batches per table and run; a run that stops early continues an hour later. */
export const RETENTION_MAX_BATCHES = 200;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** The first run waits until the server has settled after a start. */
export const RETENTION_FIRST_DELAY_MS = 60 * 1000;

export interface RetentionResult {
  cutoff: Date;
  heartbeats: number;
  events: number;
  /** Agents deleted because they registered long ago and never sent a heartbeat. */
  agents: number;
  /** False when the batch limit stopped the run before everything old was gone. */
  complete: boolean;
}

/**
 * Deletes raw heartbeats and events received before the retention period
 * (an admin setting, at least 8 days). It deletes in batches that each
 * commit, so an interrupted run loses nothing and the next run continues.
 * Sync anchors and boot counters are not touched: anchors are bounded per
 * agent when a heartbeat creates one, and boot counters when one is added.
 * Outage summaries, which keep their own history, do not exist yet.
 */
export async function runRetention(
  db: Db,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
  maxBatches = RETENTION_MAX_BATCHES,
): Promise<RetentionResult> {
  const { retentionDays, agentCleanupDays } = await readSettings(db);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const agentCutoff = new Date(now.getTime() - agentCleanupDays * 24 * 60 * 60 * 1000);
  let complete = true;

  const purge = async (table: typeof heartbeat | typeof agentEvent): Promise<number> => {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const old = db
        .select({ id: table.id })
        .from(table)
        .where(lt(table.receivedAt, cutoff))
        .orderBy(table.id)
        .limit(batchSize);
      const deleted = await db
        .delete(table)
        .where(inArray(table.id, old))
        .returning({ id: table.id });
      total += deleted.length;
      if (deleted.length < batchSize) {
        return total;
      }
    }
    complete = false;
    return total;
  };

  const heartbeats = await purge(heartbeat);
  const events = await purge(agentEvent);

  // Agents that registered more than agentCleanupDays ago and never sent a
  // heartbeat, never revoked ones: a revoked row is what makes the server
  // answer agent_revoked to its token. The rows are locked (SKIP LOCKED) and
  // the conditions checked on the locked row, so a first heartbeat that
  // arrives at the same moment either wins or waits and then finds the agent
  // gone (401, and the agent registers again). The delete cascades to the
  // agent's anchors and counters.
  let agents = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = await db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        with picked as (
          select id from agent
          where revoked_at is null and last_seen_at is null and registered_at < ${agentCutoff.toISOString()}::timestamptz
          order by id
          limit ${batchSize}
          for update skip locked
        )
        delete from agent using picked where agent.id = picked.id returning agent.id
      `);
      return rows.length;
    });
    agents += deleted;
    if (deleted < batchSize) {
      break;
    }
    if (batch === maxBatches - 1) {
      complete = false;
    }
  }
  return { cutoff, heartbeats, events, agents, complete };
}

/**
 * Runs the retention job a minute after start and then every hour, never two
 * runs at once. Returns a function that stops the schedule.
 */
export function scheduleRetention(
  db: Db,
  intervalMs = RETENTION_INTERVAL_MS,
  firstDelayMs = RETENTION_FIRST_DELAY_MS,
): () => void {
  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runRetention(db);
      if (result.heartbeats > 0 || result.events > 0 || result.agents > 0 || !result.complete) {
        console.log(
          `retention: deleted ${result.heartbeats} heartbeats, ${result.events} events, and ${result.agents} agents that never reported; raw data received before ${result.cutoff.toISOString()}${result.complete ? "" : "; more remain for the next run"}`,
        );
      }
    } catch (error) {
      console.error(`retention run failed: ${describeSafely(error)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), firstDelayMs);
  const every = setInterval(() => void run(), intervalMs);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
