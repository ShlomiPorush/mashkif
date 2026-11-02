import { sql } from "drizzle-orm";
import { writeAudit } from "./audit.js";
import type { Db } from "./db/client.js";
import { describeSafely } from "./errors.js";
import { readSettings } from "./settings.js";

/** Agents promoted per transaction. Each batch commits on its own. */
export const PROMOTION_BATCH_SIZE = 500;
/** Batches per run; a run that stops early continues an hour later. */
export const PROMOTION_MAX_BATCHES = 20;
export const PROMOTION_INTERVAL_MS = 60 * 60 * 1000;
/** The first run waits until the server has settled after a start. */
export const PROMOTION_FIRST_DELAY_MS = 60 * 1000;
/** A low agent is promoted only while it is reporting: a heartbeat in this window. */
export const PROMOTION_RECENT_MS = 24 * 60 * 60 * 1000;

export interface PromotionResult {
  promoted: number;
  /** False when the batch limit stopped the run before every due agent was promoted. */
  complete: boolean;
}

/**
 * Promotes low agents to normal (decision of 2026-11-03): an agent that is
 * not revoked, reported on at least the configured number of distinct UTC
 * days, and sent a heartbeat in the last 24 hours. Each batch locks its rows
 * with SKIP LOCKED, so two runs never promote one agent twice, and checks
 * the conditions on the locked row, so a revoke or a tier change by the
 * admin wins. Every promotion is audited with the actor "system" in the
 * same transaction.
 */
export async function runPromotion(
  db: Db,
  now = new Date(),
  batchSize = PROMOTION_BATCH_SIZE,
  maxBatches = PROMOTION_MAX_BATCHES,
): Promise<PromotionResult> {
  const { promotionDays } = await readSettings(db);
  const since = new Date(now.getTime() - PROMOTION_RECENT_MS);
  let promoted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const count = await db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        with picked as (
          select id from agent
          where trust_tier = 'low' and revoked_at is null
            and active_days >= ${promotionDays} and last_seen_at > ${since.toISOString()}::timestamptz
          order by id
          limit ${batchSize}
          for update skip locked
        )
        update agent set trust_tier = 'normal'
        from picked
        where agent.id = picked.id
        returning agent.id
      `);
      for (const row of rows) {
        await writeAudit(tx, {
          actor: "system",
          action: "agent.trust_tier_changed",
          details: { agentId: row.id, from: "low", to: "normal", reason: "probation_complete" },
        });
      }
      return rows.length;
    });
    promoted += count;
    if (count < batchSize) {
      return { promoted, complete: true };
    }
  }
  return { promoted, complete: false };
}

/**
 * Runs the promotion job a minute after start and then every hour, never
 * two runs at once in this process. Returns a function that stops it.
 */
export function schedulePromotion(
  db: Db,
  intervalMs = PROMOTION_INTERVAL_MS,
  firstDelayMs = PROMOTION_FIRST_DELAY_MS,
): () => void {
  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runPromotion(db);
      if (result.promoted > 0 || !result.complete) {
        console.log(
          `promotion: ${result.promoted} agents promoted from low to normal${result.complete ? "" : "; more remain for the next run"}`,
        );
      }
    } catch (error) {
      console.error(`promotion run failed: ${describeSafely(error)}`);
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
