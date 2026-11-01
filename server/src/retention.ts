import { inArray, lt } from "drizzle-orm";
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
  /** False when the batch limit stopped the run before everything old was gone. */
  complete: boolean;
}

/**
 * Deletes raw heartbeats and events received before the retention period
 * (an admin setting, at least 8 days, so the 7-day backfill window always
 * finds its syncs). It deletes in batches that each commit, so an
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

  const heartbeats = await purge(heartbeat);
  const events = await purge(agentEvent);
  return { cutoff, heartbeats, events, complete };
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
      if (result.heartbeats > 0 || result.events > 0 || !result.complete) {
        console.log(
          `retention: deleted ${result.heartbeats} heartbeats and ${result.events} events received before ${result.cutoff.toISOString()}${result.complete ? "" : "; more remain for the next run"}`,
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
