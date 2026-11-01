import { inArray, lt, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { agentBoot, agentEvent, heartbeat, syncAnchor } from "./db/schema.js";
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
  anchors: number;
  boots: number;
  /** False when the batch limit stopped the run before everything old was gone. */
  complete: boolean;
}

/**
 * Deletes raw heartbeats and events received before the retention period
 * (an admin setting, at least 8 days); the boots, with their anchors and
 * dropped counts, that were last active before it, except each agent's most
 * recent boot (an event that refers to a deleted boot's sync is time
 * uncertain); and older anchors of the remaining boots, except the anchor
 * the agent last confirmed receiving in that boot and every newer one,
 * because the agent may still hold them: it can stay in one boot, offline,
 * longer than the retention period, and its newest response may have been
 * lost. A boot with no confirmed anchor keeps its newest one. It deletes in batches that each commit, so an
 * interrupted run loses nothing and the next run continues. Outage
 * summaries, which keep their own history, do not exist yet.
 */
export async function runRetention(
  db: Db,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
  maxBatches = RETENTION_MAX_BATCHES,
): Promise<RetentionResult> {
  const { retentionDays } = await readSettings(db);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
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

  const purgeAnchors = async (): Promise<number> => {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const deleted = await db
        .delete(syncAnchor)
        .where(
          inArray(
            syncAnchor.id,
            sql`(select a.id from ${syncAnchor} a
              join ${agentBoot} b on b.agent_id = a.agent_id and b.boot_id = a.boot_id
              where a.server_time < ${cutoff.toISOString()}::timestamptz
                and case when b.confirmed_anchor_id is null
                  then exists (select 1 from ${syncAnchor} n
                    where n.agent_id = a.agent_id and n.boot_id = a.boot_id and n.id > a.id)
                  else a.id < b.confirmed_anchor_id end
              order by a.id limit ${batchSize})`,
          ),
        )
        .returning({ id: syncAnchor.id });
      total += deleted.length;
      if (deleted.length < batchSize) {
        return total;
      }
    }
    complete = false;
    return total;
  };

  const purgeBoots = async (): Promise<number> => {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const deleted = await db.execute<{ agent_id: string }>(sql`delete from ${agentBoot}
        where (agent_id, boot_id) in (
          select b.agent_id, b.boot_id from ${agentBoot} b
          where b.last_activity_at < ${cutoff.toISOString()}::timestamptz
            and exists (select 1 from ${agentBoot} n
              where n.agent_id = b.agent_id and n.last_activity_at > b.last_activity_at)
          limit ${batchSize})
        returning agent_id`);
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
  const boots = await purgeBoots();
  const anchors = await purgeAnchors();
  return { cutoff, heartbeats, events, anchors, boots, complete };
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
      if (
        result.heartbeats + result.events + result.anchors + result.boots > 0 ||
        !result.complete
      ) {
        console.log(
          `retention: deleted ${result.heartbeats} heartbeats, ${result.events} events, ${result.boots} boots, and ${result.anchors} sync anchors from before ${result.cutoff.toISOString()}${result.complete ? "" : "; more remain for the next run"}`,
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
